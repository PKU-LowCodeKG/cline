import { AssistantMessageContent, TextContent, ToolUse, ToolParamName, toolParamNames, toolUseNames, ToolUseName } from "."

/**
 * 从待解析的 文本 中解析出 AssistantMessageContent 数组
 *
 * 遍历文本，逐个字符解析。把 模型的响应Chunk 中的 **纯文本 和 被包裹在其中的工具调用标签** 分开，记为 `text` 和 `tool_use` 类型的 Assistant 消息块，形成 AssistantMessageContent 数组并返回
 *
 * 根据这个函数的实现：
 * 1. 模型的一次响应中，可以调用多个工具，每个工具调用都是一个 `tool_use` 类型的 Assistant 消息块，而工具调用之间的文本内容则是 `text` 类型的 Assistant 消息块。
 * 2. 目前一个 Assistant 消息块只能最多包含一个工具调用。如果模型响应中 出现了 工具调用标签嵌套 的情况，内层的工具调用标签 只会被作为纯文本来解析。
 * @param assistantMessage 待解析的 模型的响应Chunk 文本
 * @returns AssistantMessageContent[]
 */
export function parseAssistantMessage(assistantMessage: string) {
	const contentBlocks: AssistantMessageContent[] = []
	let currentTextContent: TextContent | undefined = undefined
	let currentTextContentStartIndex = 0
	let currentToolUse: ToolUse | undefined = undefined
	let currentToolUseStartIndex = 0
	let currentParamName: ToolParamName | undefined = undefined
	let currentParamValueStartIndex = 0
	let accumulator = ""

	for (let i = 0; i < assistantMessage.length; i++) {
		const char = assistantMessage[i]
		accumulator += char

		// there should not be a param without a tool use
		// NOTE: 如果当前存在正在解析的 tool_use 类型的消息，并且存在正在解析的参数
		// - 如果当前子串 accumulator 以一个 参数的结束标签</param> 结尾，则结束解析当前的参数
		if (currentToolUse && currentParamName) {
			const currentParamValue = accumulator.slice(currentParamValueStartIndex)
			const paramClosingTag = `</${currentParamName}>`
			if (currentParamValue.endsWith(paramClosingTag)) {
				// end of param value
				currentToolUse.params[currentParamName] = currentParamValue.slice(0, -paramClosingTag.length).trim()
				currentParamName = undefined
				continue
			} else {
				// partial param value is accumulating
				continue
			}
		}

		// no currentParamName
		// NOTE: 如果当前存在正在解析的 tool_use 类型的消息
		// - 如果当前子串 accumulator 以一个 工具调用的结束标签</tool_use> 结尾，则结束解析当前的工具调用；
		//     标记当前的 tool_use 类型的消息是完整的
		// - 如果当前子串 accumulator 以一个 参数的开始标签<param> 结尾，则开始解析一个新的参数；
		//     特殊处理 write_to_file 工具调用的 content 参数，因为它可能包含多个开始-结束标签对，所以需要选择最后一个结束标签
		if (currentToolUse) {
			const currentToolValue = accumulator.slice(currentToolUseStartIndex)
			const toolUseClosingTag = `</${currentToolUse.name}>`
			if (currentToolValue.endsWith(toolUseClosingTag)) {
				// end of a tool use
				currentToolUse.partial = false
				contentBlocks.push(currentToolUse)
				currentToolUse = undefined
				continue
			} else {
				const possibleParamOpeningTags = toolParamNames.map((name) => `<${name}>`)
				for (const paramOpeningTag of possibleParamOpeningTags) {
					if (accumulator.endsWith(paramOpeningTag)) {
						// start of a new parameter
						currentParamName = paramOpeningTag.slice(1, -1) as ToolParamName
						currentParamValueStartIndex = accumulator.length
						break
					}
				}

				// there's no current param, and not starting a new param

				// special case for write_to_file where file contents could contain the closing tag, in which case the param would have closed and we end up with the rest of the file contents here. To work around this, we get the string between the starting content tag and the LAST content tag.
				const contentParamName: ToolParamName = "content"
				if (currentToolUse.name === "write_to_file" && accumulator.endsWith(`</${contentParamName}>`)) {
					const toolContent = accumulator.slice(currentToolUseStartIndex)
					const contentStartTag = `<${contentParamName}>`
					const contentEndTag = `</${contentParamName}>`
					const contentStartIndex = toolContent.indexOf(contentStartTag) + contentStartTag.length
					const contentEndIndex = toolContent.lastIndexOf(contentEndTag)
					if (contentStartIndex !== -1 && contentEndIndex !== -1 && contentEndIndex > contentStartIndex) {
						currentToolUse.params[contentParamName] = toolContent.slice(contentStartIndex, contentEndIndex).trim()
					}
				}

				// partial tool value is accumulating
				continue
			}
		}

		// no currentToolUse
		// NOTE: 如果当前子串 accumulator 以一个 工具调用的开始标签<tool_use> 结尾，则开始解析一个新的工具调用，同时它是不完整的
		// - text 类型的消息内容是否结束，取决于是否开始了一个新的工具调用
		let didStartToolUse = false
		const possibleToolUseOpeningTags = toolUseNames.map((name) => `<${name}>`)
		for (const toolUseOpeningTag of possibleToolUseOpeningTags) {
			if (accumulator.endsWith(toolUseOpeningTag)) {
				// start of a new tool use
				currentToolUse = {
					type: "tool_use",
					name: toolUseOpeningTag.slice(1, -1) as ToolUseName,
					params: {},
					partial: true,
				}
				// 接下来是工具调用标签 包裹的内容
				currentToolUseStartIndex = accumulator.length
				// this also indicates the end of the current text content
				// 因为开始了一个新的 tool_use 类型，所以 如果当前存在正在解析的 text 类型的消息，其内容就算是结束了
				// 标记当前的 text 类型的消息是完整的；切除掉 tool_use 标签的开始标签
				if (currentTextContent) {
					currentTextContent.partial = false
					// remove the partially accumulated tool use tag from the end of text (<tool)
					currentTextContent.content = currentTextContent.content
						.slice(0, -toolUseOpeningTag.slice(0, -1).length)
						.trim()
					contentBlocks.push(currentTextContent)
					currentTextContent = undefined
				}

				didStartToolUse = true
				break
			}
		}

		// NOTE: 如果当前并没有开始解析一个新的工具调用，则当前的子串就是 text 类型的消息，同时它是不完整的
		if (!didStartToolUse) {
			// no tool use, so it must be text either at the beginning or between tools
			if (currentTextContent === undefined) {
				currentTextContentStartIndex = i
			}
			currentTextContent = {
				type: "text",
				content: accumulator.slice(currentTextContentStartIndex).trim(),
				partial: true,
			}
		}
	}

	if (currentToolUse) {
		// stream did not complete tool call, add it as partial
		if (currentParamName) {
			// tool call has a parameter that was not completed
			currentToolUse.params[currentParamName] = accumulator.slice(currentParamValueStartIndex).trim()
		}
		contentBlocks.push(currentToolUse)
	}

	// Note: it doesn't matter if check for currentToolUse or currentTextContent, only one of them will be defined since only one can be partial at a time
	if (currentTextContent) {
		// stream did not complete text content, add it as partial
		contentBlocks.push(currentTextContent)
	}

	return contentBlocks
}
