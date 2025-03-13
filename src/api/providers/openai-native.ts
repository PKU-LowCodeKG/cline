import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { withRetry } from "../retry"
import { ApiHandler } from "../"
import {
	ApiHandlerOptions,
	ModelInfo,
	openAiNativeDefaultModelId,
	OpenAiNativeModelId,
	openAiNativeModels,
} from "../../shared/api"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { calculateApiCostOpenAI } from "../../utils/cost"
import { ApiStream } from "../transform/stream"
import { ChatCompletionReasoningEffort } from "openai/resources/chat/completions.mjs"
import { Message } from "ollama"
import { logMessages, logStreamOutput } from "../../core/prompts/show_prompt"

export class OpenAiNativeHandler implements ApiHandler {
	private options: ApiHandlerOptions
	private client: OpenAI

	constructor(options: ApiHandlerOptions) {
		this.options = options
		this.client = new OpenAI({
			apiKey: this.options.openAiNativeApiKey,
		})
	}

	private async *yieldUsage(info: ModelInfo, usage: OpenAI.Completions.CompletionUsage | undefined): ApiStream {
		const inputTokens = usage?.prompt_tokens || 0
		const outputTokens = usage?.completion_tokens || 0
		const cacheReadTokens = usage?.prompt_tokens_details?.cached_tokens || 0
		const cacheWriteTokens = 0
		const totalCost = calculateApiCostOpenAI(info, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens)
		yield {
			type: "usage",
			inputTokens: inputTokens,
			outputTokens: outputTokens,
			cacheWriteTokens: cacheWriteTokens,
			cacheReadTokens: cacheReadTokens,
			totalCost: totalCost,
		}
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		// Convert messages to Ollama format for logging
		const ollamaMessages: Message[] = [
			{ role: "system", content: systemPrompt },
			...messages.map(msg => ({
				role: msg.role,
				content: typeof msg.content === "string"
					? msg.content
					: msg.content.map(c => ('text' in c ? c.text : '')).filter(Boolean).join("\n")
			}))
		]
		logMessages(ollamaMessages)

		// Create array to collect chunks for logging
		const chunks: Array<{ type: "text", text: string }> = []
		let usage = {
			inputTokens: 0,
			outputTokens: 0,
			cacheWriteTokens: 0,
			cacheReadTokens: 0,
			totalCost: 0
		}

		const model = this.getModel()

		switch (model.id) {
			case "o1":
			case "o1-preview":
			case "o1-mini": {
				// o1 doesnt support streaming, non-1 temp, or system prompt
				const response = await this.client.chat.completions.create({
					model: model.id,
					messages: [{ role: "user", content: systemPrompt }, ...convertToOpenAiMessages(messages)],
				})
				const textChunk = {
					type: "text" as const,
					text: response.choices[0]?.message.content || ""
				}
				chunks.push(textChunk)
				yield textChunk

				// Collect usage information
				const usageInfo = await this.yieldUsage(model.info, response.usage).next()
				if (usageInfo.value && usageInfo.value.type === "usage") {
					usage = {
						inputTokens: usageInfo.value.inputTokens,
						outputTokens: usageInfo.value.outputTokens,
						cacheWriteTokens: usageInfo.value.cacheWriteTokens || 0,
						cacheReadTokens: usageInfo.value.cacheReadTokens || 0,
						totalCost: usageInfo.value.totalCost || 0
					}
				}
				yield usageInfo.value

				// Log complete output
				await logStreamOutput({
					async *[Symbol.asyncIterator]() {
						yield textChunk
						yield {
							type: "text",
							text: `\nUsage Metrics:\nInput Tokens: ${usage.inputTokens}\nOutput Tokens: ${usage.outputTokens}\nCache Read Tokens: ${usage.cacheReadTokens}\nCache Write Tokens: ${usage.cacheWriteTokens}\nTotal Cost: ${usage.totalCost}`
						}
					}
				} as ApiStream)

				break
			}
			case "o3-mini": {
				// Reset usage for new stream
				usage = {
					inputTokens: 0,
					outputTokens: 0,
					cacheWriteTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0
				}

				const stream = await this.client.chat.completions.create({
					model: model.id,
					messages: [{ role: "developer", content: systemPrompt }, ...convertToOpenAiMessages(messages)],
					stream: true,
					stream_options: { include_usage: true },
					reasoning_effort: (this.options.o3MiniReasoningEffort as ChatCompletionReasoningEffort) || "medium",
				})
				for await (const chunk of stream) {
					const delta = chunk.choices[0]?.delta
					if (delta?.content) {
						const textChunk = {
							type: "text" as const,
							text: delta.content
						}
						chunks.push(textChunk)
						yield textChunk
					}
					if (chunk.usage) {
						// Only last chunk contains usage
						const usageInfo = await this.yieldUsage(model.info, chunk.usage).next()
						if (usageInfo.value && usageInfo.value.type === "usage") {
							usage = {
								inputTokens: usageInfo.value.inputTokens,
								outputTokens: usageInfo.value.outputTokens,
								cacheWriteTokens: usageInfo.value.cacheWriteTokens || 0,
								cacheReadTokens: usageInfo.value.cacheReadTokens || 0,
								totalCost: usageInfo.value.totalCost || 0
							}
						}
						yield usageInfo.value
					}
				}

				// Log complete output
				await logStreamOutput({
					async *[Symbol.asyncIterator]() {
						for (const chunk of chunks) {
							yield chunk
						}
						yield {
							type: "text",
							text: `\nUsage Metrics:\nInput Tokens: ${usage.inputTokens}\nOutput Tokens: ${usage.outputTokens}\nCache Read Tokens: ${usage.cacheReadTokens}\nCache Write Tokens: ${usage.cacheWriteTokens}\nTotal Cost: ${usage.totalCost}`
						}
					}
				} as ApiStream)

				break
			}
			default: {
				// Reset usage for new stream
				usage = {
					inputTokens: 0,
					outputTokens: 0,
					cacheWriteTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0
				}

				const stream = await this.client.chat.completions.create({
					model: model.id,
					// max_completion_tokens: this.getModel().info.maxTokens,
					temperature: 0,
					messages: [{ role: "system", content: systemPrompt }, ...convertToOpenAiMessages(messages)],
					stream: true,
					stream_options: { include_usage: true },
				})

				for await (const chunk of stream) {
					const delta = chunk.choices[0]?.delta
					if (delta?.content) {
						const textChunk = {
							type: "text" as const,
							text: delta.content
						}
						chunks.push(textChunk)
						yield textChunk
					}
					if (chunk.usage) {
						// Only last chunk contains usage
						const usageInfo = await this.yieldUsage(model.info, chunk.usage).next()
						if (usageInfo.value && usageInfo.value.type === "usage") {
							usage = {
								inputTokens: usageInfo.value.inputTokens,
								outputTokens: usageInfo.value.outputTokens,
								cacheWriteTokens: usageInfo.value.cacheWriteTokens || 0,
								cacheReadTokens: usageInfo.value.cacheReadTokens || 0,
								totalCost: usageInfo.value.totalCost || 0
							}
						}
						yield usageInfo.value
					}
				}

				// Log complete output
				await logStreamOutput({
					async *[Symbol.asyncIterator]() {
						for (const chunk of chunks) {
							yield chunk
						}
						yield {
							type: "text",
							text: `\nUsage Metrics:\nInput Tokens: ${usage.inputTokens}\nOutput Tokens: ${usage.outputTokens}\nCache Read Tokens: ${usage.cacheReadTokens}\nCache Write Tokens: ${usage.cacheWriteTokens}\nTotal Cost: ${usage.totalCost}`
						}
					}
				} as ApiStream)
			}
		}
	}

	getModel(): { id: OpenAiNativeModelId; info: ModelInfo } {
		const modelId = this.options.apiModelId
		if (modelId && modelId in openAiNativeModels) {
			const id = modelId as OpenAiNativeModelId
			return { id, info: openAiNativeModels[id] }
		}
		return {
			id: openAiNativeDefaultModelId,
			info: openAiNativeModels[openAiNativeDefaultModelId],
		}
	}
}
