import { Anthropic } from "@anthropic-ai/sdk"

export class ContextManager {
	/**
	 * 【主线】根据已经删除的消息范围，计算当前需要删除的消息范围
	 * 1. 始终保留第一条信息（通常是任务信息，唯一包含 <task> 标签的地方）
	 * 2. 删除剩余信息的 1/2 或 3/4，且删除的是 比较老 的对话消息
	 * 3. 保证删除的最后一条信息 "role" 为 user，以保持 Anthropic 所要求的 user-assistant-user-assistant 结构
	 */
	getNextTruncationRange(
		messages: Anthropic.Messages.MessageParam[],
		currentDeletedRange: [number, number] | undefined = undefined,
		keep: "half" | "quarter" = "half",
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
			messagesToRemove = Math.floor((messages.length - startOfRest) / 4) * 2 // Keep even number
		} else {
			// Remove 3/4 of remaining user-assistant pairs
			// We calculate 3/4ths of the messages then divide by 2 to get the number of pairs.
			// After flooring, we multiply by 2 to get the number of messages.
			// Note that this will also always be an even number.
			messagesToRemove = Math.floor(((messages.length - startOfRest) * 3) / 4 / 2) * 2
		}

		let rangeEndIndex = startOfRest + messagesToRemove - 1

		// Make sure the last message being removed is a user message, so that the next message after the initial task message is an assistant message. This preservers the user-assistant-user-assistant structure.
		// NOTE: anthropic format messages are always user-assistant-user-assistant, while openai format messages can have multiple user messages in a row (we use anthropic format throughout cline)
		if (messages[rangeEndIndex].role !== "user") {
			rangeEndIndex -= 1
		}

		// this is an inclusive range that will be removed from the conversation history
		return [rangeStartIndex, rangeEndIndex]
	}

	/** 根据删除范围构造截断后的消息数组 */
	getTruncatedMessages(
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
