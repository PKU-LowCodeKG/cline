import { Anthropic } from "@anthropic-ai/sdk"
import axios from "axios"
import delay from "delay"
import OpenAI from "openai"
import { withRetry } from "../retry"
import { ApiHandler } from "../"
import { ApiHandlerOptions, ModelInfo, openRouterDefaultModelId, openRouterDefaultModelInfo } from "../../shared/api"
import { streamOpenRouterFormatRequest } from "../transform/openrouter-stream"
import { ApiStream } from "../transform/stream"
import { convertToR1Format } from "../transform/r1-format"
import { OpenRouterErrorResponse } from "./types"
import { Message } from "ollama"
import { logMessages, logStreamOutput } from "../../core/prompts/show_prompt"

export class OpenRouterHandler implements ApiHandler {
  private options: ApiHandlerOptions
  private client: OpenAI

  constructor(options: ApiHandlerOptions) {
    this.options = options
    this.client = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: this.options.openRouterApiKey,
      defaultHeaders: {
        "HTTP-Referer": "https://cline.bot", // Optional, for including your app on openrouter.ai rankings.
        "X-Title": "Cline", // Optional. Shows in rankings on openrouter.ai.
      },
    })
  }

  @withRetry()
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

    // Create generator to collect chunks
    const genId = yield* (async function* (this: OpenRouterHandler) {
      const self = this
      for await (const chunk of streamOpenRouterFormatRequest(
        self.client,
        systemPrompt,
        messages,
        model,
        self.options.o3MiniReasoningEffort,
        self.options.thinkingBudgetTokens
      )) {
        // Store chunk for logging
        if (chunk.type === "text" || chunk.type === "reasoning") {
          chunks.push(chunk)
        }
        yield chunk
      }
    }).bind(this)()

    let usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0
    }

    if (typeof genId === "string") {
      await delay(500) // FIXME: necessary delay to ensure generation endpoint is ready
      try {
        const generationIterator = this.fetchGenerationDetails(genId)
        const generation = (await generationIterator.next()).value
        // console.log("OpenRouter generation details:", generation)
        usage = {
          inputTokens: generation?.native_tokens_prompt || 0,
          outputTokens: generation?.native_tokens_completion || 0,
          totalCost: generation?.total_cost || 0
        }
        yield {
          type: "usage",
          ...usage
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
              text: `\nUsage Metrics:\nInput Tokens: ${usage.inputTokens}\nOutput Tokens: ${usage.outputTokens}\nTotal Cost: ${usage.totalCost}`
            }
          }
        } as ApiStream)
      } catch (error) {
        // ignore if fails
        console.error("Error fetching OpenRouter generation details:", error)
      }
    }
  }

  @withRetry({ maxRetries: 4, baseDelay: 250, maxDelay: 1000, retryAllErrors: true })
  async *fetchGenerationDetails(genId: string) {
    // console.log("Fetching generation details for:", genId)
    try {
      const response = await axios.get(`https://openrouter.ai/api/v1/generation?id=${genId}`, {
        headers: {
          Authorization: `Bearer ${this.options.openRouterApiKey}`,
        },
        timeout: 5_000, // this request hangs sometimes
      })
      yield response.data?.data
    } catch (error) {
      // ignore if fails
      console.error("Error fetching OpenRouter generation details:", error)
      throw error
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
