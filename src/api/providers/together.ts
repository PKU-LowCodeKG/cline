import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { withRetry } from "../retry"
import { ApiHandlerOptions, ModelInfo, openAiModelInfoSaneDefaults } from "../../shared/api"
import { ApiHandler } from "../index"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"
import { convertToR1Format } from "../transform/r1-format"
import { Message } from "ollama"
import { logMessages, logStreamOutput } from "../../core/prompts/show_prompt"

export class TogetherHandler implements ApiHandler {
	private options: ApiHandlerOptions
	private client: OpenAI

	constructor(options: ApiHandlerOptions) {
		this.options = options
		this.client = new OpenAI({
			baseURL: "https://api.together.xyz/v1",
			apiKey: this.options.togetherApiKey,
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
			outputTokens: 0
		}

		const modelId = this.options.togetherModelId ?? ""
		const isDeepseekReasoner = modelId.includes("deepseek-reasoner")

		let openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		if (isDeepseekReasoner) {
			openAiMessages = convertToR1Format([{ role: "user", content: systemPrompt }, ...messages])
		}

		const stream = await this.client.chat.completions.create({
			model: modelId,
			messages: openAiMessages,
			temperature: 0,
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

			if (delta && "reasoning_content" in delta && delta.reasoning_content) {
				const reasoningChunk = {
					type: "reasoning" as const,
					reasoning: (delta.reasoning_content as string | undefined) || ""
				}
				chunks.push(reasoningChunk)
				yield reasoningChunk
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
					text: `\nUsage Metrics:\nInput Tokens: ${usage.inputTokens}\nOutput Tokens: ${usage.outputTokens}`
				}
			}
		} as ApiStream)
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: this.options.togetherModelId ?? "",
			info: openAiModelInfoSaneDefaults,
		}
	}
}
