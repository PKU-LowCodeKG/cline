import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { ApiHandler } from "../"
import { ApiHandlerOptions, ModelInfo, openRouterDefaultModelId, openRouterDefaultModelInfo } from "../../shared/api"
import { streamOpenRouterFormatRequest } from "../transform/openrouter-stream"
import { ApiStream } from "../transform/stream"
import axios from "axios"
import { Message } from "ollama"
import { logMessages, logStreamOutput } from "../../core/prompts/show_prompt"

export class ClineHandler implements ApiHandler {
	private options: ApiHandlerOptions
	private client: OpenAI

	constructor(options: ApiHandlerOptions) {
		this.options = options
		this.client = new OpenAI({
			baseURL: "https://api.cline.bot/v1",
			apiKey: this.options.clineApiKey || "",
		})
	}

	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		const model = this.getModel()

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

		// Collect chunks while yielding them
		const genId = yield* (async function* (this: ClineHandler) {
			for await (const chunk of streamOpenRouterFormatRequest(
				this.client,
				systemPrompt,
				messages,
				model,
				this.options.o3MiniReasoningEffort,
				this.options.thinkingBudgetTokens
			)) {
				// Store chunk for logging
				if (chunk.type === "text" || chunk.type === "reasoning") {
					chunks.push(chunk)
				}
				yield chunk
			}
		}).bind(this)()

		try {
			const response = await axios.get(`https://api.cline.bot/v1/generation?id=${genId}`, {
				headers: {
					Authorization: `Bearer ${this.options.clineApiKey}`,
				},
				timeout: 5_000, // this request hangs sometimes
			})

			const generation = response.data
			console.log("cline generation details:", generation)

			// Log complete output including all collected chunks
			await logStreamOutput({
				async *[Symbol.asyncIterator]() {
					// First yield all text/reasoning chunks
					for (const chunk of chunks) {
						yield chunk
					}
					// Then yield generation details as a final chunk
					yield {
						type: "text",
						text: `\nGeneration Details:\nInput Tokens: ${generation?.native_tokens_prompt || 0}\nOutput Tokens: ${generation?.native_tokens_completion || 0}\nTotal Cost: ${generation?.total_cost || 0}`
					}
				}
			} as ApiStream)
			yield {
				type: "usage",
				inputTokens: generation?.native_tokens_prompt || 0,
				outputTokens: generation?.native_tokens_completion || 0,
				totalCost: generation?.total_cost || 0,
			}
		} catch (error) {
			// ignore if fails
			console.error("Error fetching cline generation details:", error)
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		const modelId = this.options.openRouterModelId
		const modelInfo = this.options.openRouterModelInfo
		if (modelId && modelInfo) {
			return { id: modelId, info: modelInfo }
		}
		return { id: openRouterDefaultModelId, info: openRouterDefaultModelInfo }
	}
}
