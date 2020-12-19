export interface CustomUrlPatterns {
	getPatterns(connectorId: string): Promise<string[]>;
	setPatterns(connectorId: string, patterns: string[]): Promise<void>;
	deletePatterns(connectorId: string): Promise<void>;
}