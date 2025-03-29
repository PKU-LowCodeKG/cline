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
	apiConversationHistory: "api_conversation_history.json",
	uiMessages: "ui_messages.json",
	openRouterModels: "openrouter_models.json",
	mcpSettings: "cline_mcp_settings.json",
	clineRules: ".clinerules",
}
