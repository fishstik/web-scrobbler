/* eslint-disable @typescript-eslint/no-unused-vars */

import { ApiCallResult } from '@/background/scrobbler/api-call-result';
import { ConnectorEntry } from '@/common/connector-entry';
import { ControllerMode } from '@/background/object/controller-mode';
import {
	ParsedSongInfo,
	EditedSongInfo,
	ParsedSongField,
} from '@/background/object/song';
import { Pipeline } from '@/background/pipeline/pipeline';
import { SavedEdits } from '@/background/storage/saved-edits';
import { ScrobbleManager } from '@/background/scrobbler/scrobble-manager';
import { ScrobbleStorage } from '@/background/storage/scrobble-storage';
import { Song, LoveStatus } from '@/background/object/song';
import { Timer } from '@/background/object/timer';

import {
	areAllResults,
	debugLog,
	getSecondsToScrobble,
	isAnyResult,
	isStateEmpty,
	LogType,
} from '@/background/util/util';
import {
	getOption,
	SCROBBLE_PERCENT,
	SCROBBLE_PODCASTS,
} from '@/background/storage/options';

/**
 * List of song fields used to check if song is changed. If any of
 * these fields are changed, the new song is playing.
 */
const fieldsToCheckSongChange: ParsedSongField[] = [
	'artist',
	'track',
	'album',
	'uniqueID',
];

export enum ControllerEvent {
	Reset,
	SongNowPlaying,
	SongUnrecognized,
}

/**
 * Object that handles song playback and scrobbling actions.
 */
export class Controller {
	private mode: ControllerMode;
	private tabId: number;
	private connector: ConnectorEntry;

	private pipeline: Pipeline;
	private currentSong: Song;
	private playbackTimer: Timer;
	private replayDetectionTimer: Timer;

	private isReplayingSong = false;
	private isControllerEnabled: boolean;
	private shouldScrobblePodcasts: boolean;

	/**
	 * @constructor
	 * @param tabId Tab ID
	 * @param connector Connector match object
	 * @param isEnabled Flag indicates initial stage
	 */
	constructor(tabId: number, connector: ConnectorEntry, isEnabled: boolean) {
		this.tabId = tabId;
		this.connector = connector;
		this.isControllerEnabled = isEnabled;
		this.mode = isEnabled ? ControllerMode.Base : ControllerMode.Disabled;

		this.pipeline = new Pipeline();
		this.playbackTimer = new Timer();
		this.replayDetectionTimer = new Timer();

		this.currentSong = null;
		this.shouldScrobblePodcasts = getOption(SCROBBLE_PODCASTS);

		this.debugLog(`Created controller for ${connector.label} connector`);
	}

	/** Listeners. */

	/**
	 * Called if current song is updated.
	 */
	onSongUpdated(): void {
		throw new Error('This function must be overridden!');
	}

	/**
	 * Called if a controller mode is changed.
	 */

	onModeChanged(): void {
		throw new Error('This function must be overridden!');
	}

	/**
	 * Called if a new event is dispatched.
	 *
	 * @param event Event generated by the controller.
	 */
	onControllerEvent(event: ControllerEvent): void {
		throw new Error('This function must be overridden!');
	}

	/** Public functions */

	/**
	 * Switch the state of controller.
	 *
	 * @param flag True means enabled and vice versa
	 */
	setEnabled(flag: boolean): void {
		this.isControllerEnabled = flag;

		if (flag) {
			this.setMode(ControllerMode.Base);
		} else {
			this.resetState();
			this.setMode(ControllerMode.Disabled);
		}
	}

	/**
	 * Check if the controller is enabled.
	 *
	 * @return Check result
	 */
	isEnabled(): boolean {
		return this.isControllerEnabled;
	}

	/**
	 * Do finalization before unloading controller.
	 */
	finish(): void {
		this.debugLog(
			`Remove controller for ${this.connector.label} connector`
		);
		this.resetState();
	}

	/**
	 * Reset song data and process it again.
	 */
	async resetSongData(): Promise<void> {
		this.assertSongIsPlaying();

		this.currentSong.resetInfo();
		await SavedEdits.removeSongInfo(this.currentSong);

		this.unprocessSong();
		this.processSong();
	}

	/**
	 * Make the controller to ignore current song.
	 */
	skipCurrentSong(): void {
		this.assertSongIsPlaying();

		this.setMode(ControllerMode.Skipped);

		this.currentSong.flags.isSkipped = true;

		// this.playbackTimer.reset();
		// this.replayDetectionTimer.reset();

		this.onSongUpdated();
	}

	/**
	 * Get connector match object.
	 *
	 * @return Connector
	 */
	getConnector(): ConnectorEntry {
		return this.connector;
	}

	/**
	 * Get current song as plain object.
	 *
	 * @return Song copy
	 */
	getCurrentSong(): Song {
		return this.currentSong;
	}

	/**
	 * Get current controller mode.
	 *
	 * @return Controller mode
	 */
	getMode(): ControllerMode {
		return this.mode;
	}

	/**
	 * Return a tab ID where the controller is attached.
	 *
	 * @return Tab ID
	 */
	getTabId(): number {
		return this.tabId;
	}

	/**
	 * Sets data for current song from user input.
	 *
	 * @param data Object contains song data
	 */
	async setUserSongData(data: EditedSongInfo): Promise<void> {
		this.assertSongIsPlaying();

		if (this.currentSong.flags.isScrobbled) {
			throw new Error('Unable to set user data for scrobbled song');
		}

		await SavedEdits.saveSongInfo(this.currentSong, data);

		this.unprocessSong();
		this.processSong();
	}

	/**
	 * Send request to love or unlove current song.
	 *
	 * @param loveStatus Flag indicated song is loved
	 */
	async toggleLove(loveStatus: LoveStatus): Promise<void> {
		this.assertSongIsPlaying();

		if (!this.currentSong.isValid()) {
			throw new Error('No valid song is now playing');
		}

		await ScrobbleManager.toggleLove(
			this.currentSong.getInfo(),
			loveStatus
		);

		this.currentSong.setLoveStatus(loveStatus, { force: true });
		this.onSongUpdated();
	}

	/**
	 * Put a given connector state into the processing queue.
	 *
	 * @param state Connector state
	 */
	async processStateChange(state: ParsedSongInfo): Promise<void> {
		if (!this.isControllerEnabled) {
			return;
		}

		if (isStateEmpty(state)) {
			await this.processEmptyState(state);

			return;
		}

		const isSongChanged = this.isSongChanged(state);

		if (isSongChanged || this.isReplayingSong) {
			if (state.isPlaying) {
				if (this.isNeedToAddSongToScrobbleStorage()) {
					await this.addSongToScrobbleStorage();
				}

				this.processNewState(state);
				await this.processSong();
			} else {
				this.reset();
			}
		} else {
			this.processCurrentState(state);
		}
	}

	private async processEmptyState(state: ParsedSongInfo): Promise<void> {
		if (this.currentSong) {
			/*
			 * Empty state has same semantics as reset; even if isPlaying,
			 * we don't have enough data to use.
			 */

			this.debugLog('Received empty state - resetting');

			if (this.isNeedToAddSongToScrobbleStorage()) {
				await this.addSongToScrobbleStorage();
			}
			this.reset();
		}

		if (state.isPlaying) {
			this.debugLog(
				`State from connector doesn't contain enough information about the playing track: ${toString(
					state
				)}`,
				'warn'
			);
		}
	}

	/**
	 * Process connector state as new one.
	 *
	 * @param state Connector state
	 */
	private processNewState(state: ParsedSongInfo): void {
		/*
		 * We've hit a new song (or replaying the previous one)
		 * clear any previous song and its bindings.
		 */
		this.resetState();
		this.currentSong = new Song(state);
		this.currentSong.flags.isReplaying = this.isReplayingSong;

		this.debugLog(`New song detected: ${toString(state)}`);

		/*
		 * Start the timer, actual time will be set after processing
		 * is done; we can call doScrobble directly, because the timer
		 * will be allowed to trigger only after the song is validated.
		 */
		this.playbackTimer.start(() => {
			this.onPlaybackTimerExpired();
		});

		this.replayDetectionTimer.start(() => {
			this.onReplayTimerExpired();
		});
		this.isReplayingSong = false;

		/*
		 * If we just detected the track and it's not playing yet,
		 * pause the timer right away; this is important, because
		 * isPlaying flag binding only calls pause/resume which assumes
		 * the timer is started.
		 */
		if (!state.isPlaying) {
			this.playbackTimer.pause();
			this.replayDetectionTimer.pause();
		}
	}

	/**
	 * Process connector state as current one.
	 *
	 * @param newState Connector state
	 */
	private processCurrentState(newState: ParsedSongInfo): void {
		if (this.currentSong.flags.isSkipped) {
			return;
		}

		const { currentTime, isPlaying, trackArt, duration } = newState;
		const isPlayingStateChanged =
			this.currentSong.parsed.isPlaying !== isPlaying;

		this.currentSong.parsed.currentTime = currentTime;
		this.currentSong.parsed.isPlaying = isPlaying;
		this.currentSong.parsed.trackArt = trackArt;

		if (this.isNeedToUpdateDuration(newState)) {
			this.updateSongDuration(duration);
		}

		if (isPlayingStateChanged) {
			this.onPlayingStateChanged(isPlaying);
		}
	}

	/**
	 * Reset controller state.
	 */
	private resetState(): void {
		this.dispatchEvent(ControllerEvent.Reset);

		this.playbackTimer.reset();
		this.replayDetectionTimer.reset();

		this.currentSong = null;
	}

	/**
	 * Process song using pipeline module.
	 */
	private async processSong(): Promise<void> {
		this.setMode(ControllerMode.Loading);

		await this.pipeline.process(this.currentSong);

		this.debugLog(
			`Song finished processing: ${this.currentSong.toString()}`
		);

		if (this.currentSong.isValid()) {
			// Processing cleans this flag
			this.currentSong.flags.isMarkedAsPlaying = false;

			this.updateTimers(this.currentSong.getDuration());

			if (
				!this.shouldScrobblePodcasts &&
				this.currentSong.parsed.isPodcast
			) {
				this.skipCurrentSong();
				return;
			}

			/*
			 * If the song is playing, mark it immediately;
			 * otherwise will be flagged in isPlaying binding.
			 */
			if (this.currentSong.parsed.isPlaying) {
				/*
				 * If playback timer is expired, then the extension
				 * will scrobble song immediately, and there's no need
				 * to set song as now playing. We should dispatch
				 * a "now playing" event, though.
				 */
				if (!this.playbackTimer.isExpired()) {
					this.setSongNowPlaying();
				} else {
					this.dispatchEvent(ControllerEvent.SongNowPlaying);
				}
			} else {
				this.setMode(ControllerMode.Base);
			}
		} else {
			this.setSongNotRecognized();
		}

		this.onSongUpdated();
	}

	/**
	 * Called when song was already flagged as processed, but now is
	 * entering the pipeline again.
	 */
	private unprocessSong(): void {
		this.debugLog(`Song unprocessed: ${this.currentSong.toString()}`);
		this.debugLog('Clearing playback timer destination time');

		this.currentSong.resetData();

		this.playbackTimer.update(null);
		this.replayDetectionTimer.update(null);
	}

	/**
	 * Called when playing state is changed.
	 *
	 * @param value New playing state
	 */
	private onPlayingStateChanged(value: boolean): void {
		this.debugLog(`isPlaying state changed to ${value.toString()}`);

		if (value) {
			this.playbackTimer.resume();
			this.replayDetectionTimer.resume();

			const { isMarkedAsPlaying } = this.currentSong.flags;

			// Maybe the song was not marked as playing yet
			if (!isMarkedAsPlaying && this.currentSong.isValid()) {
				this.setSongNowPlaying();
			} else {
				// Resend current mode
				this.setMode(this.mode);
			}
		} else {
			this.playbackTimer.pause();
			this.replayDetectionTimer.pause();
		}
	}

	/**
	 * Check if song is changed by given connector state.
	 *
	 * @param newState Connector state
	 *
	 * @return Check result
	 */
	private isSongChanged(newState: ParsedSongInfo): boolean {
		if (!this.currentSong) {
			return true;
		}

		for (const field of fieldsToCheckSongChange) {
			if (newState[field] !== this.currentSong.parsed[field]) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Check if song duration should be updated.
	 *
	 * @param newState Connector state
	 *
	 * @return Check result
	 */
	private isNeedToUpdateDuration(newState: ParsedSongInfo): boolean {
		return (
			newState.duration &&
			this.currentSong.parsed.duration !== newState.duration
		);
	}

	/**
	 * Add current song to scrobble storage.
	 *
	 * @param scrobblerIds Array of scrobbler IDs
	 */
	private async addSongToScrobbleStorage(
		scrobblerIds?: string[]
	): Promise<void> {
		if (!scrobblerIds) {
			// eslint-disable-next-line no-param-reassign
			scrobblerIds = ScrobbleManager.getBoundScrobblers().map(
				(scrobbler) => scrobbler.getId()
			);
		}

		await ScrobbleStorage.addSong(this.currentSong.getInfo(), scrobblerIds);
	}

	/**
	 * Check if the current song should be saved to the scrobble storage.
	 *
	 * @return Check result
	 */
	private isNeedToAddSongToScrobbleStorage(): boolean {
		if (this.currentSong && !this.currentSong.isValid()) {
			const secondsToScrobble = this.getSecondsToScrobble(
				this.currentSong.getDuration()
			);
			if (secondsToScrobble !== -1) {
				return this.playbackTimer.getElapsed() >= secondsToScrobble;
			}
		}

		return false;
	}

	/**
	 * Update song duration value.
	 *
	 * @param duration Duration in seconds
	 */
	private updateSongDuration(duration: number): void {
		this.debugLog(`Update duration: ${duration}`);

		this.currentSong.parsed.duration = duration;

		if (this.currentSong.isValid()) {
			this.updateTimers(duration);
		}
	}

	/**
	 * Update internal timers.
	 *
	 * @param duration Song duration in seconds
	 */
	private updateTimers(duration: number): void {
		if (this.playbackTimer.isExpired()) {
			this.debugLog('Attempt to update expired timers', 'warn');
			return;
		}

		const secondsToScrobble = this.getSecondsToScrobble(duration);
		if (secondsToScrobble !== -1) {
			this.playbackTimer.update(secondsToScrobble);
			this.replayDetectionTimer.update(duration);

			const remainedSeconds = this.playbackTimer.getRemainingSeconds();
			this.debugLog(
				`The song will be scrobbled in ${remainedSeconds} seconds`
			);
			this.debugLog(`The song will be repeated in ${duration} seconds`);
		} else {
			this.debugLog('The song is too short to scrobble');
		}
	}

	private onPlaybackTimerExpired(): void {
		this.debugLog('Mark song as ready to scrobble');

		this.currentSong.flags.isReadyToScrobble = true;

		if (this.currentSong.flags.isSkipped) {
			return;
		}

		this.scrobbleSong();
	}

	private onReplayTimerExpired(): void {
		this.debugLog('Mark song as replaying');

		this.isReplayingSong = true;
	}

	/**
	 * Contains all actions to be done when song is ready to be marked as
	 * now playing.
	 */
	private async setSongNowPlaying(): Promise<void> {
		this.currentSong.flags.isMarkedAsPlaying = true;

		const results = await ScrobbleManager.sendNowPlaying(
			this.currentSong.getInfo()
		);
		if (isAnyResult(results, ApiCallResult.RESULT_OK)) {
			this.debugLog('Song set as now playing');
			this.setMode(ControllerMode.Playing);
		} else {
			this.debugLog("Song isn't set as now playing");
			this.setMode(ControllerMode.Err);
		}

		this.dispatchEvent(ControllerEvent.SongNowPlaying);
	}

	/**
	 * Notify user that song it not recognized by the extension.
	 */
	private setSongNotRecognized(): void {
		this.setMode(ControllerMode.Unknown);
		this.dispatchEvent(ControllerEvent.SongUnrecognized);
	}

	/**
	 * Called when scrobble timer triggers.
	 * The time should be set only after the song is validated and ready
	 * to be scrobbled.
	 */
	private async scrobbleSong(): Promise<void> {
		const results = await ScrobbleManager.scrobble(
			this.currentSong.getInfo()
		);
		const failedScrobblerIds = results
			.filter((result) => !result.is(ApiCallResult.RESULT_OK))
			.map((result) => result.getScrobblerId());

		const isAnyOkResult = results.length > failedScrobblerIds.length;
		if (isAnyOkResult) {
			this.debugLog('Scrobbled successfully');

			this.currentSong.flags.isScrobbled = true;
			this.setMode(ControllerMode.Scrobbled);

			this.onSongUpdated();
		} else if (areAllResults(results, ApiCallResult.RESULT_IGNORE)) {
			this.debugLog('Song is ignored by service');
			this.setMode(ControllerMode.Ignored);
		} else {
			this.debugLog('Scrobbling failed', 'warn');
			this.setMode(ControllerMode.Err);
		}

		if (failedScrobblerIds.length > 0) {
			this.addSongToScrobbleStorage(failedScrobblerIds);
		}
	}

	private getSecondsToScrobble(duration: number): number {
		const percent = getOption<number>(SCROBBLE_PERCENT);
		return getSecondsToScrobble(duration, percent);
	}

	private setMode(mode: ControllerMode): void {
		this.mode = mode;
		this.onModeChanged();
	}

	private dispatchEvent(event: ControllerEvent): void {
		this.onControllerEvent(event);
	}

	private reset(): void {
		this.resetState();
		this.setMode(ControllerMode.Base);
	}

	private assertSongIsPlaying(): void {
		if (!this.currentSong) {
			throw new Error('No song is now playing');
		}
	}

	/**
	 * Print debug message with prefixed tab ID.
	 *
	 * @param text Debug message
	 * @param [logType=log] Log type
	 */
	debugLog(text: string, logType: LogType = 'log'): void {
		const message = `Tab ${this.tabId}: ${text}`;
		debugLog(message, logType);
	}
}

/**
 * Get string representation of given object.
 *
 * @param obj Any object
 *
 * @return String value
 */
function toString(obj: unknown): string {
	return JSON.stringify(obj, null, 2);
}
