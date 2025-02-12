export type HistoryItem = {
	id: string
	/** 历史记录的时间戳 timestamp */
	ts: number
	task: string
	tokensIn: number
	tokensOut: number
	cacheWrites?: number
	cacheReads?: number
	totalCost: number

	size?: number
	shadowGitConfigWorkTree?: string
	conversationHistoryDeletedRange?: [number, number]
}
