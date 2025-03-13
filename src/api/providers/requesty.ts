import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { ApiHandlerOptions, ModelInfo, openAiModelInfoSaneDefaults } from "../../shared/api"
import { ApiHandler } from "../index"
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"


import { Message } from "ollama"
import { logMessages, logStreamOutput } from "../../core/prompts/show_prompt"

export class RequestyHandler implements ApiHandler {
	private options: ApiHandlerOptions
	private client: OpenAI

	constructor(options: ApiHandlerOptions) {
		this.options = options
		this.client = new OpenAI({
			baseURL: "https://router.requesty.ai/v1",
			apiKey: this.options.requestyApiKey,
			defaultHeaders: {
				"HTTP-Referer": "https://cline.bot",
				"X-Title": "Cline",
			},
		})
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
		const chunks: Array<{ type: "text" | "reasoning", text?: string, reasoning?: string }> = []
		let usage = {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalCost: 0
		}

		const modelId = this.options.requestyModelId ?? ""

		let openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		// @ts-ignore-next-line
		const stream = await this.client.chat.completions.create({
			model: modelId,
			messages: openAiMessages,
			temperature: 0,
			stream: true,
			stream_options: { include_usage: true },
			...(modelId === "openai/o3-mini" ? { reasoning_effort: this.options.o3MiniReasoningEffort || "medium" } : {}),
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

			if (delta && "reasoning_content" in delta && delta.reasoning_content) {
				const reasoningChunk = {
					type: "reasoning" as const,
					reasoning: (delta.reasoning_content as string | undefined) || ""
				}
				chunks.push(reasoningChunk)
				yield reasoningChunk
			}

			// Requesty usage includes an extra field for Anthropic use cases.
			// Safely cast the prompt token details section to the appropriate structure.
			interface RequestyUsage extends OpenAI.CompletionUsage {
				prompt_tokens_details?: {
					caching_tokens?: number
					cached_tokens?: number
				}
				total_cost?: number
			}

			if (chunk.usage) {
				const requestyUsage = chunk.usage as RequestyUsage
				usage = {
					inputTokens: requestyUsage.prompt_tokens || 0,
					outputTokens: requestyUsage.completion_tokens || 0,
					cacheReadTokens: requestyUsage.prompt_tokens_details?.cached_tokens || 0,
					cacheWriteTokens: requestyUsage.prompt_tokens_details?.caching_tokens || 0,
					totalCost: requestyUsage.total_cost || 0 // TODO: Replace with calculateApiCostOpenAI once implemented
				}
				yield {
					type: "usage",
					...usage,
					cacheWriteTokens: usage.cacheWriteTokens || undefined,
					cacheReadTokens: usage.cacheReadTokens || undefined
				}
			}
		}

		// Log complete output
		await logStreamOutput({
			async *[Symbol.asyncIterator]() {
				// First yield all text/reasoning chunks
				for (const chunk of chunks) {
					yield chunk
				}
				// Then yield usage information as a text chunk
				yield {
					type: "text",
					text: `\nUsage Metrics:\nInput Tokens: ${usage.inputTokens}\nOutput Tokens: ${usage.outputTokens}\nCache Read Tokens: ${usage.cacheReadTokens}\nCache Write Tokens: ${usage.cacheWriteTokens}\nTotal Cost: ${usage.totalCost}`
				}
			}
		} as ApiStream)
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: this.options.requestyModelId ?? "",
			info: openAiModelInfoSaneDefaults,
		}
	}
}
