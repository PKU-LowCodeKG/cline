import { Anthropic } from "@anthropic-ai/sdk"
import { ClineApiReqInfo, ClineMessage } from "@shared/ExtensionMessage"
import { ApiHandler } from "@api/index"
import { getContextWindowInfo } from "./context-window-utils"

class ContextManager {
	getNewContextMessagesAndMetadata(
		apiConversationHistory: Anthropic.Messages.MessageParam[],
		clineMessages: ClineMessage[],
		api: ApiHandler,
		conversationHistoryDeletedRange: [number, number] | undefined,
		previousApiReqIndex: number,
	) {
		let updatedConversationHistoryDeletedRange = false

		// If the previous API request's total token usage is close to the context window, truncate the conversation history to free up space for the new request
		if (previousApiReqIndex >= 0) {
			// 5-1. 如果 previousApiReqIndex 大于或等于 0，则获取上一个请求的信息。通过解析 clineMessages 中的历史记录，计算出 tokensIn、tokensOut、cacheWrites 和 cacheReads 的总和。
			const previousRequest = clineMessages[previousApiReqIndex]
			if (previousRequest && previousRequest.text) {
				const { tokensIn, tokensOut, cacheWrites, cacheReads }: ClineApiReqInfo = JSON.parse(previousRequest.text)
				const totalTokens = (tokensIn || 0) + (tokensOut || 0) + (cacheWrites || 0) + (cacheReads || 0)
				// 5-2. 根据不同的模型（如 DeepSeek、Claude）的 contextWindow，计算出最大允许的 token 数量。
				const { maxAllowedSize } = getContextWindowInfo(api)

				// This is the most reliable way to know when we're close to hitting the context window.
				// 5-3 如果当前 token 数量超过了上下文窗口的最大值，则选择保留对话的一部分（例如保留四分之一或二分之一），并更新 `conversationHistoryDeletedRange` 来保存已删除的历史记录。
				if (totalTokens >= maxAllowedSize) {
					// Since the user may switch between models with different context windows, truncating half may not be enough (ie if switching from claude 200k to deepseek 64k, half truncation will only remove 100k tokens, but we need to remove much more)
					// So if totalTokens/2 is greater than maxAllowedSize, we truncate 3/4 instead of 1/2
					// FIXME: truncating the conversation in a way that is optimal for prompt caching AND takes into account multi-context window complexity is something we need to improve
					const keep = totalTokens / 2 > maxAllowedSize ? "quarter" : "half"

					// NOTE: it's okay that we overwriteConversationHistory in resume task since we're only ever removing the last user message and not anything in the middle which would affect this range
					conversationHistoryDeletedRange = this.getNextTruncationRange(
						apiConversationHistory,
						conversationHistoryDeletedRange,
						keep,
					)

					updatedConversationHistoryDeletedRange = true
				}
			}
		}

		// conversationHistoryDeletedRange is updated only when we're close to hitting the context window, so we don't continuously break the prompt cache
		const truncatedConversationHistory = this.getTruncatedMessages(apiConversationHistory, conversationHistoryDeletedRange)

		return {
			conversationHistoryDeletedRange: conversationHistoryDeletedRange,
			updatedConversationHistoryDeletedRange: updatedConversationHistoryDeletedRange,
			truncatedConversationHistory: truncatedConversationHistory,
		}
	}

	/**
	 * 【主线】根据已经删除的消息范围，计算当前需要删除的消息范围
	 * 1. 始终保留第一条信息（通常是任务信息，唯一包含 <task> 标签的地方）
	 * 2. 删除剩余信息的 1/2 或 3/4，且删除的是 比较老 的对话消息
	 * 3. 保证删除的最后一条信息 "role" 为 user，以保持 Anthropic 所要求的 user-assistant-user-assistant 结构
	 */
	public getNextTruncationRange(
		apiMessages: Anthropic.Messages.MessageParam[],
		currentDeletedRange: [number, number] | undefined,
		keep: "half" | "quarter",
	): [number, number] {
		// Since we always keep the first message, currentDeletedRange[0] will always be 1 (for now until we have a smarter truncation algorithm)
		const rangeStartIndex = 1
		const startOfRest = currentDeletedRange ? currentDeletedRange[1] + 1 : 1

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

		let rangeEndIndex = startOfRest + messagesToRemove - 1

		// Make sure the last message being removed is a user message, so that the next message after the initial task message is an assistant message. This preservers the user-assistant-user-assistant structure.
		// NOTE: anthropic format messages are always user-assistant-user-assistant, while openai format messages can have multiple user messages in a row (we use anthropic format throughout cline)
		if (apiMessages[rangeEndIndex].role !== "user") {
			rangeEndIndex -= 1
		}

		// this is an inclusive range that will be removed from the conversation history
		return [rangeStartIndex, rangeEndIndex]
	}

	/** 根据删除范围构造截断后的消息数组 */
	public getTruncatedMessages(
		messages: Anthropic.Messages.MessageParam[],
		deletedRange: [number, number] | undefined,
	): Anthropic.Messages.MessageParam[] {
		if (!deletedRange) {
			return messages
		}

		const [start, end] = deletedRange
		// the range is inclusive - both start and end indices and everything in between will be removed from the final result.
		// NOTE: if you try to console log these, don't forget that logging a reference to an array may not provide the same result as logging a slice() snapshot of that array at that exact moment. The following DOES in fact include the latest assistant message.
		return [...messages.slice(0, start), ...messages.slice(end + 1)]
	}
}
