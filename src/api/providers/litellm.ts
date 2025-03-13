import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { ApiHandlerOptions, liteLlmDefaultModelId, liteLlmModelInfoSaneDefaults } from "../../shared/api"
import { ApiHandler } from ".."
import { ApiStream } from "../transform/stream"
import { convertToOpenAiMessages } from "../transform/openai-format"


import { Message } from "ollama"
import { logMessages, logStreamOutput } from "../../core/prompts/show_prompt"

export class LiteLlmHandler implements ApiHandler {
	private options: ApiHandlerOptions
	private client: OpenAI

	constructor(options: ApiHandlerOptions) {
		this.options = options
		this.client = new OpenAI({
			baseURL: this.options.liteLlmBaseUrl || "http://localhost:4000",
			apiKey: this.options.liteLlmApiKey || "noop",
		})
	}

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

		const formattedMessages = convertToOpenAiMessages(messages)
		const systemMessage: OpenAI.Chat.ChatCompletionSystemMessageParam = {
			role: "system",
			content: systemPrompt,
		}
		const modelId = this.options.liteLlmModelId || liteLlmDefaultModelId
		const isOminiModel = modelId.includes("o1-mini") || modelId.includes("o3-mini")
		let temperature: number | undefined = 0

		if (isOminiModel) {
			temperature = undefined // does not support temperature
		}

		const stream = await this.client.chat.completions.create({
			model: this.options.liteLlmModelId || liteLlmDefaultModelId,
			messages: [systemMessage, ...formattedMessages],
			temperature,
			stream: true,
			stream_options: { include_usage: true },
		})

		let usage = {
			inputTokens: 0,
			outputTokens: 0
		}

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
				usage = {
					inputTokens: chunk.usage.prompt_tokens || 0,
					outputTokens: chunk.usage.completion_tokens || 0
				}
				yield {
					type: "usage",
					...usage
				}
			}
		}

		// Log complete output including usage information
		await logStreamOutput({
			async *[Symbol.asyncIterator]() {
				// First yield all text chunks
				for (const chunk of chunks) {
					yield chunk
				}
				// Then yield usage information as a text chunk
				yield {
					type: "text",
					text: `\nUsage Metrics:\nInput Tokens: ${usage.inputTokens}\nOutput Tokens: ${usage.outputTokens}`
				}
			}
		} as ApiStream)
	}

	getModel() {
		return {
			id: this.options.liteLlmModelId || liteLlmDefaultModelId,
			info: liteLlmModelInfoSaneDefaults,
		}
	}
}
