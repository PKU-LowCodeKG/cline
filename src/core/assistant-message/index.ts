/** 定义 Cline 的 Assistant Message，纯文本或者工具调用 */
export type AssistantMessageContent = TextContent | ToolUse

export { parseAssistantMessage } from "./parse-assistant-message"

/** Cline 定义的 TextContent Assistant Message */
export interface TextContent {
	type: "text"
	/** 具体文本消息内容 */
	content: string
	/**
	 * 当前 Assistant Message 是否是 部分消息。从字符串中解析出内容时
	 * - 可能解析途中尚未拼成完整内容
	 * - 也可能用于解析的字符串因为流式传输本身不完整
	 */
	partial: boolean
}

export const toolUseNames = [
	"execute_command",
	"read_file",
	"write_to_file",
	"replace_in_file",
	"search_files",
	"list_files",
	"list_code_definition_names",
	"browser_action",
	"use_mcp_tool",
	"access_mcp_resource",
	"ask_followup_question",
	"plan_mode_response",
	"attempt_completion",
] as const

// Converts array of tool call names into a union type ("execute_command" | "read_file" | ...)
export type ToolUseName = (typeof toolUseNames)[number]

export const toolParamNames = [
	"command",
	"requires_approval",
	"path",
	"content",
	"diff",
	"regex",
	"file_pattern",
	"recursive",
	"action",
	"url",
	"coordinate",
	"text",
	"server_name",
	"tool_name",
	"arguments",
	"uri",
	"question",
	"options",
	"response",
	"result",
] as const

/** Cline 定义的 ToolUse Assistant Message 的参数对象键值 */
export type ToolParamName = (typeof toolParamNames)[number]

/** Cline 定义的 ToolUse Assistant Message，type 固定为"tool_use"，name 和 params 区分工具调用 */
export interface ToolUse {
	type: "tool_use"
	/** 工具调用的名称 */
	name: ToolUseName
	// params is a partial record, allowing only some or none of the possible parameters to be used
	/** 工具调用的参数 */
	params: Partial<Record<ToolParamName, string>>
	/**
	 * 当前 Assistant Message 是否是 部分消息。从字符串中解析出内容时
	 * - 可能解析途中尚未拼成完整内容
	 * - 也可能用于解析的字符串因为流式传输本身不完整
	 */
	partial: boolean
}
