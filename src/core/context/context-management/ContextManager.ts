import { getContextWindowInfo } from "./context-window-utils"
import { formatResponse } from "@core/prompts/responses"
import { GlobalFileNames } from "@core/storage/disk"
import { fileExistsAtPath } from "@utils/fs"
import * as path from "path"
import fs from "fs/promises"
import cloneDeep from "clone-deep"
import { ClineApiReqInfo, ClineMessage } from "@shared/ExtensionMessage"
import { ApiHandler } from "@api/index"
import { Anthropic } from "@anthropic-ai/sdk"

enum EditType {
	UNDEFINED = 0,
	NO_FILE_READ = 1,
	READ_FILE_TOOL = 2,
	ALTER_FILE_TOOL = 3,
	FILE_MENTION = 4,
}

// array of string values allows us to cover all changes for message types currently supported
type MessageContent = string[]
type MessageMetadata = string[][]

// Type for a single context update
/** 含义: [timestamp, updateType, update, metadata] */
type ContextUpdate = [number, string, MessageContent, MessageMetadata] // [timestamp, updateType, update, metadata]

// Type for the serialized format of our nested maps
type SerializedContextHistory = Array<
	[
		number, // messageIndex
		[
			number, // EditType (message type)
			Array<
				[
					number, // blockIndex
					ContextUpdate[], // updates array (now with 4 elements including metadata)
				]
			>,
		],
	]
>

/**
 * v3.10 Cline 引入了对上下文窗口管理的改进
 */
export class ContextManager {
	// mapping from the apiMessages outer index to the inner message index to a list of actual changes, ordered by timestamp
	// timestamp is required in order to support full checkpointing, where the changes we apply need to be able to be undone when
	// moving to an earlier conversation history checkpoint - this ordering intuitively allows for binary search on truncation
	// there is also a number stored for each (EditType) which defines which message type it is, for custom handling

	// format:  { outerIndex => [EditType, { innerIndex => [[timestamp, updateType, update], ...] }] }
	// example: { 1 => { [0, 0 => [[<timestamp>, "text", "[NOTE] Some previous conversation history with the user has been removed ..."], ...] }] }
	// the above example would be how we update the first assistant message to indicate we truncated text
	/**
	 * 格式：< outerIndex（API 消息在“API 对话历史文件”中的索引） => [EditType, < innerIndex/blockIndex（消息内部的块坐标） => [ContextUpdate（上下文优化记录）, ...] > ] >
	 *
	 * 其中 ContextUpdate 按照第 0 元素（时间戳）排序
	 * 1. 在需要回溯到较早的会话历史检查点时，通过时间戳可以知道更改发生的顺序，从而能够正确地撤销（undo）这些更改。
	 * 2. 这使得在截断时可以使用二分查找来快速定位需要撤销的更改。
	 */
	private contextHistoryUpdates: Map<number, [number, Map<number, ContextUpdate[]>]>

	constructor() {
		this.contextHistoryUpdates = new Map()
	}

	/**
	 * public function for loading contextHistoryUpdates from disk, if it exists
	 */
	async initializeContextHistory(taskDirectory: string) {
		this.contextHistoryUpdates = await this.getSavedContextHistory(taskDirectory)
	}

	/**
	 * get the stored context history updates from disk
	 *
	 * 读取当前任务目录下的 context_history.json
	 */
	private async getSavedContextHistory(taskDirectory: string): Promise<Map<number, [number, Map<number, ContextUpdate[]>]>> {
		try {
			const filePath = path.join(taskDirectory, GlobalFileNames.contextHistory)
			if (await fileExistsAtPath(filePath)) {
				const data = await fs.readFile(filePath, "utf8")
				const serializedUpdates = JSON.parse(data) as SerializedContextHistory

				// Update to properly reconstruct the tuple structure
				return new Map(
					serializedUpdates.map(([messageIndex, [numberValue, innerMapArray]]) => [
						messageIndex,
						[numberValue, new Map(innerMapArray)],
					]),
				)
			}
		} catch (error) {
			console.error("Failed to load context history:", error)
		}
		return new Map()
	}

	/**
	 * save the context history updates to disk
	 *
	 * 把 this.contextHistoryUpdates 保存到 当前任务目录下的 context_history.json
	 */
	private async saveContextHistory(taskDirectory: string) {
		try {
			const serializedUpdates: SerializedContextHistory = Array.from(this.contextHistoryUpdates.entries()).map(
				([messageIndex, [numberValue, innerMap]]) => [messageIndex, [numberValue, Array.from(innerMap.entries())]],
			)

			await fs.writeFile(
				path.join(taskDirectory, GlobalFileNames.contextHistory),
				JSON.stringify(serializedUpdates),
				"utf8",
			)
		} catch (error) {
			console.error("Failed to save context history:", error)
		}
	}

	/**
	 * primary entry point for getting up to date context & truncating when required
	 *
	 * 如果之前的 API 请求的 token 使用量接近上下文窗口的最大值，则截断 LLM API 对话历史记录，为新请求腾出空间。
	 * @param apiConversationHistory - LLM API 对话历史记录
	 * @param clineMessages - Cline Message 数组
	 * @param conversationHistoryDeletedRange - 已有的 API 对话删除范围
	 * @param previousApiReqIndex - 上一个 api_req_started 在 ClineMessage 数组中的索引
	 */
	async getNewContextMessagesAndMetadata(
		apiConversationHistory: Anthropic.Messages.MessageParam[],
		clineMessages: ClineMessage[],
		api: ApiHandler,
		conversationHistoryDeletedRange: [number, number] | undefined,
		previousApiReqIndex: number,
		taskDirectory: string,
	) {
		let updatedConversationHistoryDeletedRange = false

		// If the previous API request's total token usage is close to the context window, truncate the conversation history to free up space for the new request
		if (previousApiReqIndex >= 0) {
			// 5-1. 如果 previousApiReqIndex 大于或等于 0，则获取上一个请求的信息。通过解析 clineMessages 中的历史记录，计算出 tokensIn、tokensOut、cacheWrites 和 cacheReads 的总和。
			const previousRequest = clineMessages[previousApiReqIndex]
			if (previousRequest && previousRequest.text) {
				const timestamp = previousRequest.ts
				const { tokensIn, tokensOut, cacheWrites, cacheReads }: ClineApiReqInfo = JSON.parse(previousRequest.text)
				const totalTokens = (tokensIn || 0) + (tokensOut || 0) + (cacheWrites || 0) + (cacheReads || 0)
				// 5-2. 根据不同的模型（如 DeepSeek、Claude）的 contextWindow，计算出最大允许的 token 数量。
				const { maxAllowedSize } = getContextWindowInfo(api)

				// This is the most reliable way to know when we're close to hitting the context window.
				// 5-3. 如果当前 token 数量超过了上下文窗口的最大值，则选择保留对话的一部分（1/4 或 1/2），并更新 `conversationHistoryDeletedRange` 来保存已删除的历史记录。
				if (totalTokens >= maxAllowedSize) {
					// Since the user may switch between models with different context windows, truncating half may not be enough (ie if switching from claude 200k to deepseek 64k, half truncation will only remove 100k tokens, but we need to remove much more)
					// So if totalTokens/2 is greater than maxAllowedSize, we truncate 3/4 instead of 1/2
					const keep = totalTokens / 2 > maxAllowedSize ? "quarter" : "half"

					// we later check how many chars we trim to determine if we should still truncate history
					// NOTE: v3.10 Cline 引入了对上下文窗口管理的改进 
					// 在进行裁剪之前，先应用上下文优化，删除 API 对话中冗余的内容
					let [anyContextUpdates, uniqueFileReadIndices] = this.applyContextOptimizations(
						apiConversationHistory,
						conversationHistoryDeletedRange ? conversationHistoryDeletedRange[1] + 1 : 2,
						timestamp,
					)

					// NOTE: 如果进行上下文简化后，API 消息的字符节省率超过 30%，则不需要进行裁剪
					let needToTruncate = true
					if (anyContextUpdates) {
						// determine whether we've saved enough chars to not truncate
						const charactersSavedPercentage = this.calculateContextOptimizationMetrics(
							apiConversationHistory,
							conversationHistoryDeletedRange,
							uniqueFileReadIndices,
						)
						if (charactersSavedPercentage >= 0.3) {
							needToTruncate = false
						}
					}

					// NOTE: 值得注意的是，如果没有进行裁剪，conversationHistoryDeletedRange 是不会更新的，因此在后面的 getAndAlterTruncatedMessages() 中也不会“删除”更多的消息
					if (needToTruncate) {
						// go ahead with truncation
						anyContextUpdates = this.applyStandardContextTruncationNoticeChange(timestamp) || anyContextUpdates

						// NOTE: it's okay that we overwriteConversationHistory in resume task since we're only ever removing the last user message and not anything in the middle which would affect this range
						conversationHistoryDeletedRange = this.getNextTruncationRange(
							apiConversationHistory,
							conversationHistoryDeletedRange,
							keep,
						)

						updatedConversationHistoryDeletedRange = true
					}

					// if we alter the context history, save the updated version to disk
					if (anyContextUpdates) {
						await this.saveContextHistory(taskDirectory)
					}
				}
			}
		}

		const truncatedConversationHistory = this.getAndAlterTruncatedMessages(
			apiConversationHistory,
			conversationHistoryDeletedRange,
		)

		return {
			conversationHistoryDeletedRange: conversationHistoryDeletedRange,
			updatedConversationHistoryDeletedRange: updatedConversationHistoryDeletedRange,
			truncatedConversationHistory: truncatedConversationHistory,
		}
	}

	/**
	 * get truncation range
	 *
	 * 【主线】根据已经删除的消息范围，计算当前需要删除的消息范围 并返回
	 * 1. 始终保留“第一对 user-assistant 信息”（user 是任务信息，唯一包含 <task> 标签的地方；assistant 是第一次回答）
	 * 2. （基于上一次删除的索引范围）删除剩余对话信息的 1/2 或 3/4，且删除的是 比较老 的消息
	 * 3. 保证删除的最后一条信息 "role" 为 assistant，以保持 Anthropic 所要求的 user-assistant-user-assistant 结构
	 */
	public getNextTruncationRange(
		apiMessages: Anthropic.Messages.MessageParam[],
		currentDeletedRange: [number, number] | undefined,
		keep: "half" | "quarter",
	): [number, number] {
		// We always keep the first user-assistant pairing, and truncate an even number of messages from there
		const rangeStartIndex = 2 // index 0 and 1 are kept
		const startOfRest = currentDeletedRange ? currentDeletedRange[1] + 1 : 2 // inclusive starting index

		let messagesToRemove: number
		if (keep === "half") {
			// Remove half of remaining user-assistant pairs
			// We first calculate half of the messages then divide by 2 to get the number of pairs.
			// After flooring, we multiply by 2 to get the number of messages.
			// Note that this will also always be an even number.
			messagesToRemove = Math.floor((apiMessages.length - startOfRest) / 4) * 2 // Keep even number
		} else {
			// Remove 3/4 of remaining user-assistant pairs
			// We calculate 3/4ths of the messages then divide by 2 to get the number of pairs.
			// After flooring, we multiply by 2 to get the number of messages.
			// Note that this will also always be an even number.
			messagesToRemove = Math.floor(((apiMessages.length - startOfRest) * 3) / 4 / 2) * 2
		}

		let rangeEndIndex = startOfRest + messagesToRemove - 1 // inclusive ending index

		// Make sure that the last message being removed is a assistant message, so the next message after the initial user-assistant pair is an assistant message. This preserves the user-assistant-user-assistant structure.
		// NOTE: anthropic format messages are always user-assistant-user-assistant, while openai format messages can have multiple user messages in a row (we use anthropic format throughout cline)
		if (apiMessages[rangeEndIndex].role !== "assistant") {
			rangeEndIndex -= 1
		}

		// this is an inclusive range that will be removed from the conversation history
		return [rangeStartIndex, rangeEndIndex]
	}

	/**
	 * external interface to support old calls
	 *
	 * 【旧接口】根据删除范围构造截断后的消息数组。
	 * 是 `getAndAlterTruncatedMessages` 的套壳函数，主要是为了支持旧的调用方式
	 */
	public getTruncatedMessages(
		messages: Anthropic.Messages.MessageParam[],
		deletedRange: [number, number] | undefined,
	): Anthropic.Messages.MessageParam[] {
		return this.getAndAlterTruncatedMessages(messages, deletedRange)
	}

	/**
	 * apply all required truncation methods to the messages in context
	 *
	 * 根据删除范围构造截断后的 API 消息数组（并对 API 消息内容进行简化）。是 `applyContextHistoryUpdates` 的唯一调用的地方
	 */
	private getAndAlterTruncatedMessages(
		messages: Anthropic.Messages.MessageParam[],
		deletedRange: [number, number] | undefined,
	): Anthropic.Messages.MessageParam[] {
		if (messages.length <= 1) {
			return messages
		}

		// 因为老接口中每次 start 都没有变【之前都是1，现在都是2】，这里就只用了 end + 1
		const updatedMessages = this.applyContextHistoryUpdates(messages, deletedRange ? deletedRange[1] + 1 : 2)

		// OLD NOTE: if you try to console log these, don't forget that logging a reference to an array may not provide the same result as logging a slice() snapshot of that array at that exact moment. The following DOES in fact include the latest assistant message.
		return updatedMessages
	}

	/**
	 * applies deletedRange truncation and other alterations based on changes in this.contextHistoryUpdates
	 *
	 * 1. 根据删除范围截断消息数组
	 * 	 - 如果在前面的逻辑中 删除范围没有更新，这里就不会“删除”新的消息）
	 * 2. 遍历剩余的消息，依据优化记录，**完成对 API 消息内容的简化**
	 * 	 - 根据 this.contextHistoryUpdates 这个简化记录
	 */
	private applyContextHistoryUpdates(
		messages: Anthropic.Messages.MessageParam[],
		startFromIndex: number,
	): Anthropic.Messages.MessageParam[] {
		// runtime is linear in length of user messages, if expecting a limited number of alterations, could be more optimal to loop over alterations

		// 1. 这三行就是老接口的逻辑，“删除”一部分 LLM API 对话历史记录
		//  如果在前面的逻辑中 删除范围没有更新，这里就不会“删除”新的消息
		const firstChunk = messages.slice(0, 2) // get first user-assistant pair
		const secondChunk = messages.slice(startFromIndex) // get remaining messages within context
		const messagesToUpdate = [...firstChunk, ...secondChunk]

		// we need the mapping from the local indices in messagesToUpdate to the global array of updates in this.contextHistoryUpdates
		// NOTE: 构建在 “API 对话历史文件” 中的原始坐标数组：[0, 1, startFromIndex, startFromIndex + 1, ...]
		const originalIndices = [
			...Array(2).keys(),
			...Array(secondChunk.length)
				.fill(0)
				.map((_, i) => i + startFromIndex),
		]

		for (let arrayIndex = 0; arrayIndex < messagesToUpdate.length; arrayIndex++) {
			const messageIndex = originalIndices[arrayIndex]

			const innerTuple = this.contextHistoryUpdates.get(messageIndex)
			if (!innerTuple) {
				continue
			}

			// because we are altering this, we need a deep copy
			// 【吐槽】修改某条消息之前，确保它是完全独立的一份拷贝，防止影响原始数据或触发不希望的引用联动。
			// 可能是因为 messagesToUpdate[arrayIndex] 是一个对象数组？
			messagesToUpdate[arrayIndex] = cloneDeep(messagesToUpdate[arrayIndex])

			// Extract the map from the tuple
			// 2. 依据 this.contextHistoryUpdates 这个优化记录，真正完成对 API 消息内容的简化
			const innerMap = innerTuple[1]
			for (const [blockIndex, changes] of innerMap) {
				// apply the latest change among n changes - [timestamp, updateType, update]
				const latestChange = changes[changes.length - 1]

				if (latestChange[1] === "text") {
					// only altering text for now
					const message = messagesToUpdate[arrayIndex]

					if (Array.isArray(message.content)) {
						const block = message.content[blockIndex]
						if (block && block.type === "text") {
							block.text = latestChange[2][0]
						}
					}
				}
			}
		}

		return messagesToUpdate
	}

	/**
	 * removes all context history updates that occurred after the specified timestamp and saves to disk
	 */
	async truncateContextHistory(timestamp: number, taskDirectory: string): Promise<void> {
		this.truncateContextHistoryAtTimestamp(this.contextHistoryUpdates, timestamp)

		// save the modified context history to disk
		await this.saveContextHistory(taskDirectory)
	}

	/**
	 * alters the context history to remove all alterations after a given timestamp
	 * removes the index if there are no alterations there anymore, both outer and inner indices
	 */
	private truncateContextHistoryAtTimestamp(
		contextHistory: Map<number, [number, Map<number, ContextUpdate[]>]>,
		timestamp: number,
	): void {
		for (const [messageIndex, [_, innerMap]] of contextHistory) {
			// track which blockIndices to delete
			const blockIndicesToDelete: number[] = []

			// loop over the innerIndices of the messages in this block
			for (const [blockIndex, updates] of innerMap) {
				// updates ordered by timestamp, so find cutoff point by iterating from right to left
				let cutoffIndex = updates.length - 1
				while (cutoffIndex >= 0 && updates[cutoffIndex][0] > timestamp) {
					cutoffIndex--
				}

				// If we found updates to remove
				if (cutoffIndex < updates.length - 1) {
					// Modify the array in place to keep only updates up to cutoffIndex
					updates.length = cutoffIndex + 1

					// If no updates left after truncation, mark this block for deletion
					if (updates.length === 0) {
						blockIndicesToDelete.push(blockIndex)
					}
				}
			}

			// Remove empty blocks from inner map
			for (const blockIndex of blockIndicesToDelete) {
				innerMap.delete(blockIndex)
			}

			// If inner map is now empty, remove the message index from outer map
			if (innerMap.size === 0) {
				contextHistory.delete(messageIndex)
			}
		}
	}

	/**
	 * applies the context optimization steps and returns whether any changes were made
	 *
	 * 优化对上下文窗口的管理：
	 *
	 * `v3.10` 优化 API 对话历史的内容（这个函数本身 并未真的改变了 API 消息的内容，只是生成了一份优化记录，实际修改在 `applyContextHistoryUpdates()`）
	 *  - 解决的问题 → 不同的工具调用 或者 mentions "@" 可能会读取同一个文件的内容，造成冗余。
	 *  - 解决方案 → 把重复涉及的文件内容替换为 简短的提示信息，只保留文件的最新版本。
	 * @returns [boolean, Set<number>] - 是否发生了简化，此次简化的消息 在 “API 对话历史文件” 中的索引集合
	 * @param apiMessages - LLM API 对话历史记录
	 * @param startFromIndex - （除了固定保留的第一对消息）剩余消息在 “API 对话历史文件” 中起始坐标
	 * @param timestamp - 上一个 api_req_started 的 ClineMessage 的时间戳
	 */
	private applyContextOptimizations(
		apiMessages: Anthropic.Messages.MessageParam[],
		startFromIndex: number,
		timestamp: number,
	): [boolean, Set<number>] {
		const [fileReadUpdatesBool, uniqueFileReadIndices] = this.findAndPotentiallySaveFileReadContextHistoryUpdates(
			apiMessages,
			startFromIndex,
			timestamp,
		)

		// true if any context optimization steps alter state
		const contextHistoryUpdated = fileReadUpdatesBool

		return [contextHistoryUpdated, uniqueFileReadIndices]
	}

	/**
	 * if there is any truncation and there is no other alteration already set, alter the assistant message to indicate this occurred
	 *
	 * LLM 的第一次回复 即 “API 对话历史文件” 中 index=1 的消息。
	 * 如果 this.contextHistoryUpdates 中没有这条消息的修改记录，说明此时是第一次对 API 对话历史 进行截断
	 * 此时添加对 这条消息 的修改记录，表示 当前任务 发生了对话消息的截断，提示模型注意
	 */
	private applyStandardContextTruncationNoticeChange(timestamp: number): boolean {
		if (!this.contextHistoryUpdates.has(1)) {
			// first assistant message always at index 1
			const innerMap = new Map<number, ContextUpdate[]>()
			innerMap.set(0, [[timestamp, "text", [formatResponse.contextTruncationNotice()], []]])
			this.contextHistoryUpdates.set(1, [0, innerMap]) // EditType is undefined for first assistant message
			return true
		}
		return false
	}

	/**
	 * wraps the logic for determining file reads to overwrite, and altering state
	 * returns whether any updates were made (bool) and indices where updates were made
	 *
	 * 【吐槽】为什么不把这个函数中的逻辑直接放在 `applyContextOptimizations` 中？单独抽取中这么长名字的函数意义何在？ 
	 * 1. 从当前 LLM API 对话历史消息中 分析是否存在冗余的文件读取（工具调用 或者 mentions "@"），并返回两个映射表： 需要进行的修改记录 fileReadIndices 和 该消息因"@"引入的文件名数组 messageFilePaths
	 * 2. 基于 fileReadIndices 中的修改记录信息，在 this.contextHistoryUpdates 中添加优化记录
	 * @returns [boolean, Set<number>] - 是否发生了简化，此次简化的消息 在 “API 对话历史文件” 中的索引集合
	 * @param apiMessages - LLM API 对话历史记录
	 * @param startFromIndex - （除了固定保留的第一对消息）剩余消息在 “API 对话历史文件” 中起始坐标
	 * @param timestamp - 上一个 api_req_started 的 ClineMessage 的时间戳
	 */
	private findAndPotentiallySaveFileReadContextHistoryUpdates(
		apiMessages: Anthropic.Messages.MessageParam[],
		startFromIndex: number,
		timestamp: number,
	): [boolean, Set<number>] {
		const [fileReadIndices, messageFilePaths] = this.getPossibleDuplicateFileReads(apiMessages, startFromIndex)
		return this.applyFileReadContextHistoryUpdates(fileReadIndices, messageFilePaths, apiMessages, timestamp)
	}

	/**
	 * generate a mapping from unique file reads from multiple tool calls to their outer index position(s)
	 * also return additional metadata to support multiple file reads in file mention text blocks
	 *
	 * 从当前 LLM API 对话历史消息中 分析是否存在冗余的文件读取（工具调用 或者 mentions "@"），并返回两个映射表，用于记录：
	 * 1. fileReadIndices: 消息中的 工具调用 或者 mentions "@" 涉及的“文件读取”需要进行的修改记录
	 * 2. messageFilePaths: 消息中的 mentions "@" 引入的文件 < API 消息索引 => 该消息因"@"引入的文件名数组 >
	 * @param apiMessages - LLM API 对话历史记录
	 * @param startFromIndex - （除了固定保留的第一对消息）剩余消息在 “API 对话历史文件” 中起始坐标
	 */
	private getPossibleDuplicateFileReads(
		apiMessages: Anthropic.Messages.MessageParam[],
		startFromIndex: number,
	): [Map<string, [number, number, string, string][]>, Map<number, string[]>] {
		// fileReadIndices: { fileName => [outerIndex, EditType, searchText, replaceText] }
		// messageFilePaths: { outerIndex => [fileRead1, fileRead2, ..] }
		// searchText in fileReadIndices is only required for file mention file-reads since there can be more than one file in the text
		// searchText will be the empty string "" in the case that it's not required, for non-file mentions
		// messageFilePaths is only used for file mentions as there can be multiple files read in the same text chunk

		// for all text blocks per file, has info for updating the block
		/** 消息中的 工具调用 或者 mentions "@" 涉及的“文件读取”需要进行的修改记录 */
		const fileReadIndices = new Map<string, [number, number, string, string][]>()

		// for file mention text blocks, track all the unique files read
		/** 消息中的 mentions "@" 引入的文件 < API 消息索引 => 该消息因"@"引入文件名数组 > */
		const messageFilePaths = new Map<number, string[]>()

		// 1. 遍历当前 LLM API 对话历史消息（可能经过了若干次删除）
		for (let i = startFromIndex; i < apiMessages.length; i++) {
			/** 记录当前消息中 已经处理的因 "@" 引入的文件名数组 */
			let thisExistingFileReads: string[] = []

			// 2. 判断当前消息因 mentions "@" 涉及的文件 是否已经简化完毕
			if (this.contextHistoryUpdates.has(i)) {
				const innerTuple = this.contextHistoryUpdates.get(i)

				if (innerTuple) {
					// safety check
					const editType = innerTuple[0]

					// 2-1. 如果是 FILE_MENTION 类型（即通过 mentions "@" 引入）
					if (editType === EditType.FILE_MENTION) {
						// innerMap 格式为：< innerIndex（消息内部的块坐标）=> [ContextUpdate, ...]
						const innerMap = innerTuple[1]

						// 【存疑】事实上如果用户在第一轮提问中用了 "@"，那么文件的内容会以 <file_content> 的形式直接包含在第 0 个文本块中
						// 而如果是 在对话过程中，以 Cline 提问+用户回答的方式，那么此时用户的 "@" 可能会到索引 1【英文注释说了是 file mention blocks assumed to be at index 1，说明也不确定】
						const blockIndex = 1 // file mention blocks assumed to be at index 1
						const blockUpdates = innerMap.get(blockIndex)

						// if we have updated this text previously, we want to check whether the lists of files in the metadata are the same
						// 2-2. 如果 API 消息的这个块已经有了优化修改记录，查看（时间戳上）最后一条修改记录的 metadata。第一个列表表示我们已经 修改简化 的文件名列表，第二个列表表示这个块因 mentions "@" 涉及到的所有文件
						// 如果相同，说明我们已经全部替换了 这个块中因 mentions "@" 涉及的文件，跳过该条消息
						// 如果不同，说明我们还有文件需要替换，记录哪些文件已经替换（避免重复处理）
						if (blockUpdates && blockUpdates.length > 0) {
							// the first list indicates the files we have replaced in this text, second list indicates all unique files in this text
							// if they are equal then we have replaced all the files in this text already, and can ignore further processing
							if (
								blockUpdates[blockUpdates.length - 1][3][0].length ===
								blockUpdates[blockUpdates.length - 1][3][1].length
							) {
								continue
							}
							// otherwise there are still file reads here we can overwrite, so still need to process this text chunk
							// to do so we need to keep track of which files we've already replaced so we don't replace them again
							else {
								thisExistingFileReads = blockUpdates[blockUpdates.length - 1][3][0]
							}
						}
					} else {
						// for all other cases we can assume that we dont need to check this again
						continue
					}
				}
			}

			// 3. 处理 "role" 为 "user" 的 API 对话消息（因为工具调用结果 和 mentions "@" 都在 userContent 中）
			const message = apiMessages[i]
			if (message.role === "user" && Array.isArray(message.content) && message.content.length > 0) {
				const firstBlock = message.content[0]
				if (firstBlock.type === "text") {
					// 3-1. 检查是否是（和文件相关的）工具函数调用
					const matchTup = this.parsePotentialToolCall(firstBlock.text)
					let foundNormalFileRead = false
					if (matchTup) {
						// 目前 matchTup[1] 只能是 工具调用要读取的文件路径，如 "src/main.js"
						// 下面三个工具都是 在对应“文件”的修改记录中，添加一个新的简化条目
						if (matchTup[0] === "read_file") {
							this.handleReadFileToolCall(i, matchTup[1], fileReadIndices)
							foundNormalFileRead = true
						} else if (matchTup[0] === "replace_in_file" || matchTup[0] === "write_to_file") {
							if (message.content.length > 1) {
								// NOTE: 所有的工具调用结果都在 message.content[1]，因为 message.content[0] 是工具调用的描述
								const secondBlock = message.content[1]
								if (secondBlock.type === "text") {
									this.handlePotentialFileChangeToolCalls(i, matchTup[1], secondBlock.text, fileReadIndices)
									foundNormalFileRead = true
								}
							}
						}
					}

					// file mentions can happen in most other user message blocks
					// 3-2. 如果不是以上工具调用，继续检查是否是 mentions "@" 引入了文件
					if (!foundNormalFileRead) {
						if (message.content.length > 1) {
							// 【存疑】事实上如果用户在第一轮提问中用了 "@"，那么文件的内容会以 <file_content> 的形式直接包含在第 0 个文本块中
							// 而如果是 在对话过程中，以 Cline 提问+用户回答的方式，那么此时用户的 "@" 可能会到索引 1【这里上面英文注释说了是 file mention blocks assumed to be at index 1，说明也不确定】
							const secondBlock = message.content[1]
							if (secondBlock.type === "text") {
								const [hasFileRead, filePaths] = this.handlePotentialFileMentionCalls(
									i,
									secondBlock.text,
									fileReadIndices,
									thisExistingFileReads, // file reads we've already replaced in this text in the latest version of this updated text
								)
								// 记录第 i 个 API 消息中的 "@" 涉及的所有文件路径。
								if (hasFileRead) {
									messageFilePaths.set(i, filePaths) // all file paths in this string
								}
							}
						}
					}
				}
			}
		}

		return [fileReadIndices, messageFilePaths]
	}

	/**
	 * handles potential file content mentions in text blocks
	 * there will not be more than one of the same file read in a text block
	 *
	 * 对于 文本块中可能出现的（多个）用户用 mentions "@" 引入的文件，在每个“文件”的修改记录中，添加一个新的简化条目【尚未真正处理】：
	 * - 第 i 条 API 消息中的 FILE_MENTION 读取的该“文件”内容被替换为了 `formatResponse.duplicateFileReadNotice`
	 * - mentions "@" 引入的文件内容被 `<file_content>` 标签包裹
	 * @returns [foundMatch, filePaths] - foundMatch: 是否找到匹配项；filePaths: mentions "@" 涉及到（去重）文件路径数组
	 * @param i - 涉及到 file mention 的消息在 “API 对话历史文件” 的索引（outerIndex）
	 * @param secondBlockText - 第二个文本块的内容
	 * @param fileReadIndices - < 文件名 => [outerIndex, EditType, searchText, replaceText] >
	 * @param thisExistingFileReads - 该消息中已经处理的因 "@" 引入的文件名数组
	 */
	private handlePotentialFileMentionCalls(
		i: number,
		secondBlockText: string,
		fileReadIndices: Map<string, [number, number, string, string][]>,
		thisExistingFileReads: string[],
	): [boolean, string[]] {
		const pattern = new RegExp(`<file_content path="([^"]*)">([\\s\\S]*?)</file_content>`, "g")

		let foundMatch = false
		const filePaths: string[] = []

		let match
		// NOTE: 文本块中可能存在多个 mentions "@" 引入文件
		// 正则说明 match[0] 是整个匹配的字符串，match[1] 是文件路径，match[2] 是标签包裹的文件内容
		while ((match = pattern.exec(secondBlockText)) !== null) {
			foundMatch = true

			const filePath = match[1]
			filePaths.push(filePath) // we will record all unique paths from file mentions in this text

			// we can assume that thisExistingFileReads does not have many entries
			if (!thisExistingFileReads.includes(filePath)) {
				// meaning we haven't already replaced this file read

				const entireMatch = match[0] // The entire matched string

				// Create the replacement text - keep the tags but replace the content
				const replacementText = `<file_content path="${filePath}">${formatResponse.duplicateFileReadNotice()}</file_content>`

				const indices = fileReadIndices.get(filePath) || []
				indices.push([i, EditType.FILE_MENTION, entireMatch, replacementText])
				// { fileName => [outerIndex, EditType, searchText, replaceText] }
				fileReadIndices.set(filePath, indices)
			}
		}

		return [foundMatch, filePaths]
	}

	/**
	 * parses specific tool call formats, returns null if no acceptable format is found
	*
	 * 该函数会解析并返回一个包含 工具名 和 工具参数 的数组。
	 *
	 * 【Callback】在 src/core/task/index.tx 中的 `pushToolResult` 函数中会在 userMessageContent 中加入工具调用的信息
	 * ```
	 * this.userMessageContent.push({
	 * 		type: "text",
	 * 		text: `${toolDescription()} Result:`,
	 * })
	 * // inside toolDescription()...
	 * case "read_file":
	 * 		return `[${block.name} for '${block.params.path}']`
	 * ```
	 */
	private parsePotentialToolCall(text: string): [string, string] | null {
		const match = text.match(/^\[([^\s]+) for '([^']+)'\] Result:$/)

		if (!match) {
			return null
		}

		return [match[1], match[2]]
	}

	/**
	 * file_read tool call always pastes the file, so this is always a hit
	 *
	 * 在 file_path 对应“文件”的修改记录中，添加一个新的简化条目【尚未真正处理】：
	 * - 第 i 条 API 消息中的 READ_FILE_TOOL 读取的该“文件”内容被替换为了 `formatResponse.duplicateFileReadNotice`
	 * - read_file 工具调用的结果是文件内容，没有标签
	 */
	private handleReadFileToolCall(
		i: number,
		filePath: string,
		fileReadIndices: Map<string, [number, number, string, string][]>,
	) {
		const indices = fileReadIndices.get(filePath) || []
		indices.push([i, EditType.READ_FILE_TOOL, "", formatResponse.duplicateFileReadNotice()])
		// { fileName => [outerIndex, EditType, searchText, replaceText] }
		fileReadIndices.set(filePath, indices)
	}

	/**
	 * write_to_file and replace_in_file tool output are handled similarly
	 *
	 * 在 file_path 对应“文件”的修改记录中，添加一个新的简化条目【尚未真正处理】：
	 * - 第 i 条 API 消息中的 WRITE_FILE_TOOL 或 REPLACE_IN_FILE_TOOL 读取的该“文件”内容（在第二个文本块）被替换为了 `formatResponse.duplicateFileReadNotice`
	 * - write_to_file 和 replace_in_file 工具调用的结果被 `<final_file_content>` 标签包裹（见 src/core/prompts/response.ts）
	 */
	private handlePotentialFileChangeToolCalls(
		i: number,
		filePath: string,
		secondBlockText: string,
		fileReadIndices: Map<string, [number, number, string, string][]>,
	) {
		const pattern = new RegExp(`(<final_file_content path="[^"]*">)[\\s\\S]*?(</final_file_content>)`)

		// check if this exists in the text, it won't exist if the user rejects the file change for example
		if (pattern.test(secondBlockText)) {
			// 保持标签本身不变的同时，将 标签中间的内容 替换成提示信息
			const replacementText = secondBlockText.replace(pattern, `$1 ${formatResponse.duplicateFileReadNotice()} $2`)
			const indices = fileReadIndices.get(filePath) || []
			indices.push([i, EditType.ALTER_FILE_TOOL, "", replacementText])
			// { fileName => [outerIndex, EditType, searchText, replaceText] }
			fileReadIndices.set(filePath, indices)
		}
	}

	/**
	 * alter all occurrences of file read operations and track which messages were updated
	 * returns the outer index of messages we alter, to count number of changes
	 *
	 * 基于 fileReadIndices 中的修改记录信息，在 this.contextHistoryUpdates 中添加优化记录。
	 *
	 * fileReadIndices 现有的修改记录有：
	 * 1. [i, EditType.FILE_MENTION, entireMatch, replacementText]
	 * 2. [i, EditType.READ_FILE_TOOL, "", formatResponse.duplicateFileReadNotice()]
	 * 3. [i, EditType.ALTER_FILE_TOOL, "", replacementText]
	 * @returns [boolean, Set<number>] - 是否发生了简化，此次简化的消息 在 “API 对话历史文件” 中的索引集合
	 * @param fileReadIndices - < 文件名 => 修改记录 [outerIndex, EditType, searchText, replaceText] >
	 * @param messageFilePaths - < API 消息索引 outerIndex => 该消息因"@"引入的文件名数组 [filePath, ... ] >
	 * @param apiMessages - LLM API 对话历史记录
	 * @param timestamp - 上一个 api_req_started 的 ClineMessage 的时间戳
	 */
	private applyFileReadContextHistoryUpdates(
		fileReadIndices: Map<string, [number, number, string, string][]>,
		messageFilePaths: Map<number, string[]>,
		apiMessages: Anthropic.Messages.MessageParam[],
		timestamp: number,
	): [boolean, Set<number>] {
		let didUpdate = false
		const updatedMessageIndices = new Set<number>() // track which messages we update on this round
		/** < outerIndex => [含"@"文件的消息文本（可能已经处理过若干次）, 已经处理的文件名数组 [filePath, ... ] ] > */
		const fileMentionUpdates = new Map<number, [string, string[]]>()

		for (const [filePath, indices] of fileReadIndices.entries()) {
			// Only process if there are multiple reads of the same file, else we will want to keep the latest read of the file
			// 1. 某文件的修改记录超过 1 条（工具调用 或 mentions "@" 多次涉及同一个文件）时，才进行优化
			if (indices.length > 1) {
				// Process all but the last index, as we will keep that instance of the file read
				// 2. 真正执行该文件的 所有修改记录，除了最后一条（保留最新的文件版本供 LLM 参考）
				for (let i = 0; i < indices.length - 1; i++) {
					const messageIndex = indices[i][0]
					const messageType = indices[i][1] // EditType value
					const searchText = indices[i][2] // search text (for file mentions, else empty string)
					const messageString = indices[i][3] // what we will replace the string with

					didUpdate = true
					updatedMessageIndices.add(messageIndex)

					// for single-fileread text we can set the updates here
					// for potential multi-fileread text we need to determine all changes & iteratively update the text prior to saving the final change
					// 3. 如果是 mentions "@" 引入的文件，根据是否已经处理过该消息，决定此次优化要处理的文本内容 baseText 和 已经处理的文件名数组 prevFilesReplaced。在确定好 2 个变量后，替换简化 baseText，更新 prevFilesReplaced（并未真的改变了 API 消息的内容，只是生成了一份优化记录）
					// 【注解】因为外层循环是按照文件名 filePath 来遍历的，当同一个消息因 mentions "@" 引入了多个文件时，需要多次对该消息进行处理。所以需要维护 对于“消息”而言 已经处理过的文件名数组
					if (messageType === EditType.FILE_MENTION) {
						if (!fileMentionUpdates.has(messageIndex)) {
							// Get base text either from existing updates or from apiMessages
							let baseText = ""
							let prevFilesReplaced: string[] = []

							// 3-1. 如果该消息存在 已经完成的优化修改记录，取优化修改记录的最后一条
							//   MessageContent index=0 的内容作为 上一次优化后的该消息文本
							//   MessageMetadata index=0 的内容作为 上一次优化已经处理的文件名数组
							const innerTuple = this.contextHistoryUpdates.get(messageIndex)
							if (innerTuple) {
								// NOTE: 基于假设 mentions "@" 引入的文件内容在 index=1 文本块中
								const blockUpdates = innerTuple[1].get(1) // assumed index=1 for file mention filereads
								if (blockUpdates && blockUpdates.length > 0) {
									baseText = blockUpdates[blockUpdates.length - 1][2][0] // index 0 of MessageContent
									prevFilesReplaced = blockUpdates[blockUpdates.length - 1][3][0] // previously overwritten file reads in this text
								}
							}
							
							// can assume that this content will exist, otherwise it would not have been in fileReadIndices
							// 3-2. 如果该消息没有 已经完成的优化修改记录，取 API 消息的 index=1 文本块作为 待优化的该消息文本
							const messageContent = apiMessages[messageIndex]?.content
							if (!baseText && Array.isArray(messageContent) && messageContent.length > 1) {
								const contentBlock = messageContent[1] // assume index=1 for all text to replace for file mention filereads
								if (contentBlock.type === "text") {
									baseText = contentBlock.text
								}
							}

							// prevFilesReplaced keeps track of the previous file reads we've replace in this string, empty array if none
							fileMentionUpdates.set(messageIndex, [baseText, prevFilesReplaced])
						}

						// Replace searchText with messageString for all file reads we need to replace in this text
						// 3-3. 处理 mentions "@" 引入的文件，替换文本块中的内容，更新 已经处理的文件名数组（并未真的改变了 API 消息的内容，只是生成了一份优化记录）
						if (searchText) {
							const currentTuple = fileMentionUpdates.get(messageIndex) || ["", []]
							if (currentTuple[0]) {
								// safety check
								// replace this text chunk
								const updatedText = currentTuple[0].replace(searchText, messageString)

								// add the newly added filePath read
								const updatedFileReads = currentTuple[1]
								updatedFileReads.push(filePath)

								fileMentionUpdates.set(messageIndex, [updatedText, updatedFileReads])
							}
						}
					} else {
						// 4. 如果是 工具调用读取的文件，在 contextHistoryUpdates 中增加一条 优化修改记录：
						//  - < messageIndex => [ messageType, < 1 => [ ContextUpdate, ...]> >
						//  - 其中 ContextUpdate 是 [timestamp, "text", [已经优化好的内容 messageString], 空数组（不需要信息）]
						let innerTuple = this.contextHistoryUpdates.get(messageIndex)
						let innerMap: Map<number, ContextUpdate[]>

						if (!innerTuple) {
							innerMap = new Map<number, ContextUpdate[]>()
							this.contextHistoryUpdates.set(messageIndex, [messageType, innerMap])
						} else {
							innerMap = innerTuple[1]
						}

						// block index for file reads from read_file, write_to_file, replace_in_file tools is 1
						const blockIndex = 1

						const updates = innerMap.get(blockIndex) || []

						// metadata array is empty for non-file mention occurrences
						updates.push([timestamp, "text", [messageString], []])

						innerMap.set(blockIndex, updates)
					}
				}
			}
		}

		// apply file mention updates to contextHistoryUpdates
		// in fileMentionUpdates, filePathsUpdated includes all the file paths which are updated in the latest version of this altered text
		// 5. 对于 mentions "@" 引入的文件，在 contextHistoryUpdates 中增加一条 优化修改记录：
		//  - - < messageIndex => [ FILE_MENTION, < 1 => [ ContextUpdate, ...]> >
		//  - 其中 ContextUpdate 是 [timestamp, "text", [已经优化好的内容 updatedText], [已经处理的文件名数组 filePathsUpdated, 该消息因 "@" 引入的所有文件名数组 allFileReads]]
		for (const [messageIndex, [updatedText, filePathsUpdated]] of fileMentionUpdates.entries()) {
			let innerTuple = this.contextHistoryUpdates.get(messageIndex)
			let innerMap: Map<number, ContextUpdate[]>

			if (!innerTuple) {
				innerMap = new Map<number, ContextUpdate[]>()
				this.contextHistoryUpdates.set(messageIndex, [EditType.FILE_MENTION, innerMap])
			} else {
				innerMap = innerTuple[1]
			}

			const blockIndex = 1 // we only consider the block index of 1 for file mentions
			const updates = innerMap.get(blockIndex) || []

			// filePathsUpdated includes changes done previously to this timestamp, and right now
			if (messageFilePaths.has(messageIndex)) {
				const allFileReads = messageFilePaths.get(messageIndex)
				if (allFileReads) {
					// safety check
					// we gather all the file reads possible in this text from messageFilePaths
					// filePathsUpdated from fileMentionUpdates stores all the files reads we have replaced now & previously
					updates.push([timestamp, "text", [updatedText], [filePathsUpdated, allFileReads]])
					innerMap.set(blockIndex, updates)
				}
			}
		}

		return [didUpdate, updatedMessageIndices]
	}

	/**
	 * count total characters in messages and total savings within this range
	 */
	private countCharactersAndSavingsInRange(
		apiMessages: Anthropic.Messages.MessageParam[],
		startIndex: number,
		endIndex: number,
		uniqueFileReadIndices: Set<number>,
	): { totalCharacters: number; charactersSaved: number } {
		let totalCharCount = 0
		let totalCharactersSaved = 0

		for (let i = startIndex; i < endIndex; i++) {
			// looping over the outer indices of messages
			const message = apiMessages[i]

			if (!message.content) {
				continue
			}

			// hasExistingAlterations checks whether the outer idnex has any changes
			// hasExistingAlterations will also include the alterations we just made
			const hasExistingAlterations = this.contextHistoryUpdates.has(i)
			const hasNewAlterations = uniqueFileReadIndices.has(i)

			if (Array.isArray(message.content)) {
				for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
					// looping over inner indices of messages
					const block = message.content[blockIndex]

					if (block.type === "text" && block.text) {
						// true if we just altered it, or it was altered before
						if (hasExistingAlterations) {
							const innerTuple = this.contextHistoryUpdates.get(i)
							const updates = innerTuple?.[1].get(blockIndex) // updated text for this inner index

							if (updates && updates.length > 0) {
								// exists if we have an update for the message at this index
								const latestUpdate = updates[updates.length - 1]

								// if block was just altered, then calculate savings
								if (hasNewAlterations) {
									let originalTextLength
									if (updates.length > 1) {
										originalTextLength = updates[updates.length - 2][2][0].length // handles case if we have multiple updates for same text block
									} else {
										originalTextLength = block.text.length
									}

									const newTextLength = latestUpdate[2][0].length // replacement text
									totalCharactersSaved += originalTextLength - newTextLength

									totalCharCount += originalTextLength
								} else {
									// meaning there was an update to this text previously, but we didn't just alter it
									totalCharCount += latestUpdate[2][0].length
								}
							} else {
								// reach here if there was one inner index with an update, but now we are at a different index, so updates is not defined
								totalCharCount += block.text.length
							}
						} else {
							// reach here if there's no alterations for this outer index, meaning each inner index won't have any changes either
							totalCharCount += block.text.length
						}
					} else if (block.type === "image" && block.source) {
						if (block.source.type === "base64" && block.source.data) {
							totalCharCount += block.source.data.length
						}
					}
				}
			}
		}

		return { totalCharacters: totalCharCount, charactersSaved: totalCharactersSaved }
	}

	/**
	 * count total percentage character savings across in-range conversation
	 *
	 * 计算进行上下文简化后，API 消息的字符节省率。
	 * @param apiMessages - LLM API 对话历史记录
	 * @param conversationHistoryDeletedRange - 已有的 API 对话删除范围
	 * @param uniqueFileReadIndices - 此次简化的消息 在 “API 对话历史文件” 中的索引集合
	 */
	private calculateContextOptimizationMetrics(
		apiMessages: Anthropic.Messages.MessageParam[],
		conversationHistoryDeletedRange: [number, number] | undefined,
		uniqueFileReadIndices: Set<number>,
	): number {
		// count for first user-assistant message pair
		const firstChunkResult = this.countCharactersAndSavingsInRange(apiMessages, 0, 2, uniqueFileReadIndices)

		// count for the remaining in-range messages
		const secondChunkResult = this.countCharactersAndSavingsInRange(
			apiMessages,
			conversationHistoryDeletedRange ? conversationHistoryDeletedRange[1] + 1 : 2,
			apiMessages.length,
			uniqueFileReadIndices,
		)

		const totalCharacters = firstChunkResult.totalCharacters + secondChunkResult.totalCharacters
		const totalCharactersSaved = firstChunkResult.charactersSaved + secondChunkResult.charactersSaved

		const percentCharactersSaved = totalCharacters === 0 ? 0 : totalCharactersSaved / totalCharacters

		return percentCharactersSaved
	}
}
