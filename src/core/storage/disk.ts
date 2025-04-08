import * as path from "path"
import * as vscode from "vscode"
import fs from "fs/promises"
import { Anthropic } from "@anthropic-ai/sdk"
import { fileExistsAtPath } from "../../utils/fs"
import { ClineMessage } from "../../shared/ExtensionMessage"

export interface FileMetadataEntry {
	path: string
	record_state: "active" | "stale"
	record_source: "read_tool" | "user_edited" | "cline_edited" | "file_mentioned"
	cline_read_date: number | null
	cline_edit_date: number | null
	user_edit_date?: number | null
}

export interface TaskMetadata {
	files_in_context: FileMetadataEntry[]
}

/**
 * Cline 的全局文件名
 * 1. 在 Windows 上，`context.globalStorageUri.fsPath` 为：
 * `C:\Users\<你的用户名>\AppData\Roaming\Code\User\globalStorage\<发布者名称>.<扩展名>`
 * 2. 在 Linux 上，`context.globalStorageUri.fsPath` 为：
 * `/home/<你的用户名>/.config/Code/User/globalStorage/<发布者名称>.<扩展名>`
 *
 * Cline 的<发布者名称>.<扩展名> 为 saoudrizwan.claude-dev
 */
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
	taskMetadata: "task_metadata.json",
}

export async function ensureTaskDirectoryExists(context: vscode.ExtensionContext, taskId: string): Promise<string> {
	const globalStoragePath = context.globalStorageUri.fsPath
	const taskDir = path.join(globalStoragePath, "tasks", taskId)
	await fs.mkdir(taskDir, { recursive: true })
	return taskDir
}

// #region 当前任务的 LLM API 对话历史。
// 【LLM API 对话历史】
// 1. Cline LLM API 对话历史 均以 Anthropic.MessageParam[] 形式记录
// 2. 根据 `attemptApiRequest` 函数，Cline 和 LLM 交互时，将 LLM API 对话历史 发送给 ApiHandler 接口的 `createMessage` 方法
// 3. ApiHandler 接口由各种 LLM 实现，在 `createMessage` 方法中，将 Anthropic.MessageParam[] 形式转为符合自己的格式
//    - 其中 ConvertToO1Messages 和 ConvertToOpenAiMessages 转换方法比较常用
//    - 此外，只实现了 Gemini O1 openai 格式同 anthropic.message 相互转换的方法，但是在实际代码中并未调用这几个方法
// 4. 对于 LLM response，根据 `attemptApiRequest` 函数，Cline 会将 LLM response 转为 Anthropic.MessageParam[] 形式，存入 LLM API 对话历史（ApiConversationHistory 的维护）

/** 从 api_conversation_history.json 读取当前任务的 LLM API 对话历史数组 */
export async function getSavedApiConversationHistory(
	context: vscode.ExtensionContext,
	taskId: string,
): Promise<Anthropic.MessageParam[]> {
	const filePath = path.join(await ensureTaskDirectoryExists(context, taskId), GlobalFileNames.apiConversationHistory)
	const fileExists = await fileExistsAtPath(filePath)
	if (fileExists) {
		return JSON.parse(await fs.readFile(filePath, "utf8"))
	}
	return []
}

/** 保存当前任务的 API 对话历史到 api_conversation_history.json 文件 */
export async function saveApiConversationHistory(
	context: vscode.ExtensionContext,
	taskId: string,
	apiConversationHistory: Anthropic.MessageParam[],
) {
	try {
		const filePath = path.join(await ensureTaskDirectoryExists(context, taskId), GlobalFileNames.apiConversationHistory)
		await fs.writeFile(filePath, JSON.stringify(apiConversationHistory))
	} catch (error) {
		// in the off chance this fails, we don't want to stop the task
		console.error("Failed to save API conversation history:", error)
	}
}
// #endregion



// #region Cline Message 消息数组的维护（用于 webview 呈现），会影响到任务历史 HistoryItem

/** 读取 uiMessages 文件中记录的 Cline Message 数组，只在 `resumeTaskFromHistory()` 中使用  */
export async function getSavedClineMessages(context: vscode.ExtensionContext, taskId: string): Promise<ClineMessage[]> {
	const filePath = path.join(await ensureTaskDirectoryExists(context, taskId), GlobalFileNames.uiMessages)
	if (await fileExistsAtPath(filePath)) {
		return JSON.parse(await fs.readFile(filePath, "utf8"))
	} else {
		// check old location
		const oldPath = path.join(await ensureTaskDirectoryExists(context, taskId), "claude_messages.json")
		if (await fileExistsAtPath(oldPath)) {
			const data = JSON.parse(await fs.readFile(oldPath, "utf8"))
			await fs.unlink(oldPath) // remove old file
			return data
		}
	}
	return []
}

/**
 * 将参数中的 Cline Message 数组保存到 uiMessages 文件中
 */
export async function saveClineMessages(context: vscode.ExtensionContext, taskId: string, uiMessages: ClineMessage[]) {
	try {
		const taskDir = await ensureTaskDirectoryExists(context, taskId)
		const filePath = path.join(taskDir, GlobalFileNames.uiMessages)
		await fs.writeFile(filePath, JSON.stringify(uiMessages))
	} catch (error) {
		console.error("Failed to save ui messages:", error)
	}
}
// #endregion


export async function getTaskMetadata(context: vscode.ExtensionContext, taskId: string): Promise<TaskMetadata> {
	const filePath = path.join(await ensureTaskDirectoryExists(context, taskId), GlobalFileNames.taskMetadata)
	try {
		if (await fileExistsAtPath(filePath)) {
			return JSON.parse(await fs.readFile(filePath, "utf8"))
		}
	} catch (error) {
		console.error("Failed to read task metadata:", error)
	}
	return { files_in_context: [] }
}

export async function saveTaskMetadata(context: vscode.ExtensionContext, taskId: string, metadata: TaskMetadata) {
	try {
		const taskDir = await ensureTaskDirectoryExists(context, taskId)
		const filePath = path.join(taskDir, GlobalFileNames.taskMetadata)
		await fs.writeFile(filePath, JSON.stringify(metadata, null, 2))
	} catch (error) {
		console.error("Failed to save task metadata:", error)
	}
}
