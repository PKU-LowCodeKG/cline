/**
 * Cline 的全局文件名
 * 1. 在 Windows 上，`context.globalStorageUri.fsPath` 为：
 * `C:\Users\<你的用户名>\AppData\Roaming\Code\User\globalStorage\<发布者名称>.<扩展名>`
 * 2. 在 Linux 上，`context.globalStorageUri.fsPath` 为：
 * `/home/<你的用户名>/.config/Code/User/globalStorage/<发布者名称>.<扩展名>`
 *
 * Cline 的<发布者名称>.<扩展名> 为 saoudrizwan.claude-dev
 */

// NOTE: These are here temporarily until we find a better home for them
export const GlobalFileNames = {
	/** 存放 LLM API 对话历史记录（均以 Anthropic API 形式存放） */
	apiConversationHistory: "api_conversation_history.json",
	/** 存放 Cline Message，用于插件 webview UI 显示 */
	uiMessages: "ui_messages.json",
	/** 存放 openrouter 的 LLM API 信息 */
	openRouterModels: "openrouter_models.json",
	/** 存放 Cline 的 MCP 设置文件 */
	mcpSettings: "cline_mcp_settings.json",
	clineRules: ".clinerules",
}
