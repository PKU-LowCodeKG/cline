import { Anthropic } from "@anthropic-ai/sdk"
import { Message, Ollama } from "ollama"
import { ApiHandler } from "../"
import { ApiHandlerOptions, ModelInfo, openAiModelInfoSaneDefaults } from "../../shared/api"
import { convertToOllamaMessages } from "../transform/ollama-format"
import { ApiStream } from "../transform/stream"


import { logMessages, logStreamOutput } from "../../core/prompts/show_prompt"

export class OllamaHandler implements ApiHandler {
	private options: ApiHandlerOptions
	private client: Ollama

	constructor(options: ApiHandlerOptions) {
		this.options = options
		this.client = new Ollama({ host: this.options.ollamaBaseUrl || "http://localhost:11434" })
	}

	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		const ollamaMessages: Message[] = [{ role: "system", content: systemPrompt }, ...convertToOllamaMessages(messages)]

		// Log input messages
		logMessages(ollamaMessages)

		const stream = await this.client.chat({
			model: this.getModel().id,
			messages: ollamaMessages,
			stream: true,
			options: {
				num_ctx: Number(this.options.ollamaApiOptionsCtxNum) || 32768,
			},
		})

		// Create a generator for collecting chunks
		const chunks: Array<{ type: "text", text: string }> = []
		for await (const chunk of stream) {
			if (typeof chunk.message.content === "string") {
				const streamChunk = {
					type: "text" as const,
					text: chunk.message.content,
				}
				chunks.push(streamChunk)
				yield streamChunk
			}
		}

		// Log complete output
		await logStreamOutput({
			async *[Symbol.asyncIterator]() {
				for (const chunk of chunks) {
					yield chunk
				}
			}
		} as ApiStream)
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: this.options.ollamaModelId || "",
			info: openAiModelInfoSaneDefaults,
		}
	}
}
