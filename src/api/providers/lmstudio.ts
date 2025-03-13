import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { ApiHandler } from "../"
import { ApiHandlerOptions, ModelInfo, openAiModelInfoSaneDefaults } from "../../shared/api"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"
import { Message } from "ollama"
import { logMessages, logStreamOutput } from "../../core/prompts/show_prompt"

export class LmStudioHandler implements ApiHandler {
	private options: ApiHandlerOptions
	private client: OpenAI

	constructor(options: ApiHandlerOptions) {
		this.options = options
		this.client = new OpenAI({
			baseURL: (this.options.lmStudioBaseUrl || "http://localhost:1234") + "/v1",
			apiKey: "noop",
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

		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		try {
			const stream = await this.client.chat.completions.create({
				model: this.getModel().id,
				messages: openAiMessages,
				temperature: 0,
				stream: true,
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
			}

			// Log complete output
			await logStreamOutput({
				async *[Symbol.asyncIterator]() {
					for (const chunk of chunks) {
						yield chunk
					}
				}
			} as ApiStream)
		} catch (error) {
			// LM Studio doesn't return an error code/body for now
			throw new Error(
				"Please check the LM Studio developer logs to debug what went wrong. You may need to load the model with a larger context length to work with Cline's prompts.",
			)
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: this.options.lmStudioModelId || "",
			info: openAiModelInfoSaneDefaults,
		}
	}
}
