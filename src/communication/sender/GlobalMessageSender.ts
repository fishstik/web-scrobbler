import { browser } from 'webextension-polyfill-ts';

import { Message } from '@/communication/message/Message';
import { MessageSender } from '@/communication/MessageSender';

export class GlobalMessageSender implements MessageSender {
	async sendMessage<Data, Response>(
		message: Message<Data>
	): Promise<Response> {
		return (await browser.runtime.sendMessage(message)) as Response;
	}
}