import { Anthropic } from "@anthropic-ai/sdk"
import axios from "axios"
import fs from "fs/promises"
import os from "os"
import crypto from "crypto"
import { execa } from "execa"
import pWaitFor from "p-wait-for"
import * as path from "path"
import * as vscode from "vscode"
import { buildApiHandler } from "../../api"
import { downloadTask } from "../../integrations/misc/export-markdown"
import { openFile, openImage } from "../../integrations/misc/open-file"
import { selectImages } from "../../integrations/misc/process-images"
import { getTheme } from "../../integrations/theme/getTheme"
import WorkspaceTracker from "../../integrations/workspace/WorkspaceTracker"
import { McpHub } from "../../services/mcp/McpHub"
import { McpDownloadResponse, McpMarketplaceCatalog, McpMarketplaceItem, McpServer } from "../../shared/mcp"
import { FirebaseAuthManager, UserInfo } from "../../services/auth/FirebaseAuthManager"
import { ApiProvider, ModelInfo } from "../../shared/api"
import { findLast } from "../../shared/array"
import { ExtensionMessage, ExtensionState, Platform } from "../../shared/ExtensionMessage"
import { HistoryItem } from "../../shared/HistoryItem"
import { ClineCheckpointRestore, WebviewMessage } from "../../shared/WebviewMessage"
import { fileExistsAtPath } from "../../utils/fs"
import { Cline } from "../Cline"
import { openMention } from "../mentions"
import { getNonce } from "./getNonce"
import { getUri } from "./getUri"
import { AutoApprovalSettings, DEFAULT_AUTO_APPROVAL_SETTINGS } from "../../shared/AutoApprovalSettings"
import { BrowserSettings, DEFAULT_BROWSER_SETTINGS } from "../../shared/BrowserSettings"
import { ChatSettings, DEFAULT_CHAT_SETTINGS } from "../../shared/ChatSettings"
import { DIFF_VIEW_URI_SCHEME } from "../../integrations/editor/DiffViewProvider"
import { searchCommits } from "../../utils/git"
import { ChatContent } from "../../shared/ChatContent"

/*
https://github.com/microsoft/vscode-webview-ui-toolkit-samples/blob/main/default/weather-webview/src/providers/WeatherViewProvider.ts

https://github.com/KumarVariable/vscode-extension-sidebar-html/blob/master/src/customSidebarViewProvider.ts
*/
/**
 * `vscode.ExtensionContext.secrets` 是 SecretStorage 接口类型的实例，它允许扩展开发者 存储和检索敏感信息。
 * SecretKey 是 Cline 定义的敏感信息 key 的类型。
 */
/**
 * 定义了一系列敏感信息的键名，用于标识不同的API密钥或认证令牌。
 * 这些密钥在系统配置和请求认证中被使用。
 */
type SecretKey =
	| "apiKey"
	| "openRouterApiKey"
	| "awsAccessKey"
	| "awsSecretKey"
	| "awsSessionToken"
	| "openAiApiKey"
	| "geminiApiKey"
	| "openAiNativeApiKey"
	| "deepSeekApiKey"
	| "requestyApiKey"
	| "togetherApiKey"
	| "qwenApiKey"
	| "mistralApiKey"
	| "liteLlmApiKey"
	| "authToken"
	| "authNonce"
/**
 * 定义了全局状态的键名集合，用于标识系统配置中的各项设置。
 * 这些键名涵盖了API提供商、模型ID、区域设置等配置项。
 */
type GlobalStateKey =
	| "apiProvider"
	| "apiModelId"
	| "awsRegion"
	| "awsUseCrossRegionInference"
	| "awsProfile"
	| "awsUseProfile"
	| "vertexProjectId"
	| "vertexRegion"
	| "lastShownAnnouncementId"
	| "customInstructions"
	| "taskHistory"
	| "openAiBaseUrl"
	| "openAiModelId"
	| "openAiModelInfo"
	| "ollamaModelId"
	| "ollamaBaseUrl"
	| "lmStudioModelId"
	| "lmStudioBaseUrl"
	| "anthropicBaseUrl"
	| "azureApiVersion"
	| "openRouterModelId"
	| "openRouterModelInfo"
	| "autoApprovalSettings"
	| "browserSettings"
	| "chatSettings"
	| "vsCodeLmModelSelector"
	| "userInfo"
	| "previousModeApiProvider"
	| "previousModeModelId"
	| "previousModeModelInfo"
	| "liteLlmBaseUrl"
	| "liteLlmModelId"
	| "qwenApiLine"
	| "requestyModelId"
	| "togetherModelId"
	| "mcpMarketplaceCatalog"

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
}

/**
 * ClineProvider 实现了 vscode.WebviewViewProvider 接口，是 Cline 前后端服务的桥梁：
 * 1. 创建插件的 Webview 视图。
 * 2. 管理 Cline 实例的状态（只会存在一个）
 * 3. 维护 Cline 与 Webview 之间的通信。
 *
 * 在插件启动时创建一个 ClineProvider 实例，并在插件关闭时销毁该实例。
 *
 * 通过 ClineProvider 实例，可以用两种方式创建一个 Cline 实例作为其私有属性，用于处理用户的任务请求。
 */
export class ClineProvider implements vscode.WebviewViewProvider {
	// 静态只读属性 用于标识试图和面板
	public static readonly sideBarId = "claude-dev.SidebarProvider" // used in package.json as the view's id. This value cannot be changed due to how vscode caches views based on their id, and updating the id would break existing instances of the extension.
	public static readonly tabPanelId = "claude-dev.TabPanelProvider"
	/** ClineProvider 类的静态属性集合，用于存储所有已经创造的 ClineProvider 实例 */
	// 静态集合 用于标识当前活动实例
	private static activeInstances: Set<ClineProvider> = new Set()
	// 数组 用于存储当前的可释放资源
	private disposables: vscode.Disposable[] = []
	// view和cline为可选属性 分别表示webview视图和Cline对象 指的是可以为undefined
	private view?: vscode.WebviewView | vscode.WebviewPanel
	private cline?: Cline
	// workspaceTracker和mcpHub为可选属性 分别表示工作区跟踪器与MCP中心
	workspaceTracker?: WorkspaceTracker
	mcpHub?: McpHub
	// authManager表示认证管理器
	private authManager: FirebaseAuthManager
	// latestAnnouncementId表示最新公告的标识符
	private latestAnnouncementId = "feb-18-2025" // update to some unique identifier when we add a new announcement

	/**
	 * 构造函数用于初始化ClineProvider实例及其核心组件
	 * 初始化时，向输出通道添加一条日志，将当前实例添加到活动实例集合中，并创建 WorkspaceTracker、McpHub 和 FirebaseAuthManager 实例。
	 * @param context 扩展的上下文，用于访问扩展的状态和资源
	 * @param outputChannel 输出通道，用于显示消息和日志
	 */
	constructor(
		// VSCode 插件上下文
		readonly context: vscode.ExtensionContext,
		// 使用 outputChannel 来输出调试信息
		private readonly outputChannel: vscode.OutputChannel,
	) {
		// 当ClineProvider实例被创建时，向输出通道追加一条消息
		this.outputChannel.appendLine("ClineProvider instantiated")
		// 将当前实例添加到活跃实例的集合中，以便于管理和追踪
		ClineProvider.activeInstances.add(this)
		// 初始化WorkspaceTracker，用于跟踪工作区的状态和变化
		this.workspaceTracker = new WorkspaceTracker(this)
		// 初始化McpHub，用于处理与MCP（Microservice Communication Protocol）相关的操作
		this.mcpHub = new McpHub(this)
		// 初始化FirebaseAuthManager，用于处理Firebase身份验证相关的操作
		this.authManager = new FirebaseAuthManager(this)
	}

	/*
	VSCode extensions use the disposable pattern to clean up resources when the sidebar/editor tab is closed by the user or system. This applies to event listening, commands, interacting with the UI, etc.
	- https://vscode-docs.readthedocs.io/en/stable/extensions/patterns-and-principles/
	- https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
	*/
	/**
	 * 释放资源，当用户或系统关闭侧边栏/编辑器标签时调用。
	 * VSCode 扩展使用可处置模式来清理资源，确保在不再需要时及时释放资源，防止内存泄漏并确保扩展正常运行。
	 * 此方法会释放各种资源和事件监听器。
	 */
	async dispose() {
		// 记录开始释放 ClineProvider 的日志
		this.outputChannel.appendLine("Disposing ClineProvider...")

		// 清除任务并记录日志 调用 clearTask 方法
		await this.clearTask()
		this.outputChannel.appendLine("Cleared task")

		// 如果存在视图并且视图有 dispose 方法，则释放视图资源并记录日志
		if (this.view && "dispose" in this.view) {
			this.view.dispose()
			this.outputChannel.appendLine("Disposed webview")
		}
		// 遍历并释放所有可处置对象
		while (this.disposables.length) {
			const x = this.disposables.pop()
			if (x) {
				x.dispose()
			}
		}
		// 释放工作区跟踪器并设置为 undefined
		this.workspaceTracker?.dispose()
		this.workspaceTracker = undefined

		// 释放 mcpHub 并设置为 undefined
		this.mcpHub?.dispose()
		this.mcpHub = undefined

		// 释放身份验证管理器
		this.authManager.dispose()

		// 记录所有资源已释放的日志
		this.outputChannel.appendLine("Disposed all disposables")

		// 从活动实例集合中删除当前实例
		ClineProvider.activeInstances.delete(this)
	}

	// 处理用户登出的方法
	async handleSignOut() {
		try {
			// 调用authManager的signOut方法进行登出操作
			await this.authManager.signOut()
			// 显示登出成功的提示信息
			vscode.window.showInformationMessage("Successfully logged out of Cline")
		} catch (error) {
			// 如果登出失败，显示错误信息
			vscode.window.showErrorMessage("Logout failed")
		}
	}
	/**
	 * 以 "authToken" 为 key，将认证令牌存储到安全存储 SecretStorage 中
	 * @param {string} [token] - 可选参数，表示要存储的认证令牌。如果未提供，则存储 `undefined`。
	 */
	async setAuthToken(token?: string) {
		await this.storeSecret("authToken", token)
	}
	/**
	 * 以 "userInfo" 为 key，设置并更新全局状态的用户信息。
	 *
	 * 该函数接收一个可选的用户信息对象，并将其更新到全局状态中。用户信息对象包含以下可选属性：
	 * - displayName: 用户的显示名称，类型为字符串或null。
	 * - email: 用户的电子邮件地址，类型为字符串或null。
	 * - photoURL: 用户的头像URL，类型为字符串或null。
	 *
	 * @param info - 可选参数，包含用户信息的对象。如果未提供，则全局状态中的用户信息将被更新为undefined。
	 */
	async setUserInfo(info?: { displayName: string | null; email: string | null; photoURL: string | null }) {
		await this.updateGlobalState("userInfo", info)
	}
	/**
	 * 获取当前可见的 ClineProvider 实例。
	 * 该函数会遍历所有活动的 ClineProvider 实例，并返回最后一个可见的实例。 快速定位当前可见的实例。
	 * 如果没有可见的实例，则返回 undefined。
	 * @returns {ClineProvider | undefined} 返回最后一个可见的 ClineProvider 实例，如果没有可见实例则返回 undefined。
	 */
	public static getVisibleInstance(): ClineProvider | undefined {
		// 从 activeInstances 中查找最后一个可见的实例
		return findLast(Array.from(this.activeInstances), (instance) => instance.view?.visible === true)
	}
	/**
	 * 【主线】解析和配置 VSCode 的 Webview 视图。
	 * 主要功能包括：设置 Webview 的选项和 HTML 内容、监听消息、处理视图可见性变化、监听视图关闭事件、监听主题颜色变化、清除任务状态。
	 * @param webviewView
	 */
	resolveWebviewView(
		// 表示一个 Webview 视图或面板
		webviewView: vscode.WebviewView | vscode.WebviewPanel,
		//context: vscode.WebviewViewResolveContext<unknown>, used to recreate a deallocated webview, but we don't need this since we use retainContextWhenHidden
		//token: vscode.CancellationToken
	): void | Thenable<void> {
		// 在输出通道中记录正在解析 webview 视图
		this.outputChannel.appendLine("Resolving webview view")
		this.view = webviewView

		// 设置 webview 的选项，允许脚本运行，并指定本地资源根目录
		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,
			// NOTE: 定义允许从本地文件系统加载资源的根目录列表。这些资源将被注入到 Webview 的内容中。
			localResourceRoots: [this.context.extensionUri],
		}

		// 设置 webview 的 HTML 内容
		webviewView.webview.html = this.getHtmlContent(webviewView.webview)

		// Sets up an event listener to listen for messages passed from the webview view context
		// and executes code based on the message that is received
		// 设置事件监听器，监听从 webview 视图上下文传递过来的消息，并根据接收到的消息执行代码
		this.setWebviewMessageListener(webviewView.webview)

		// Logs show up in bottom panel > Debug Console
		//console.log("registering listener")

		// Listen for when the panel becomes visible
		// https://github.com/microsoft/vscode-discussions/discussions/840
		// WebviewView 和 WebviewPanel 具有相同的属性，除了这个可见性监听器
		if ("onDidChangeViewState" in webviewView) {
			// 可以在编辑器区域或作为一个独立的浮动窗口显示，可拖拽
			webviewView.onDidChangeViewState(
				() => {
					if (this.view?.visible) {
						this.postMessageToWebview({
							type: "action",
							action: "didBecomeVisible",
						})
					}
				},
				null,
				this.disposables,
			)
		} else if ("onDidChangeVisibility" in webviewView) {
			// 侧边栏或底部面板
			webviewView.onDidChangeVisibility(
				() => {
					if (this.view?.visible) {
						this.postMessageToWebview({
							type: "action",
							action: "didBecomeVisible",
						})
					}
				},
				null,
				this.disposables,
			)
		}

		// Listen for when the view is disposed
		// This happens when the user closes the view or when the view is closed programmatically
		// 监听视图被释放的事件，当用户关闭视图或视图被程序关闭时触发
		webviewView.onDidDispose(
			async () => {
				await this.dispose()
			},
			null,
			this.disposables,
		)

		// Listen for when color changes
		// 监听主题颜色配置变化的事件
		vscode.workspace.onDidChangeConfiguration(
			async (e) => {
				if (e && e.affectsConfiguration("workbench.colorTheme")) {
					// Sends latest theme name to webview
					// 将最新的主题名称发送到webview
					await this.postMessageToWebview({
						type: "theme",
						text: JSON.stringify(await getTheme()),
					})
				}
			},
			null,
			this.disposables,
		)

		// if the extension is starting a new session, clear previous task state
		// 如果扩展正在启动新会话，清除之前的任务状态
		this.clearTask()

		this.outputChannel.appendLine("Webview view resolved")
	}
	/**
	 * 【主线】使用指定的任务和可选的图片初始化客户端。
	 * 该函数确保在启动新任务之前清除任何现有任务，然后获取必要的状态以创建新的 `Cline` 实例。
	 * @param {string} [task] - 要初始化的任务。这是一个可选参数，如果未提供，则不设置任务。
	 * @param {string[]} [images] - 与任务相关的图片数组。这是一个可选参数，如果未提供，则不设置图片。
	 */
	async initClineWithTask(task?: string, images?: string[]) {
		// 清除现有任务，确保在启动新任务之前没有任务存在
		await this.clearTask() // ensures that an existing task doesn't exist before starting a new one, although this shouldn't be possible since user must clear task before starting a new one
		// 获取当前状态，包括 API 配置、自定义指令、自动批准设置、浏览器设置和聊天设置
		const { apiConfiguration, customInstructions, autoApprovalSettings, browserSettings, chatSettings } =
			await this.getState()
		// 使用获取的状态和参数创建新的 `Cline` 实例
		this.cline = new Cline(
			this,
			apiConfiguration,
			autoApprovalSettings,
			browserSettings,
			chatSettings,
			customInstructions,
			task,
			images,
		)
	}
	/**
	 * 【主线】初始化带有历史项的 Cline 实例。
	 * 该函数首先清除当前任务，然后从状态中获取配置和设置，最后使用这些配置和设置以及传入的历史项创建一个新的 Cline 实例，用于恢复之前的任务。
	 * @param historyItem - 历史项，用于初始化 Cline 实例时传递。
	 */
	async initClineWithHistoryItem(historyItem: HistoryItem) {
		// 清除当前任务，确保在初始化新实例之前没有遗留的任务。
		await this.clearTask()
		const { apiConfiguration, customInstructions, autoApprovalSettings, browserSettings, chatSettings } =
			await this.getState()

		// 使用获取的配置和设置以及传入的历史项初始化一个新的 Cline 实例。
		this.cline = new Cline(
			this,
			apiConfiguration,
			autoApprovalSettings,
			browserSettings,
			chatSettings,
			customInstructions,
			undefined,
			undefined,
			historyItem,
		)
	}

	// Send any JSON serializable data to the react app
	/**
	 * 向与当前视图关联的 Webview 发送一个可序列化为 JSON 的消息。
	 * 1. 前端需要监听 "message" 事件
	 * 2. 消息是异步发送的，确保不会阻塞主线程。
	 * @param message 要发送的消息，必须是一个可序列化为 JSON 的对象。
	 * @returns 返回一个 Promise，表示消息发送的异步操作。
	 */
	async postMessageToWebview(message: ExtensionMessage) {
		await this.view?.webview.postMessage(message)
	}

	/**
	 * NOTE: 定义并返回应该在插件的 webview 面板中渲染的 HTML 内容。
	 * 创建对 React Webview 构建文件的引用，并将其插入到 Webview 的 HTML 中。
	 *
	 * Defines and returns the HTML that should be rendered within the webview panel.
	 *
	 * @remarks This is also the place where references to the React webview build files
	 * are created and inserted into the webview HTML.
	 *
	 * @param webview A reference to the extension webview
	 * @param extensionUri The URI of the directory containing the extension
	 * @returns A template string literal containing the HTML that should be
	 * rendered within the webview panel
	 */
	private getHtmlContent(webview: vscode.Webview): string {
		// Get the local path to main script run in the webview,
		// then convert it to a uri we can use in the webview.

		// The CSS file from the React build output
		// 获取在 Webview 中运行的主脚本的本地路径，并将其转换为可在 Webview 中使用的 URI。

		// 从 React 构建输出中获取 CSS 文件
		const stylesUri = getUri(webview, this.context.extensionUri, ["webview-ui", "build", "static", "css", "main.css"])
		// The JS file from the React build output
		// 从 React 构建输出中获取 JS 文件
		const scriptUri = getUri(webview, this.context.extensionUri, ["webview-ui", "build", "static", "js", "main.js"])

		// The codicon font from the React build output
		// https://github.com/microsoft/vscode-extension-samples/blob/main/webview-codicons-sample/src/extension.ts
		// we installed this package in the extension so that we can access it how its intended from the extension (the font file is likely bundled in vscode), and we just import the css fileinto our react app we don't have access to it
		// don't forget to add font-src ${webview.cspSource};
		// 从 React 构建输出中获取 Codicon 字体
		// 我们已在扩展中安装此包，以便从扩展中访问它（字体文件可能已捆绑在 VSCode 中），
		// 我们只需将 CSS 文件导入到 React 应用中即可
		const codiconsUri = getUri(webview, this.context.extensionUri, [
			"node_modules",
			"@vscode",
			"codicons",
			"dist",
			"codicon.css",
		])

		// const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "assets", "main.js"))

		// const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "assets", "reset.css"))
		// const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "assets", "vscode.css"))

		// // Same for stylesheet
		// const stylesheetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "assets", "main.css"))

		// Use a nonce to only allow a specific script to be run.
		/*
        content security policy of your webview to only allow scripts that have a specific nonce
        create a content security policy meta tag so that only loading scripts with a nonce is allowed
        As your extension grows you will likely want to add custom styles, fonts, and/or images to your webview. If you do, you will need to update the content security policy meta tag to explicity allow for these resources. E.g.
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}';">
		- 'unsafe-inline' is required for styles due to vscode-webview-toolkit's dynamic style injection
		- since we pass base64 images to the webview, we need to specify img-src ${webview.cspSource} data:;

        in meta tag we add nonce attribute: A cryptographic nonce (only used once) to allow scripts. The server must generate a unique nonce value each time it transmits a policy. It is critical to provide a nonce that cannot be guessed as bypassing a resource's policy is otherwise trivial.
        */
		// 使用 nonce 来限制只允许运行特定的脚本
		const nonce = getNonce()

		// Tip: Install the es6-string-html VS Code extension to enable code highlighting below
		// 返回 HTML 模板字符串
		return /*html*/ `
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
            <meta name="theme-color" content="#000000">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}';">
            <link rel="stylesheet" type="text/css" href="${stylesUri}">
			<link href="${codiconsUri}" rel="stylesheet" />
            <title>Cline</title>
          </head>
          <body>
            <noscript>You need to enable JavaScript to run this app.</noscript>
            <div id="root"></div>
            <script nonce="${nonce}" src="${scriptUri}"></script>
          </body>
        </html>
      `
	}

	/**
	 * 【主线】设置一个事件侦听器来侦听从 webview 上下文传递的消息，并根据收到的消息执行代码。
	 * 其实就是把 `webview.onDidReceiveMessage()` 封装了一层
	 *
	 * Sets up an event listener to listen for messages passed from the webview context and
	 * executes code based on the message that is received.
	 *
	 * @param webview A reference to the extension webview
	 */
	private setWebviewMessageListener(webview: vscode.Webview) {
		webview.onDidReceiveMessage(
			async (message: WebviewMessage) => {
				switch (message.type) {
					/** /src/shared/WebviewMessage.ts 中的 WebviewMessage.type */
					case "webviewDidLaunch":
						// Webview 启动时，发送状态信息到 Webview
						this.postStateToWebview()
						// 填充文件路径（不等待完成）
						this.workspaceTracker?.populateFilePaths() // don't await
						// 获取当前主题并发送到 Webview
						getTheme().then((theme) =>
							this.postMessageToWebview({
								type: "theme",
								text: JSON.stringify(theme),
							}),
						)
						// post last cached models in case the call to endpoint fails
						// 发送缓存的 OpenRouter 模型信息
						this.readOpenRouterModels().then((openRouterModels) => {
							if (openRouterModels) {
								this.postMessageToWebview({
									type: "openRouterModels",
									openRouterModels,
								})
							}
						})
						// gui relies on model info to be up-to-date to provide the most accurate pricing, so we need to fetch the latest details on launch.
						// we do this for all users since many users switch between api providers and if they were to switch back to openrouter it would be showing outdated model info if we hadn't retrieved the latest at this point
						// (see normalizeApiConfiguration > openrouter)
						// Prefetch marketplace and OpenRouter models

						this.getGlobalState("mcpMarketplaceCatalog").then((mcpMarketplaceCatalog) => {
							if (mcpMarketplaceCatalog) {
								this.postMessageToWebview({
									type: "mcpMarketplaceCatalog",
									mcpMarketplaceCatalog: mcpMarketplaceCatalog as McpMarketplaceCatalog,
								})
							}
						})
						this.silentlyRefreshMcpMarketplace()
						this.refreshOpenRouterModels().then(async (openRouterModels) => {
							if (openRouterModels) {
								// update model info in state (this needs to be done here since we don't want to update state while settings is open, and we may refresh models there)
								const { apiConfiguration } = await this.getState()
								if (apiConfiguration.openRouterModelId) {
									await this.updateGlobalState(
										"openRouterModelInfo",
										openRouterModels[apiConfiguration.openRouterModelId],
									)
									await this.postStateToWebview()
								}
							}
						})

						break
					// 【主线】前端发送的消息类型为 "newTask" 时，初始化新的任务
					case "newTask":
						// Code that should run in response to the hello message command
						//vscode.window.showInformationMessage(message.text!)

						// Send a message to our webview.
						// You can send any JSON serializable data.
						// Could also do this in extension .ts
						//this.postMessageToWebview({ type: "text", text: `Extension: ${Date.now()}` })
						// initializing new instance of Cline will make sure that any agentically running promises in old instance don't affect our new task. this essentially creates a fresh slate for the new task
						// 初始化一个新的 Cline 实例以处理新任务
						await this.initClineWithTask(message.text, message.images)
						break
					case "apiConfiguration":
						// 更新 API 配置
						if (message.apiConfiguration) {
							const {
								apiProvider,
								apiModelId,
								apiKey,
								openRouterApiKey,
								awsAccessKey,
								awsSecretKey,
								awsSessionToken,
								awsRegion,
								awsUseCrossRegionInference,
								awsProfile,
								awsUseProfile,
								vertexProjectId,
								vertexRegion,
								openAiBaseUrl,
								openAiApiKey,
								openAiModelId,
								openAiModelInfo,
								ollamaModelId,
								ollamaBaseUrl,
								lmStudioModelId,
								lmStudioBaseUrl,
								anthropicBaseUrl,
								geminiApiKey,
								openAiNativeApiKey,
								deepSeekApiKey,
								requestyApiKey,
								requestyModelId,
								togetherApiKey,
								togetherModelId,
								qwenApiKey,
								mistralApiKey,
								azureApiVersion,
								openRouterModelId,
								openRouterModelInfo,
								vsCodeLmModelSelector,
								liteLlmBaseUrl,
								liteLlmModelId,
								liteLlmApiKey,
								qwenApiLine,
							} = message.apiConfiguration
							// 更新全局状态和密钥
							await this.updateGlobalState("apiProvider", apiProvider)
							await this.updateGlobalState("apiModelId", apiModelId)
							await this.storeSecret("apiKey", apiKey)
							await this.storeSecret("openRouterApiKey", openRouterApiKey)
							await this.storeSecret("awsAccessKey", awsAccessKey)
							await this.storeSecret("awsSecretKey", awsSecretKey)
							await this.storeSecret("awsSessionToken", awsSessionToken)
							await this.updateGlobalState("awsRegion", awsRegion)
							await this.updateGlobalState("awsUseCrossRegionInference", awsUseCrossRegionInference)
							await this.updateGlobalState("awsProfile", awsProfile)
							await this.updateGlobalState("awsUseProfile", awsUseProfile)
							await this.updateGlobalState("vertexProjectId", vertexProjectId)
							await this.updateGlobalState("vertexRegion", vertexRegion)
							await this.updateGlobalState("openAiBaseUrl", openAiBaseUrl)
							await this.storeSecret("openAiApiKey", openAiApiKey)
							await this.updateGlobalState("openAiModelId", openAiModelId)
							await this.updateGlobalState("openAiModelInfo", openAiModelInfo)
							await this.updateGlobalState("ollamaModelId", ollamaModelId)
							await this.updateGlobalState("ollamaBaseUrl", ollamaBaseUrl)
							await this.updateGlobalState("lmStudioModelId", lmStudioModelId)
							await this.updateGlobalState("lmStudioBaseUrl", lmStudioBaseUrl)
							await this.updateGlobalState("anthropicBaseUrl", anthropicBaseUrl)
							await this.storeSecret("geminiApiKey", geminiApiKey)
							await this.storeSecret("openAiNativeApiKey", openAiNativeApiKey)
							await this.storeSecret("deepSeekApiKey", deepSeekApiKey)
							await this.storeSecret("requestyApiKey", requestyApiKey)
							await this.storeSecret("togetherApiKey", togetherApiKey)
							await this.storeSecret("qwenApiKey", qwenApiKey)
							await this.storeSecret("mistralApiKey", mistralApiKey)
							await this.storeSecret("liteLlmApiKey", liteLlmApiKey)
							await this.updateGlobalState("azureApiVersion", azureApiVersion)
							await this.updateGlobalState("openRouterModelId", openRouterModelId)
							await this.updateGlobalState("openRouterModelInfo", openRouterModelInfo)
							await this.updateGlobalState("vsCodeLmModelSelector", vsCodeLmModelSelector)
							await this.updateGlobalState("liteLlmBaseUrl", liteLlmBaseUrl)
							await this.updateGlobalState("liteLlmModelId", liteLlmModelId)
							await this.updateGlobalState("qwenApiLine", qwenApiLine)
							await this.updateGlobalState("requestyModelId", requestyModelId)
							await this.updateGlobalState("togetherModelId", togetherModelId)
							// 更新 Cline 实例的 API 处理器
							if (this.cline) {
								this.cline.api = buildApiHandler(message.apiConfiguration)
							}
						}
						await this.postStateToWebview()
						break
					case "customInstructions":
						// 更新自定义指令
						await this.updateCustomInstructions(message.text)
						break
					case "autoApprovalSettings":
						// 更新自动批准设置
						if (message.autoApprovalSettings) {
							await this.updateGlobalState("autoApprovalSettings", message.autoApprovalSettings)
							if (this.cline) {
								this.cline.autoApprovalSettings = message.autoApprovalSettings
							}
							await this.postStateToWebview()
						}
						break
					case "browserSettings":
						// 更新浏览器设置
						if (message.browserSettings) {
							await this.updateGlobalState("browserSettings", message.browserSettings)
							if (this.cline) {
								this.cline.updateBrowserSettings(message.browserSettings)
							}
							await this.postStateToWebview()
						}
						break
					case "togglePlanActMode":
						if (message.chatSettings) {
							await this.togglePlanActModeWithChatSettings(message.chatSettings, message.chatContent)
						}
						break
					// case "relaunchChromeDebugMode":
					// 	if (this.cline) {
					// 		this.cline.browserSession.relaunchChromeDebugMode()
					// 	}
					// 	break
					// 【主线】处理 Webview 的响应消息
					case "askResponse":
						this.cline?.handleWebviewAskResponse(message.askResponse!, message.text, message.images)
						break
					case "clearTask":
						// newTask will start a new task with a given task text, while clear task resets the current session and allows for a new task to be started
						// 清除当前任务，重置会话状态
						await this.clearTask()
						await this.postStateToWebview()
						break
					case "didShowAnnouncement":
						// 更新最后显示的公告 ID
						await this.updateGlobalState("lastShownAnnouncementId", this.latestAnnouncementId)
						await this.postStateToWebview()
						break
					case "selectImages":
						// 选择图片并发送到 Webview
						const images = await selectImages()
						await this.postMessageToWebview({
							type: "selectedImages",
							images,
						})
						break
					case "exportCurrentTask":
						// 导出当前任务
						// ?. 可选连接符
						const currentTaskId = this.cline?.taskId
						if (currentTaskId) {
							this.exportTaskWithId(currentTaskId)
						}
						break
					// 【主线】根据任务id 显示历史任务
					case "showTaskWithId":
						// 显示指定 ID 的任务 !为非空断言符
						this.showTaskWithId(message.text!)
						break
					case "deleteTaskWithId":
						// 删除指定 ID 的任务
						this.deleteTaskWithId(message.text!)
						break
					case "exportTaskWithId":
						// 导出指定 ID 的任务
						this.exportTaskWithId(message.text!)
						break
					case "resetState":
						// 重置全局状态
						await this.resetState()
						break
					case "requestOllamaModels":
						// 获取 Ollama 模型列表并发送到 Webview
						const ollamaModels = await this.getOllamaModels(message.text)
						this.postMessageToWebview({
							type: "ollamaModels",
							ollamaModels,
						})
						break
					case "requestLmStudioModels":
						// 获取 LM Studio 模型列表并发送到 Webview
						const lmStudioModels = await this.getLmStudioModels(message.text)
						this.postMessageToWebview({
							type: "lmStudioModels",
							lmStudioModels,
						})
						break
					case "requestVsCodeLmModels":
						// 获取 VSCode LM 模型列表并发送到 Webview
						const vsCodeLmModels = await this.getVsCodeLmModels()
						this.postMessageToWebview({ type: "vsCodeLmModels", vsCodeLmModels })
						break
					case "refreshOpenRouterModels":
						// 刷新 OpenRouter 模型列表
						await this.refreshOpenRouterModels()
						break
					case "refreshOpenAiModels":
						// 刷新 OpenAI 模型列表并发送到 Webview
						const { apiConfiguration } = await this.getState()
						const openAiModels = await this.getOpenAiModels(
							apiConfiguration.openAiBaseUrl,
							apiConfiguration.openAiApiKey,
						)
						this.postMessageToWebview({ type: "openAiModels", openAiModels })
						break
					case "openImage":
						// 打开指定路径的图片
						openImage(message.text!)
						break
					case "openFile":
						// 打开指定路径的文件
						openFile(message.text!)
						break
					case "openMention":
						// 打开提及的内容
						openMention(message.text)
						break
					case "checkpointDiff": {
						// 显示指定检查点的文件差异
						if (message.number) {
							await this.cline?.presentMultifileDiff(message.number, false)
						}
						break
					}
					case "checkpointRestore": {
						// 恢复到指定检查点
						// 取消当前任务，避免任务状态冲突
						await this.cancelTask() // we cannot alter message history say if the task is active, as it could be in the middle of editing a file or running a command, which expect the ask to be responded to rather than being superceded by a new message eg add deleted_api_reqs
						// cancel task waits for any open editor to be reverted and starts a new cline instance
						if (message.number) {
							// wait for messages to be loaded
							// 等待 Cline 实例初始化
							await pWaitFor(() => this.cline?.isInitialized === true, {
								timeout: 3_000,
							}).catch(() => {
								console.error("Failed to init new cline instance")
							})
							// NOTE: cancelTask awaits abortTask, which awaits diffViewProvider.revertChanges, which reverts any edited files, allowing us to reset to a checkpoint rather than running into a state where the revertChanges function is called alongside or after the checkpoint reset
							// 恢复到指定检查点
							await this.cline?.restoreCheckpoint(message.number, message.text! as ClineCheckpointRestore)
						}
						break
					}
					case "taskCompletionViewChanges": {
						// 显示任务完成后的文件差异
						if (message.number) {
							await this.cline?.presentMultifileDiff(message.number, true)
						}
						break
					}
					case "cancelTask":
						// 取消当前任务
						this.cancelTask()
						break
					case "getLatestState":
						// 获取并发送最新状态到 Webview
						await this.postStateToWebview()
						break
					case "subscribeEmail":
						// 处理邮箱订阅
						this.subscribeEmail(message.text)
						break
					case "accountLoginClicked": {
						// 处理账户登录点击事件
						// Generate nonce for state validation
						const nonce = crypto.randomBytes(32).toString("hex")
						await this.storeSecret("authNonce", nonce)

						// Open browser for authentication with state param
						// 打开浏览器进行身份验证
						console.log("Login button clicked in account page")
						console.log("Opening auth page with state param")

						const uriScheme = vscode.env.uriScheme

						const authUrl = vscode.Uri.parse(
							`https://app.cline.bot/auth?state=${encodeURIComponent(nonce)}&callback_url=${encodeURIComponent(`${uriScheme || "vscode"}://saoudrizwan.claude-dev/auth`)}`,
						)
						vscode.env.openExternal(authUrl)
						break
					}
					case "accountLogoutClicked": {
						// 处理账户登出点击事件
						await this.handleSignOut()
						break
					}
					case "showMcpView": {
						await this.postMessageToWebview({ type: "action", action: "mcpButtonClicked" })
						break
					}
					case "openMcpSettings": {
						// 打开 MCP 设置文件
						const mcpSettingsFilePath = await this.mcpHub?.getMcpSettingsFilePath()
						if (mcpSettingsFilePath) {
							openFile(mcpSettingsFilePath)
						}
						break
					}
					case "fetchMcpMarketplace": {
						await this.fetchMcpMarketplace(message.bool)
						break
					}
					case "downloadMcp": {
						if (message.mcpId) {
							// 1. Toggle to act mode if we are in plan mode
							const { chatSettings } = await this.getStateToPostToWebview()
							if (chatSettings.mode === "plan") {
								await this.togglePlanActModeWithChatSettings({ mode: "act" })
							}

							// 2. Enable MCP settings if disabled
							// Enable MCP mode if disabled
							const mcpConfig = vscode.workspace.getConfiguration("cline.mcp")
							if (mcpConfig.get<string>("mode") !== "full") {
								await mcpConfig.update("mode", "full", true)
							}

							// 3. download MCP
							await this.downloadMcp(message.mcpId)
						}
						break
					}
					case "silentlyRefreshMcpMarketplace": {
						await this.silentlyRefreshMcpMarketplace()
						break
					}
					// case "openMcpMarketplaceServerDetails": {
					// 	if (message.text) {
					// 		const response = await fetch(`https://api.cline.bot/v1/mcp/marketplace/item?mcpId=${message.mcpId}`)
					// 		const details: McpDownloadResponse = await response.json()

					// 		if (details.readmeContent) {
					// 			// Disable markdown preview markers
					// 			const config = vscode.workspace.getConfiguration("markdown")
					// 			await config.update("preview.markEditorSelection", false, true)

					// 			// Create URI with base64 encoded markdown content
					// 			const uri = vscode.Uri.parse(
					// 				`${DIFF_VIEW_URI_SCHEME}:${details.name} README?${Buffer.from(details.readmeContent).toString("base64")}`,
					// 			)

					// 			// close existing
					// 			const tabs = vscode.window.tabGroups.all
					// 				.flatMap((tg) => tg.tabs)
					// 				.filter((tab) => tab.label && tab.label.includes("README") && tab.label.includes("Preview"))
					// 			for (const tab of tabs) {
					// 				await vscode.window.tabGroups.close(tab)
					// 			}

					// 			// Show only the preview
					// 			await vscode.commands.executeCommand("markdown.showPreview", uri, {
					// 				sideBySide: true,
					// 				preserveFocus: true,
					// 			})
					// 		}
					// 	}

					// 	this.postMessageToWebview({ type: "relinquishControl" })

					// 	break
					// }
					case "toggleMcpServer": {
						// 切换 MCP 服务器的启用状态
						try {
							await this.mcpHub?.toggleServerDisabled(message.serverName!, message.disabled!)
						} catch (error) {
							console.error(`Failed to toggle MCP server ${message.serverName}:`, error)
						}
						break
					}
					case "toggleToolAutoApprove": {
						// 切换工具的自动批准状态
						try {
							await this.mcpHub?.toggleToolAutoApprove(message.serverName!, message.toolName!, message.autoApprove!)
						} catch (error) {
							console.error(`Failed to toggle auto-approve for tool ${message.toolName}:`, error)
						}
						break
					}
					case "restartMcpServer": {
						// 重启 MCP 服务器
						try {
							await this.mcpHub?.restartConnection(message.text!)
						} catch (error) {
							console.error(`Failed to retry connection for ${message.text}:`, error)
						}
						break
					}
					case "searchCommits": {
						const cwd = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).at(0)
						if (cwd) {
							try {
								const commits = await searchCommits(message.text || "", cwd)
								await this.postMessageToWebview({
									type: "commitSearchResults",
									commits,
								})
							} catch (error) {
								console.error(`Error searching commits: ${JSON.stringify(error)}`)
							}
						}
						break
					}
					case "openExtensionSettings": {
						// 打开扩展设置页面
						const settingsFilter = message.text || ""
						await vscode.commands.executeCommand(
							"workbench.action.openSettings",
							`@ext:saoudrizwan.claude-dev ${settingsFilter}`.trim(), // trim whitespace if no settings filter
						)
						break
					}
					// Add more switch case statements here as more webview message commands
					// are created within the webview context (i.e. inside media/main.js)
				}
			},
			null,
			this.disposables,
		)
	}

	async togglePlanActModeWithChatSettings(chatSettings: ChatSettings, chatContent?: ChatContent) {
		const didSwitchToActMode = chatSettings.mode === "act"

		// Get previous model info that we will revert to after saving current mode api info
		const {
			apiConfiguration,
			previousModeApiProvider: newApiProvider,
			previousModeModelId: newModelId,
			previousModeModelInfo: newModelInfo,
		} = await this.getState()

		// Save the last model used in this mode
		await this.updateGlobalState("previousModeApiProvider", apiConfiguration.apiProvider)
		switch (apiConfiguration.apiProvider) {
			case "anthropic":
			case "bedrock":
			case "vertex":
			case "gemini":
				await this.updateGlobalState("previousModeModelId", apiConfiguration.apiModelId)
				break
			case "openrouter":
				await this.updateGlobalState("previousModeModelId", apiConfiguration.openRouterModelId)
				await this.updateGlobalState("previousModeModelInfo", apiConfiguration.openRouterModelInfo)
				break
			case "vscode-lm":
				await this.updateGlobalState("previousModeModelId", apiConfiguration.vsCodeLmModelSelector)
				break
			case "openai":
				await this.updateGlobalState("previousModeModelId", apiConfiguration.openAiModelId)
				await this.updateGlobalState("previousModeModelInfo", apiConfiguration.openAiModelInfo)
				break
			case "ollama":
				await this.updateGlobalState("previousModeModelId", apiConfiguration.ollamaModelId)
				break
			case "lmstudio":
				await this.updateGlobalState("previousModeModelId", apiConfiguration.lmStudioModelId)
				break
			case "litellm":
				await this.updateGlobalState("previousModeModelId", apiConfiguration.liteLlmModelId)
				break
		}

		// Restore the model used in previous mode
		if (newApiProvider && newModelId) {
			await this.updateGlobalState("apiProvider", newApiProvider)
			switch (newApiProvider) {
				case "anthropic":
				case "bedrock":
				case "vertex":
				case "gemini":
					await this.updateGlobalState("apiModelId", newModelId)
					break
				case "openrouter":
					await this.updateGlobalState("openRouterModelId", newModelId)
					await this.updateGlobalState("openRouterModelInfo", newModelInfo)
					break
				case "vscode-lm":
					await this.updateGlobalState("vsCodeLmModelSelector", newModelId)
					break
				case "openai":
					await this.updateGlobalState("openAiModelId", newModelId)
					await this.updateGlobalState("openAiModelInfo", newModelInfo)
					break
				case "ollama":
					await this.updateGlobalState("ollamaModelId", newModelId)
					break
				case "lmstudio":
					await this.updateGlobalState("lmStudioModelId", newModelId)
					break
				case "litellm":
					await this.updateGlobalState("liteLlmModelId", newModelId)
					break
			}

			if (this.cline) {
				const { apiConfiguration: updatedApiConfiguration } = await this.getState()
				this.cline.api = buildApiHandler(updatedApiConfiguration)
			}
		}

		await this.updateGlobalState("chatSettings", chatSettings)
		await this.postStateToWebview()
		// console.log("chatSettings", message.chatSettings)
		if (this.cline) {
			this.cline.updateChatSettings(chatSettings)
			if (this.cline.isAwaitingPlanResponse && didSwitchToActMode) {
				this.cline.didRespondToPlanAskBySwitchingMode = true
				// this is necessary for the webview to update accordingly, but Cline instance will not send text back as feedback message
				await this.postMessageToWebview({
					type: "invoke",
					invoke: "sendMessage",
					text: chatContent?.message || "PLAN_MODE_TOGGLE_RESPONSE",
					images: chatContent?.images,
				})
			} else {
				this.cancelTask()
			}
		}
	}

	/**
	 * 订阅电子邮件地址到邮件列表。
	 * 该函数首先验证电子邮件地址的格式，如果格式无效，则显示错误消息并返回。
	 * 如果电子邮件地址有效，则将其发送到指定的API端点进行订阅，并通知Webview订阅成功。
	 * 目前忽略API请求的错误，但在未来可能会处理这些错误。
	 * @param {string} [email] - 要订阅的电子邮件地址。如果未提供或为空，则函数直接返回。
	 */
	async subscribeEmail(email?: string) {
		// 如果未提供电子邮件地址，直接返回
		if (!email) {
			return
		}

		// 验证电子邮件地址的格式
		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
		if (!emailRegex.test(email)) {
			vscode.window.showErrorMessage("Please enter a valid email address")
			return
		}

		// 记录订阅的电子邮件地址并通知Webview订阅成功
		console.log("Subscribing email:", email)
		this.postMessageToWebview({ type: "emailSubscribed" })
		// Currently ignoring errors to this endpoint, but after accounts we'll remove this anyways

		// 发送API请求以订阅电子邮件地址
		try {
			const response = await axios.post(
				"https://app.cline.bot/api/mailing-list",
				{
					email: email,
				},
				{
					headers: {
						"Content-Type": "application/json",
					},
				},
			)
			console.log("Email subscribed successfully. Response:", response.data)
		} catch (error) {
			// 记录订阅失败的错误信息
			console.error("Failed to subscribe email:", error)
		}
	}

	/**
	 * 取消当前任务。
	 * 该函数会尝试中止当前正在执行的任务，并确保任务状态被正确清理。
	 * 如果任务正在流式处理中，函数会等待任务优雅地中止，或者超时后强制中止。
	 * 最后，函数会重新初始化任务历史项，以确保任务状态被正确重置。
	 */
	async cancelTask() {
		// 检查当前是否存在任务实例
		if (this.cline) {
			// 获取与当前任务ID相关的历史项
			const { historyItem } = await this.getTaskWithId(this.cline.taskId)
			try {
				// 尝试中止任务
				await this.cline.abortTask()
			} catch (error) {
				// 如果中止任务失败，记录错误日志
				console.error("Failed to abort task", error)
			}
			// 等待任务状态变为可中止状态，或者超时
			await pWaitFor(
				() =>
					this.cline === undefined ||
					this.cline.isStreaming === false ||
					this.cline.didFinishAbortingStream ||
					this.cline.isWaitingForFirstChunk, // 如果只处理了第一个数据块，则无需等待优雅中止// if only first chunk is processed, then there's no need to wait for graceful abort (closes edits, browser, etc)
				{
					timeout: 3_000,
				},
			).catch(() => {
				// 如果等待超时，记录错误日志
				console.error("Failed to abort task")
			})

			// 如果任务实例仍然存在，标记为已放弃，以防止影响后续任务实例的GUI
			if (this.cline) {
				// 'abandoned' will prevent this cline instance from affecting future cline instance gui. this may happen if its hanging on a streaming request
				this.cline.abandoned = true
			}
			// 使用历史项重新初始化任务实例，确保任务状态被正确重置
			/**
			 * 清理任务状态：清除当前任务实例的残留状态或资源。
			 * 保留历史项：使用 historyItem 保留任务的历史数据（如任务ID、配置等），确保重新初始化的任务实例包含必要的信息。
			 * 重置任务环境：为后续操作提供一个干净的任务实例，避免之前的状态影响后续行为。
			 */
			await this.initClineWithHistoryItem(historyItem) // clears task again, so we need to abortTask manually above
			// await this.postStateToWebview() // new Cline instance will post state when it's ready. having this here sent an empty messages array to webview leading to virtuoso having to reload the entire list
		}
	}
	/**
	 * 更新自定义指令。
	 * 该函数用于更新全局状态中的自定义指令，并确保相关的客户端实例（如果存在）也同步更新。
	 * 最后，将更新后的状态发送到Webview。
	 * @param {string} [instructions] - 可选参数，表示新的自定义指令内容。如果未提供或为空字符串，则视为清除自定义指令。
	 */
	async updateCustomInstructions(instructions?: string) {
		// User may be clearing the field
		// 更新全局状态中的自定义指令，如果instructions为空则设置为undefined
		await this.updateGlobalState("customInstructions", instructions || undefined)

		// 如果存在客户端实例，则同步更新其自定义指令
		if (this.cline) {
			this.cline.customInstructions = instructions || undefined
		}
		// 将更新后的状态发送到Webview
		await this.postStateToWebview()
	}

	// MCP

	/**
	 * 获取当前用户的文档目录路径。 只在MCP中用到
	 *
	 * 该函数根据操作系统的不同，返回用户的文档目录路径。在Windows系统上，它会尝试通过PowerShell命令获取
	 * 准确的文档路径。如果获取失败，则回退到默认的 `~/Documents` 路径。在POSIX系统（如macOS、Linux等）
	 * 上，默认返回 `~/Documents` 路径。
	 *
	 * @returns {Promise<string>} 返回一个Promise，解析为用户文档目录的路径。
	 */
	async getDocumentsPath(): Promise<string> {
		if (process.platform === "win32") {
			// If the user is running Win 7/Win Server 2008 r2+, we want to get the correct path to their Documents directory.

			// 在Windows系统上，尝试通过PowerShell命令获取文档路径
			try {
				const { stdout: docsPath } = await execa("powershell", [
					"-NoProfile", // Ignore user's PowerShell profile(s)
					"-Command",
					"[System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::MyDocuments)",
				])
				return docsPath.trim()
			} catch (err) {
				// 如果获取失败，回退到默认的 `~/Documents` 路径
				console.error("Failed to retrieve Windows Documents path. Falling back to homedir/Documents.")
				return path.join(os.homedir(), "Documents")
			}
		} else {
			// 在POSIX系统上，默认返回 `~/Documents` 路径
			return path.join(os.homedir(), "Documents") // On POSIX (macOS, Linux, etc.), assume ~/Documents by default (existing behavior, but may want to implement similar logic here)
		}
	}

	/** 确保 `~/Documents/Cline/MCP` 目录存在。如果目录不存在，则创建该目录。 */
	async ensureMcpServersDirectoryExists(): Promise<string> {
		// 获取用户的文档路径
		const userDocumentsPath = await this.getDocumentsPath()
		// 构建目标目录路径
		const mcpServersDir = path.join(userDocumentsPath, "Cline", "MCP")
		try {
			// 尝试创建目录，recursive: true 确保所有父目录也会被创建
			await fs.mkdir(mcpServersDir, { recursive: true })
		} catch (error) {
			// 如果创建目录失败，返回默认路径
			return "~/Documents/Cline/MCP" // in case creating a directory in documents fails for whatever reason (e.g. permissions) - this is fine since this path is only ever used in the system prompt
		}
		return mcpServersDir
	}

	/**
	 * 确保 [context.globalStorageUri.fsPath]/settings 目录存在。
	 * 如果目录不存在，则递归创建该目录。
	 */
	async ensureSettingsDirectoryExists(): Promise<string> {
		// 拼接 settings 目录的完整路径
		const settingsDir = path.join(this.context.globalStorageUri.fsPath, "settings")
		// 递归创建目录，如果目录已存在则不会抛出错误
		await fs.mkdir(settingsDir, { recursive: true })
		return settingsDir
	}

	// VSCode LM API
	/**
	 * 获取VS Code语言模型（LM）的聊天模型列表。
	 * 该函数会尝试从VS Code的API中获取可用的聊天模型，如果获取失败则返回空数组。
	 *
	 * @returns {Promise<Array>} 返回一个Promise，解析为聊天模型的数组。如果获取失败或没有模型，则返回空数组。
	 */
	private async getVsCodeLmModels() {
		try {
			// 从VS Code API中获取 Chat 模型列表
			const models = await vscode.lm.selectChatModels({})
			return models || []
		} catch (error) {
			console.error("Error fetching VS Code LM models:", error)
			return []
		}
	}

	// Ollama
	/**
	 * 获取Ollama模型的列表。
	 *
	 * 该函数通过向指定的Ollama API端点发送请求，获取所有可用的模型名称，并返回去重后的模型名称列表。
	 *
	 * @param {string} [baseUrl] - Ollama API的基础URL。如果未提供，则默认使用 `http://localhost:11434`。
	 * @returns {Promise<string[]>} 返回一个包含所有去重后的模型名称的数组。如果请求失败或URL无效，则返回空数组。
	 */
	async getOllamaModels(baseUrl?: string) {
		try {
			if (!baseUrl) {
				// 如果未提供baseUrl，则使用默认的本地URL
				baseUrl = "http://localhost:11434"
			}
			if (!URL.canParse(baseUrl)) {
				// 检查URL是否有效，如果无效则返回空数组
				return []
			}
			// 向Ollama API发送请求，获取模型列表
			const response = await axios.get(`${baseUrl}/api/tags`)
			const modelsArray = response.data?.models?.map((model: any) => model.name) || []
			const models = [...new Set<string>(modelsArray)]
			return models
		} catch (error) {
			return []
		}
	}

	// LM Studio
	/**
	 * 获取LM Studio模型列表。
	 *
	 * 该函数通过向指定的基础URL发送GET请求，获取LM Studio的模型列表，并返回去重后的模型ID数组。
	 * 如果未提供基础URL，则默认使用`http://localhost:1234`。
	 * 如果URL无法解析或请求失败，则返回空数组。
	 *
	 * @param {string} [baseUrl] - 可选参数，LM Studio服务的基础URL。如果未提供，则使用默认值`http://localhost:1234`。
	 * @returns {Promise<string[]>} 返回一个Promise，解析为去重后的模型ID数组。如果请求失败或URL无效，则返回空数组。
	 */
	async getLmStudioModels(baseUrl?: string) {
		try {
			if (!baseUrl) {
				baseUrl = "http://localhost:1234"
			}
			if (!URL.canParse(baseUrl)) {
				return []
			}
			const response = await axios.get(`${baseUrl}/v1/models`)
			const modelsArray = response.data?.data?.map((model: any) => model.id) || []
			const models = [...new Set<string>(modelsArray)]
			return models
		} catch (error) {
			return []
		}
	}

	// Auth
	/**
	 * 验证授权状态是否有效。
	 *
	 * 在extension.ts中使用到
	 *
	 * 该函数用于验证传入的授权状态 `state` 是否与存储的 `authNonce` 值匹配。
	 * 如果匹配，则清除存储的 `authNonce` 并返回 `true`，否则返回 `false`。
	 *
	 * @param state - 待验证的授权状态字符串，可能为 `null`。
	 * @returns 返回一个 `Promise<boolean>`，表示授权状态是否有效。
	 */

	public async validateAuthState(state: string | null): Promise<boolean> {
		// 从存储中获取当前的 `authNonce` 值
		const storedNonce = await this.getSecret("authNonce")

		// 如果传入的 `state` 为空或与存储的 `authNonce` 不匹配，返回 `false`
		if (!state || state !== storedNonce) {
			return false
		}
		// 验证成功后，清除存储的 `authNonce`，防止重复使用
		await this.storeSecret("authNonce", undefined) // Clear after use
		return true
	}

	/**
	 * 处理认证回调，使用自定义令牌进行登录并安全存储令牌。
	 * 该函数通常在从外部认证提供者接收到认证令牌后调用。
	 *
	 * 在extension.ts中使用到
	 *
	 * @param {string} token - 从认证提供者接收到的自定义令牌。
	 * @returns {Promise<void>} - 无返回值。
	 */
	async handleAuthCallback(token: string) {
		try {
			// First sign in with Firebase to trigger auth state change
			await this.authManager.signInWithCustomToken(token)

			// Then store the token securely
			await this.storeSecret("authToken", token)
			await this.postStateToWebview()
			vscode.window.showInformationMessage("Successfully logged in to Cline")
		} catch (error) {
			console.error("Failed to handle auth callback:", error)
			vscode.window.showErrorMessage("Failed to log in to Cline")
		}
	}

	// MCP Marketplace

	private async fetchMcpMarketplaceFromApi(silent: boolean = false): Promise<McpMarketplaceCatalog | undefined> {
		try {
			const response = await axios.get("https://api.cline.bot/v1/mcp/marketplace", {
				headers: {
					"Content-Type": "application/json",
				},
			})

			if (!response.data) {
				throw new Error("Invalid response from MCP marketplace API")
			}

			const catalog: McpMarketplaceCatalog = {
				items: (response.data || []).map((item: any) => ({
					...item,
					githubStars: item.githubStars ?? 0,
					downloadCount: item.downloadCount ?? 0,
					tags: item.tags ?? [],
				})),
			}

			// Store in global state
			await this.updateGlobalState("mcpMarketplaceCatalog", catalog)
			return catalog
		} catch (error) {
			console.error("Failed to fetch MCP marketplace:", error)
			if (!silent) {
				const errorMessage = error instanceof Error ? error.message : "Failed to fetch MCP marketplace"
				await this.postMessageToWebview({
					type: "mcpMarketplaceCatalog",
					error: errorMessage,
				})
				vscode.window.showErrorMessage(errorMessage)
			}
			return undefined
		}
	}

	async silentlyRefreshMcpMarketplace() {
		try {
			const catalog = await this.fetchMcpMarketplaceFromApi(true)
			if (catalog) {
				await this.postMessageToWebview({
					type: "mcpMarketplaceCatalog",
					mcpMarketplaceCatalog: catalog,
				})
			}
		} catch (error) {
			console.error("Failed to silently refresh MCP marketplace:", error)
		}
	}

	private async fetchMcpMarketplace(forceRefresh: boolean = false) {
		try {
			// Check if we have cached data
			const cachedCatalog = (await this.getGlobalState("mcpMarketplaceCatalog")) as McpMarketplaceCatalog | undefined
			if (!forceRefresh && cachedCatalog?.items) {
				await this.postMessageToWebview({
					type: "mcpMarketplaceCatalog",
					mcpMarketplaceCatalog: cachedCatalog,
				})
				return
			}

			const catalog = await this.fetchMcpMarketplaceFromApi(false)
			if (catalog) {
				await this.postMessageToWebview({
					type: "mcpMarketplaceCatalog",
					mcpMarketplaceCatalog: catalog,
				})
			}
		} catch (error) {
			console.error("Failed to handle cached MCP marketplace:", error)
			const errorMessage = error instanceof Error ? error.message : "Failed to handle cached MCP marketplace"
			await this.postMessageToWebview({
				type: "mcpMarketplaceCatalog",
				error: errorMessage,
			})
			vscode.window.showErrorMessage(errorMessage)
		}
	}

	private async downloadMcp(mcpId: string) {
		try {
			// First check if we already have this MCP server installed
			const servers = this.mcpHub?.getServers() || []
			const isInstalled = servers.some((server: McpServer) => server.name === mcpId)

			if (isInstalled) {
				throw new Error("This MCP server is already installed")
			}

			// Fetch server details from marketplace
			const response = await axios.post<McpDownloadResponse>(
				"https://api.cline.bot/v1/mcp/download",
				{ mcpId },
				{
					headers: { "Content-Type": "application/json" },
					timeout: 10000,
				},
			)

			if (!response.data) {
				throw new Error("Invalid response from MCP marketplace API")
			}

			console.log("[downloadMcp] Response from download API", { response })

			const mcpDetails = response.data

			// Validate required fields
			if (!mcpDetails.githubUrl) {
				throw new Error("Missing GitHub URL in MCP download response")
			}
			if (!mcpDetails.readmeContent) {
				throw new Error("Missing README content in MCP download response")
			}

			// Send details to webview
			await this.postMessageToWebview({
				type: "mcpDownloadDetails",
				mcpDownloadDetails: mcpDetails,
			})

			// Create task with context from README
			const task = `Set up the MCP server from ${mcpDetails.githubUrl}. Use "${mcpDetails.mcpId}" as the server name in cline_mcp_settings.json. Here is the project's README to help you get started:\n\n${mcpDetails.readmeContent}\n${mcpDetails.llmsInstallationContent}`

			// Initialize task and show chat view
			await this.initClineWithTask(task)
			await this.postMessageToWebview({
				type: "action",
				action: "chatButtonClicked",
			})
		} catch (error) {
			console.error("Failed to download MCP:", error)
			let errorMessage = "Failed to download MCP"

			if (axios.isAxiosError(error)) {
				if (error.code === "ECONNABORTED") {
					errorMessage = "Request timed out. Please try again."
				} else if (error.response?.status === 404) {
					errorMessage = "MCP server not found in marketplace."
				} else if (error.response?.status === 500) {
					errorMessage = "Internal server error. Please try again later."
				} else if (!error.response && error.request) {
					errorMessage = "Network error. Please check your internet connection."
				}
			} else if (error instanceof Error) {
				errorMessage = error.message
			}

			// Show error in both notification and marketplace UI
			vscode.window.showErrorMessage(errorMessage)
			await this.postMessageToWebview({
				type: "mcpDownloadDetails",
				error: errorMessage,
			})
		}
	}

	// OpenAi
	/**
	 * 获取 OpenAI 模型列表。
	 * 该函数通过调用指定的 API 地址获取可用的 OpenAI 模型列表，并返回去重后的模型 ID 数组。
	 *
	 * 在私有方法 setWebviewMessageListener 中用到
	 *
	 * @param {string} [baseUrl] - OpenAI API 的基础地址，如果未提供则返回空数组。
	 * @param {string} [apiKey] - OpenAI API 的密钥，用于授权请求，如果未提供则使用无授权的请求。
	 * @returns {Promise<string[]>} - 返回去重后的模型 ID 数组，如果请求失败或参数无效则返回空数组。
	 */
	async getOpenAiModels(baseUrl?: string, apiKey?: string) {
		try {
			if (!baseUrl) {
				return []
			}

			if (!URL.canParse(baseUrl)) {
				return []
			}

			const config: Record<string, any> = {}
			if (apiKey) {
				config["headers"] = { Authorization: `Bearer ${apiKey}` }
			}

			const response = await axios.get(`${baseUrl}/models`, config)
			const modelsArray = response.data?.data?.map((model: any) => model.id) || []
			const models = [...new Set<string>(modelsArray)]
			return models
		} catch (error) {
			return []
		}
	}

	// OpenRouter
	/**
	 * 处理 OpenRouter 的回调，通过授权码获取 API 密钥并更新相关配置。
	 * 该函数通常用于在用户完成 OpenRouter 授权后，获取 API 密钥并更新全局状态。
	 *
	 * 在extension.ts中使用到
	 *
	 * @param {string} code - OpenRouter 授权码，用于交换 API 密钥。
	 */
	async handleOpenRouterCallback(code: string) {
		let apiKey: string
		try {
			// 向 OpenRouter API 发送请求，使用授权码交换 API 密钥
			const response = await axios.post("https://openrouter.ai/api/v1/auth/keys", { code })
			if (response.data && response.data.key) {
				apiKey = response.data.key
			} else {
				throw new Error("Invalid response from OpenRouter API")
			}
		} catch (error) {
			console.error("Error exchanging code for API key:", error)
			throw error
		}
		// 更新全局状态为使用 OpenRouter 作为 API 提供者
		const openrouter: ApiProvider = "openrouter"
		await this.updateGlobalState("apiProvider", openrouter)
		await this.storeSecret("openRouterApiKey", apiKey)
		await this.postStateToWebview()
		// 如果 Cline 实例存在，更新其 API 处理器
		if (this.cline) {
			this.cline.api = buildApiHandler({
				apiProvider: openrouter,
				openRouterApiKey: apiKey,
			})
		}
		// await this.postMessageToWebview({ type: "action", action: "settingsButtonClicked" }) // bad ux if user is on welcome
	}
	/**
	 * 确保缓存目录存在，如果不存在则创建它。
	 *
	 * 该函数会检查并创建缓存目录，确保后续操作可以安全地进行文件存储。
	 *
	 * 在下边两个 readOpenRouterModels 和 refreshOpenRouterModels 中用到
	 * @returns {Promise<string>} 返回缓存目录的绝对路径。
	 */
	private async ensureCacheDirectoryExists(): Promise<string> {
		// 构建缓存目录的路径，使用全局存储路径和"cache"子目录拼接而成
		const cacheDir = path.join(this.context.globalStorageUri.fsPath, "cache")
		await fs.mkdir(cacheDir, { recursive: true })
		return cacheDir
	}
	/**
	 * 读取 OpenRouter 模型信息文件并解析为对象。
	 *
	 * 该函数首先确保缓存目录存在，然后检查 OpenRouter 模型信息文件是否存在。
	 * 如果文件存在，读取文件内容并将其解析为 JSON 对象返回；如果文件不存在，返回 undefined。
	 *
	 * 在 setWebviewMessageListener 中用到
	 *
	 * @returns {Promise<Record<string, ModelInfo> | undefined>} 返回一个 Promise，解析为包含模型信息的对象，如果文件不存在则返回 undefined。
	 */
	async readOpenRouterModels(): Promise<Record<string, ModelInfo> | undefined> {
		// 获取 OpenRouter 模型信息文件的完整路径
		const openRouterModelsFilePath = path.join(await this.ensureCacheDirectoryExists(), GlobalFileNames.openRouterModels)
		const fileExists = await fileExistsAtPath(openRouterModelsFilePath)
		// 如果文件存在，读取并解析文件内容
		if (fileExists) {
			const fileContents = await fs.readFile(openRouterModelsFilePath, "utf8")
			return JSON.parse(fileContents)
		}
		return undefined
	}

	/**
	 * 刷新并获取OpenRouter的模型信息。
	 * 该函数会从OpenRouter的API获取最新的模型数据，并将其保存到本地缓存文件中。
	 * 同时，它会将获取到的模型信息发送到Webview中。
	 *
	 * 在 setWebviewMessageListener 中关键字 refreshOpenRouterModels 下用到
	 *
	 * @returns {Promise<Record<string, ModelInfo>>} 返回一个包含所有模型信息的对象，键为模型ID，值为模型信息。
	 */
	async refreshOpenRouterModels() {
		const openRouterModelsFilePath = path.join(await this.ensureCacheDirectoryExists(), GlobalFileNames.openRouterModels)

		let models: Record<string, ModelInfo> = {}
		try {
			const response = await axios.get("https://openrouter.ai/api/v1/models")
			/*
			{
				"id": "anthropic/claude-3.5-sonnet",
				"name": "Anthropic: Claude 3.5 Sonnet",
				"created": 1718841600,
				"description": "Claude 3.5 Sonnet delivers better-than-Opus capabilities, faster-than-Sonnet speeds, at the same Sonnet prices. Sonnet is particularly good at:\n\n- Coding: Autonomously writes, edits, and runs code with reasoning and troubleshooting\n- Data science: Augments human data science expertise; navigates unstructured data while using multiple tools for insights\n- Visual processing: excelling at interpreting charts, graphs, and images, accurately transcribing text to derive insights beyond just the text alone\n- Agentic tasks: exceptional tool use, making it great at agentic tasks (i.e. complex, multi-step problem solving tasks that require engaging with other systems)\n\n#multimodal",
				"context_length": 200000,
				"architecture": {
					"modality": "text+image-\u003Etext",
					"tokenizer": "Claude",
					"instruct_type": null
				},
				"pricing": {
					"prompt": "0.000003",
					"completion": "0.000015",
					"image": "0.0048",
					"request": "0"
				},
				"top_provider": {
					"context_length": 200000,
					"max_completion_tokens": 8192,
					"is_moderated": true
				},
				"per_request_limits": null
			},
			*/
			// 如果API返回的数据有效，则解析并处理模型信息
			if (response.data?.data) {
				const rawModels = response.data.data
				const parsePrice = (price: any) => {
					if (price) {
						return parseFloat(price) * 1_000_000
					}
					return undefined
				}
				for (const rawModel of rawModels) {
					const modelInfo: ModelInfo = {
						maxTokens: rawModel.top_provider?.max_completion_tokens,
						contextWindow: rawModel.context_length,
						supportsImages: rawModel.architecture?.modality?.includes("image"),
						supportsPromptCache: false,
						inputPrice: parsePrice(rawModel.pricing?.prompt),
						outputPrice: parsePrice(rawModel.pricing?.completion),
						description: rawModel.description,
					}

					switch (rawModel.id) {
						case "anthropic/claude-3.5-sonnet":
						case "anthropic/claude-3.5-sonnet:beta":
							// NOTE: this needs to be synced with api.ts/openrouter default model info
							modelInfo.supportsComputerUse = true
							modelInfo.supportsPromptCache = true
							modelInfo.cacheWritesPrice = 3.75
							modelInfo.cacheReadsPrice = 0.3
							break
						case "anthropic/claude-3.5-sonnet-20240620":
						case "anthropic/claude-3.5-sonnet-20240620:beta":
							modelInfo.supportsPromptCache = true
							modelInfo.cacheWritesPrice = 3.75
							modelInfo.cacheReadsPrice = 0.3
							break
						case "anthropic/claude-3-5-haiku":
						case "anthropic/claude-3-5-haiku:beta":
						case "anthropic/claude-3-5-haiku-20241022":
						case "anthropic/claude-3-5-haiku-20241022:beta":
						case "anthropic/claude-3.5-haiku":
						case "anthropic/claude-3.5-haiku:beta":
						case "anthropic/claude-3.5-haiku-20241022":
						case "anthropic/claude-3.5-haiku-20241022:beta":
							modelInfo.supportsPromptCache = true
							modelInfo.cacheWritesPrice = 1.25
							modelInfo.cacheReadsPrice = 0.1
							break
						case "anthropic/claude-3-opus":
						case "anthropic/claude-3-opus:beta":
							modelInfo.supportsPromptCache = true
							modelInfo.cacheWritesPrice = 18.75
							modelInfo.cacheReadsPrice = 1.5
							break
						case "anthropic/claude-3-haiku":
						case "anthropic/claude-3-haiku:beta":
							modelInfo.supportsPromptCache = true
							modelInfo.cacheWritesPrice = 0.3
							modelInfo.cacheReadsPrice = 0.03
							break
						case "deepseek/deepseek-chat":
							modelInfo.supportsPromptCache = true
							// see api.ts/deepSeekModels for more info
							modelInfo.inputPrice = 0
							modelInfo.cacheWritesPrice = 0.14
							modelInfo.cacheReadsPrice = 0.014
							break
					}

					models[rawModel.id] = modelInfo
				}
			} else {
				console.error("Invalid response from OpenRouter API")
			}
			await fs.writeFile(openRouterModelsFilePath, JSON.stringify(models))
			console.log("OpenRouter models fetched and saved", models)
		} catch (error) {
			console.error("Error fetching OpenRouter models:", error)
		}

		await this.postMessageToWebview({
			type: "openRouterModels",
			openRouterModels: models,
		})
		return models
	}

	// Task history
	/**
	 * 根据任务ID获取任务相关的详细信息。
	 *
	 * 该函数会从全局状态中获取任务历史记录，并根据提供的任务ID查找对应的任务项。
	 * 如果找到任务项，会进一步获取任务目录路径、API对话历史文件路径、UI消息文件路径，
	 * 并读取API对话历史文件内容。如果任务不存在，则从状态中删除该任务ID并抛出错误。
	 *
	 * 在 Cline.ts 中的 recursivelyMakeClineRequests 用到
	 * 在本文件中 showTaskWithId exportTaskWithId deleteTaskWithId cancelTask 用到
	 *
	 * @param id - 任务的唯一标识符。
	 * @returns 返回一个Promise，解析为一个包含任务历史项、任务目录路径、API对话历史文件路径、
	 *          UI消息文件路径以及API对话历史记录的对象。
	 * @throws 如果任务未找到，抛出错误 "Task not found"。
	 */
	async getTaskWithId(id: string): Promise<{
		historyItem: HistoryItem
		taskDirPath: string
		apiConversationHistoryFilePath: string
		uiMessagesFilePath: string
		apiConversationHistory: Anthropic.MessageParam[]
	}> {
		// 从全局状态中获取任务历史记录，如果不存在则初始化为空数组
		const history = ((await this.getGlobalState("taskHistory")) as HistoryItem[] | undefined) || []
		const historyItem = history.find((item) => item.id === id)
		if (historyItem) {
			// 构建任务目录路径
			const taskDirPath = path.join(this.context.globalStorageUri.fsPath, "tasks", id)
			const apiConversationHistoryFilePath = path.join(taskDirPath, GlobalFileNames.apiConversationHistory)
			const uiMessagesFilePath = path.join(taskDirPath, GlobalFileNames.uiMessages)

			// 检查API对话历史文件是否存在
			const fileExists = await fileExistsAtPath(apiConversationHistoryFilePath)
			if (fileExists) {
				const apiConversationHistory = JSON.parse(await fs.readFile(apiConversationHistoryFilePath, "utf8"))
				return {
					historyItem,
					taskDirPath,
					apiConversationHistoryFilePath,
					uiMessagesFilePath,
					apiConversationHistory,
				}
			}
		}
		// if we tried to get a task that doesn't exist, remove it from state
		// FIXME: this seems to happen sometimes when the json file doesnt save to disk for some reason
		await this.deleteTaskFromState(id)
		throw new Error("Task not found")
	}
	/**
	 * 根据给定的任务ID显示任务内容。
	 * 如果任务ID与当前任务ID不同，则获取该任务的历史记录并初始化客户端。
	 * 最后，向Webview发送消息以触发聊天按钮点击事件。
	 * 在 setWebviewMessageToWebview 中调用
	 *
	 * WebviewMessage.ts中也定义了相应关键字
	 * @param id - 要显示的任务的唯一标识符。
	 */
	async showTaskWithId(id: string) {
		// 如果任务ID与当前任务ID不同，则获取任务历史记录并初始化客户端
		if (id !== this.cline?.taskId) {
			// non-current task
			const { historyItem } = await this.getTaskWithId(id)
			await this.initClineWithHistoryItem(historyItem) // clears existing task
		}

		// 向Webview发送消息，触发聊天按钮点击事件
		await this.postMessageToWebview({
			type: "action",
			action: "chatButtonClicked",
		})
	}

	/**
	 * 根据任务ID导出任务数据
	 *
	 * 该函数首先通过任务ID获取任务的历史记录和API对话历史，然后调用下载函数将任务数据导出。
	 * 在 setWebviewMessageToWebview 中调用
	 *
	 * WebviewMessage.ts中也定义了相应关键字
	 * @param id - 任务的唯一标识符，用于查找对应的任务数据
	 */
	async exportTaskWithId(id: string) {
		// 获取任务的历史记录和API对话历史
		const { historyItem, apiConversationHistory } = await this.getTaskWithId(id)
		// 来自于export-markdown.ts中定义的方法
		await downloadTask(historyItem.ts, apiConversationHistory)
	}
	/**
	 * 根据任务ID删除任务及其相关文件。
	 * 在 setWebviewMessageToWebview 中调用
	 *
	 * WebviewMessage.ts中也定义了相应关键字
	 *
	 * @param id - 要删除的任务的唯一标识符。
	 * @returns Promise<void> - 该函数不返回任何值，但会异步执行删除操作。
	 */
	async deleteTaskWithId(id: string) {
		// 如果当前任务ID与传入的ID匹配，则清除当前任务
		if (id === this.cline?.taskId) {
			await this.clearTask()
		}

		const { taskDirPath, apiConversationHistoryFilePath, uiMessagesFilePath } = await this.getTaskWithId(id)

		await this.deleteTaskFromState(id)

		// Delete the task files
		const apiConversationHistoryFileExists = await fileExistsAtPath(apiConversationHistoryFilePath)
		if (apiConversationHistoryFileExists) {
			await fs.unlink(apiConversationHistoryFilePath)
		}
		const uiMessagesFileExists = await fileExistsAtPath(uiMessagesFilePath)
		if (uiMessagesFileExists) {
			await fs.unlink(uiMessagesFilePath)
		}
		const legacyMessagesFilePath = path.join(taskDirPath, "claude_messages.json")
		if (await fileExistsAtPath(legacyMessagesFilePath)) {
			await fs.unlink(legacyMessagesFilePath)
		}

		// Delete the checkpoints directory if it exists
		// 删除检查点目录（如果存在）
		const checkpointsDir = path.join(taskDirPath, "checkpoints")
		if (await fileExistsAtPath(checkpointsDir)) {
			try {
				await fs.rm(checkpointsDir, { recursive: true, force: true })
			} catch (error) {
				console.error(`Failed to delete checkpoints directory for task ${id}:`, error)
				// Continue with deletion of task directory - don't throw since this is a cleanup operation
			}
		}

		await fs.rmdir(taskDirPath) // succeeds if the dir is empty
	}
	/**
	 * 从全局状态中删除指定ID的任务。
	 * 该函数会从任务历史中移除该任务，并通知WebView状态已更新。 仅从全局状态中删除任务，不涉及文件系统的操作
	 *
	 * @param {string} id - 要删除的任务的唯一标识符。
	 * @returns {Promise<void>} - 当任务成功删除且WebView已通知时，返回一个Promise。
	 */
	async deleteTaskFromState(id: string) {
		// Remove the task from history
		// 从全局状态中获取当前任务历史，如果不存在则初始化为空数组。
		const taskHistory = ((await this.getGlobalState("taskHistory")) as HistoryItem[] | undefined) || []
		// 过滤掉任务历史中指定ID的任务。
		const updatedTaskHistory = taskHistory.filter((task) => task.id !== id)
		// 使用更新后的任务历史更新全局状态。
		await this.updateGlobalState("taskHistory", updatedTaskHistory)

		// Notify the webview that the task has been deleted
		// 通知WebView状态已更新，以反映任务的删除。
		await this.postStateToWebview()
	}
	/**
	 * 将当前状态发送到 Webview。
	 * 该函数首先获取需要发送到 Webview 的状态，然后通过 `postMessageToWebview` 方法将状态信息发送出去。
	 * 状态信息包含一个类型字段 "state"，以及实际的状态数据。
	 *
	 * @returns {Promise<void>} 该函数返回一个 Promise，在状态成功发送后解析。
	 */
	async postStateToWebview() {
		const state = await this.getStateToPostToWebview()
		this.postMessageToWebview({ type: "state", state })
	}
	/**
	 * 获取当前扩展的状态信息，并将其格式化为适合发送到 Webview 的数据结构。
	 *
	 * 该函数从 `getState` 方法中获取当前扩展的配置和用户信息，并将其与一些运行时状态（如当前任务、错误消息等）组合，
	 * 最终返回一个包含所有必要信息的 `ExtensionState` 对象。
	 *
	 * 只在 postStateToWebview 中用到一次
	 * @returns {Promise<ExtensionState>} 返回一个 Promise，解析为包含扩展状态信息的 `ExtensionState` 对象。
	 *
	 */
	async getStateToPostToWebview(): Promise<ExtensionState> {
		const {
			apiConfiguration,
			lastShownAnnouncementId,
			customInstructions,
			taskHistory,
			autoApprovalSettings,
			browserSettings,
			chatSettings,
			userInfo,
			authToken,
		} = await this.getState()

		return {
			version: this.context.extension?.packageJSON?.version ?? "",
			apiConfiguration,
			customInstructions,
			uriScheme: vscode.env.uriScheme,
			currentTaskItem: this.cline?.taskId ? (taskHistory || []).find((item) => item.id === this.cline?.taskId) : undefined,
			checkpointTrackerErrorMessage: this.cline?.checkpointTrackerErrorMessage,
			clineMessages: this.cline?.clineMessages || [],
			taskHistory: (taskHistory || []).filter((item) => item.ts && item.task).sort((a, b) => b.ts - a.ts),
			shouldShowAnnouncement: lastShownAnnouncementId !== this.latestAnnouncementId,
			platform: process.platform as Platform,
			autoApprovalSettings,
			browserSettings,
			chatSettings,
			isLoggedIn: !!authToken,
			userInfo,
		}
	}
	/**
	 * 异步清除任务。
	 *
	 * 该方法用于中止当前任务并清除对任务对象的引用。
	 * 首先调用 cline 对象的 abortTask 方法来中止正在进行的任务（如果存在）。
	 * 然后，清除对 cline 对象的引用，以便在所有 Promise 结束后可以被垃圾回收。
	 */
	async clearTask() {
		// abortTask为Cline.ts的实例方法，用于中止正在进行的任务。
		/**首先将 abort 标志设置为 true，以停止任何自主运行的 Promise。
		 * 然后调用 terminalManager 的 disposeAll 方法释放所有终端资源。
		 * 接着调用 urlContentFetcher 的 closeBrowser 方法关闭浏览器。
		 * 然后调用 browserSession 的 closeBrowser 方法关闭浏览器会话。
		 * 接着调用 clineIgnoreController 的 dispose 方法释放忽略控制器资源。
		 * 最后等待 diffViewProvider 的 revertChanges 方法完成，确保目录和文件在重新启动任务之前已恢复到检查点状态。
		 */
		this.cline?.abortTask()
		this.cline = undefined // removes reference to it, so once promises end it will be garbage collected
	}

	// Caching mechanism to keep track of webview messages + API conversation history per provider instance

	/*
	Now that we use retainContextWhenHidden, we don't have to store a cache of cline messages in the user's state, but we could to reduce memory footprint in long conversations.

	- We have to be careful of what state is shared between ClineProvider instances since there could be multiple instances of the extension running at once. For example when we cached cline messages using the same key, two instances of the extension could end up using the same key and overwriting each other's messages.
	- Some state does need to be shared between the instances, i.e. the API key--however there doesn't seem to be a good way to notify the other instances that the API key has changed.

	We need to use a unique identifier for each ClineProvider instance's message cache since we could be running several instances of the extension outside of just the sidebar i.e. in editor panels.

	// conversation history to send in API requests

	/*
	It seems that some API messages do not comply with vscode state requirements. Either the Anthropic library is manipulating these values somehow in the backend in a way thats creating cyclic references, or the API returns a function or a Symbol as part of the message content.
	VSCode docs about state: "The value must be JSON-stringifyable ... value — A value. MUST not contain cyclic references."
	For now we'll store the conversation history in memory, and if we need to store in state directly we'd need to do a manual conversion to ensure proper json stringification.
	*/

	// getApiConversationHistory(): Anthropic.MessageParam[] {
	// 	// const history = (await this.getGlobalState(
	// 	// 	this.getApiConversationHistoryStateKey()
	// 	// )) as Anthropic.MessageParam[]
	// 	// return history || []
	// 	return this.apiConversationHistory
	// }

	// setApiConversationHistory(history: Anthropic.MessageParam[] | undefined) {
	// 	// await this.updateGlobalState(this.getApiConversationHistoryStateKey(), history)
	// 	this.apiConversationHistory = history || []
	// }

	// addMessageToApiConversationHistory(message: Anthropic.MessageParam): Anthropic.MessageParam[] {
	// 	// const history = await this.getApiConversationHistory()
	// 	// history.push(message)
	// 	// await this.setApiConversationHistory(history)
	// 	// return history
	// 	this.apiConversationHistory.push(message)
	// 	return this.apiConversationHistory
	// }

	/*
	Storage
	https://dev.to/kompotkot/how-to-use-secretstorage-in-your-vscode-extensions-2hco
	https://www.eliostruyf.com/devhack-code-extension-storage-options/
	*/
	/**
	 * 获取应用程序的全局状态和配置信息。
	 *
	 * 该函数通过异步方式从全局状态和密钥存储中获取多个配置项，包括API提供者、模型ID、API密钥、AWS配置、OpenAI配置等。
	 * 它还处理了一些默认值和逻辑，例如为新用户或旧用户设置默认的API提供者。
	 *
	 * @returns {Promise<Object>} 返回一个包含所有配置和状态信息的对象，包括API配置、用户信息、任务历史、浏览器设置等。
	 */
	async getState() {
		const [
			storedApiProvider,
			apiModelId,
			apiKey,
			openRouterApiKey,
			awsAccessKey,
			awsSecretKey,
			awsSessionToken,
			awsRegion,
			awsUseCrossRegionInference,
			awsProfile,
			awsUseProfile,
			vertexProjectId,
			vertexRegion,
			openAiBaseUrl,
			openAiApiKey,
			openAiModelId,
			openAiModelInfo,
			ollamaModelId,
			ollamaBaseUrl,
			lmStudioModelId,
			lmStudioBaseUrl,
			anthropicBaseUrl,
			geminiApiKey,
			openAiNativeApiKey,
			deepSeekApiKey,
			requestyApiKey,
			requestyModelId,
			togetherApiKey,
			togetherModelId,
			qwenApiKey,
			mistralApiKey,
			azureApiVersion,
			openRouterModelId,
			openRouterModelInfo,
			lastShownAnnouncementId,
			customInstructions,
			taskHistory,
			autoApprovalSettings,
			browserSettings,
			chatSettings,
			vsCodeLmModelSelector,
			liteLlmBaseUrl,
			liteLlmModelId,
			userInfo,
			authToken,
			previousModeApiProvider,
			previousModeModelId,
			previousModeModelInfo,
			qwenApiLine,
			liteLlmApiKey,
		] = await Promise.all([
			this.getGlobalState("apiProvider") as Promise<ApiProvider | undefined>,
			this.getGlobalState("apiModelId") as Promise<string | undefined>,
			this.getSecret("apiKey") as Promise<string | undefined>,
			this.getSecret("openRouterApiKey") as Promise<string | undefined>,
			this.getSecret("awsAccessKey") as Promise<string | undefined>,
			this.getSecret("awsSecretKey") as Promise<string | undefined>,
			this.getSecret("awsSessionToken") as Promise<string | undefined>,
			this.getGlobalState("awsRegion") as Promise<string | undefined>,
			this.getGlobalState("awsUseCrossRegionInference") as Promise<boolean | undefined>,
			this.getGlobalState("awsProfile") as Promise<string | undefined>,
			this.getGlobalState("awsUseProfile") as Promise<boolean | undefined>,
			this.getGlobalState("vertexProjectId") as Promise<string | undefined>,
			this.getGlobalState("vertexRegion") as Promise<string | undefined>,
			this.getGlobalState("openAiBaseUrl") as Promise<string | undefined>,
			this.getSecret("openAiApiKey") as Promise<string | undefined>,
			this.getGlobalState("openAiModelId") as Promise<string | undefined>,
			this.getGlobalState("openAiModelInfo") as Promise<ModelInfo | undefined>,
			this.getGlobalState("ollamaModelId") as Promise<string | undefined>,
			this.getGlobalState("ollamaBaseUrl") as Promise<string | undefined>,
			this.getGlobalState("lmStudioModelId") as Promise<string | undefined>,
			this.getGlobalState("lmStudioBaseUrl") as Promise<string | undefined>,
			this.getGlobalState("anthropicBaseUrl") as Promise<string | undefined>,
			this.getSecret("geminiApiKey") as Promise<string | undefined>,
			this.getSecret("openAiNativeApiKey") as Promise<string | undefined>,
			this.getSecret("deepSeekApiKey") as Promise<string | undefined>,
			this.getSecret("requestyApiKey") as Promise<string | undefined>,
			this.getGlobalState("requestyModelId") as Promise<string | undefined>,
			this.getSecret("togetherApiKey") as Promise<string | undefined>,
			this.getGlobalState("togetherModelId") as Promise<string | undefined>,
			this.getSecret("qwenApiKey") as Promise<string | undefined>,
			this.getSecret("mistralApiKey") as Promise<string | undefined>,
			this.getGlobalState("azureApiVersion") as Promise<string | undefined>,
			this.getGlobalState("openRouterModelId") as Promise<string | undefined>,
			this.getGlobalState("openRouterModelInfo") as Promise<ModelInfo | undefined>,
			this.getGlobalState("lastShownAnnouncementId") as Promise<string | undefined>,
			this.getGlobalState("customInstructions") as Promise<string | undefined>,
			this.getGlobalState("taskHistory") as Promise<HistoryItem[] | undefined>,
			this.getGlobalState("autoApprovalSettings") as Promise<AutoApprovalSettings | undefined>,
			this.getGlobalState("browserSettings") as Promise<BrowserSettings | undefined>,
			this.getGlobalState("chatSettings") as Promise<ChatSettings | undefined>,
			this.getGlobalState("vsCodeLmModelSelector") as Promise<vscode.LanguageModelChatSelector | undefined>,
			this.getGlobalState("liteLlmBaseUrl") as Promise<string | undefined>,
			this.getGlobalState("liteLlmModelId") as Promise<string | undefined>,
			this.getGlobalState("userInfo") as Promise<UserInfo | undefined>,
			this.getSecret("authToken") as Promise<string | undefined>,
			this.getGlobalState("previousModeApiProvider") as Promise<ApiProvider | undefined>,
			this.getGlobalState("previousModeModelId") as Promise<string | undefined>,
			this.getGlobalState("previousModeModelInfo") as Promise<ModelInfo | undefined>,
			this.getGlobalState("qwenApiLine") as Promise<string | undefined>,
			this.getSecret("liteLlmApiKey") as Promise<string | undefined>,
		])

		// 确定API提供者，如果未存储则根据条件设置默认值
		let apiProvider: ApiProvider
		if (storedApiProvider) {
			apiProvider = storedApiProvider
		} else {
			// Either new user or legacy user that doesn't have the apiProvider stored in state
			// (If they're using OpenRouter or Bedrock, then apiProvider state will exist)
			// 新用户或旧用户未存储apiProvider状态
			if (apiKey) {
				apiProvider = "anthropic"
			} else {
				// New users should default to openrouter
				// 新用户默认使用openrouter
				apiProvider = "openrouter"
			}
		}

		// 获取o3Mini模型的推理努力级别配置
		const o3MiniReasoningEffort = vscode.workspace
			.getConfiguration("cline.modelSettings.o3Mini")
			.get("reasoningEffort", "medium")

		// 返回所有配置和状态信息
		return {
			apiConfiguration: {
				apiProvider,
				apiModelId,
				apiKey,
				openRouterApiKey,
				awsAccessKey,
				awsSecretKey,
				awsSessionToken,
				awsRegion,
				awsUseCrossRegionInference,
				awsProfile,
				awsUseProfile,
				vertexProjectId,
				vertexRegion,
				openAiBaseUrl,
				openAiApiKey,
				openAiModelId,
				openAiModelInfo,
				ollamaModelId,
				ollamaBaseUrl,
				lmStudioModelId,
				lmStudioBaseUrl,
				anthropicBaseUrl,
				geminiApiKey,
				openAiNativeApiKey,
				deepSeekApiKey,
				requestyApiKey,
				requestyModelId,
				togetherApiKey,
				togetherModelId,
				qwenApiKey,
				qwenApiLine,
				mistralApiKey,
				azureApiVersion,
				openRouterModelId,
				openRouterModelInfo,
				vsCodeLmModelSelector,
				o3MiniReasoningEffort,
				liteLlmBaseUrl,
				liteLlmModelId,
				liteLlmApiKey,
			},
			lastShownAnnouncementId,
			customInstructions,
			taskHistory,
			autoApprovalSettings: autoApprovalSettings || DEFAULT_AUTO_APPROVAL_SETTINGS, // default value can be 0 or empty string
			browserSettings: browserSettings || DEFAULT_BROWSER_SETTINGS,
			chatSettings: chatSettings || DEFAULT_CHAT_SETTINGS,
			userInfo,
			authToken,
			previousModeApiProvider,
			previousModeModelId,
			previousModeModelInfo,
		}
	}

	/**
	 * 根据参数任务 id 更新 Task 历史记录
	 * 【吐槽】目前只在 Cline.ts 中的 saveClineMessages() 方法中调用
	 * @param item 要更新的 Task 历史记录 HistoryItem
	 * @returns 现在所有的 Task 历史记录
	 */
	async updateTaskHistory(item: HistoryItem): Promise<HistoryItem[]> {
		const history = ((await this.getGlobalState("taskHistory")) as HistoryItem[]) || []
		const existingItemIndex = history.findIndex((h) => h.id === item.id)
		if (existingItemIndex !== -1) {
			history[existingItemIndex] = item
		} else {
			history.push(item)
		}
		await this.updateGlobalState("taskHistory", history)
		return history
	}

	// global
	/**
	 * 更新全局状态中指定键的值。
	 *
	 * @param key - 全局状态中的键，类型为 `GlobalStateKey`。
	 * @param value - 要更新的值，类型为 `any`。
	 */
	async updateGlobalState(key: GlobalStateKey, value: any) {
		await this.context.globalState.update(key, value)
	}
	/**
	 * 获取全局状态中指定键的值。
	 *
	 * @param key - 全局状态中的键，类型为 `GlobalStateKey`。
	 * @returns 返回与指定键关联的值，类型为 `any`。
	 */
	async getGlobalState(key: GlobalStateKey) {
		return await this.context.globalState.get(key)
	}

	// workspace
	/**
	 * 更新工作区状态中指定键的值。
	 *
	 * @param key - 工作区状态中的键，类型为 `string`。
	 * @param value - 要更新的值，类型为 `any`。
	 */
	private async updateWorkspaceState(key: string, value: any) {
		await this.context.workspaceState.update(key, value)
	}
	/**
	 * 获取工作区状态中指定键的值。
	 *
	 * @param key - 工作区状态中的键，类型为 `string`。
	 * @returns 返回与指定键关联的值，类型为 `any`。
	 */
	private async getWorkspaceState(key: string) {
		return await this.context.workspaceState.get(key)
	}

	// private async clearState() {
	// 	this.context.workspaceState.keys().forEach((key) => {
	// 		this.context.workspaceState.update(key, undefined)
	// 	})
	// 	this.context.globalState.keys().forEach((key) => {
	// 		this.context.globalState.update(key, undefined)
	// 	})
	// 	this.context.secrets.delete("apiKey")
	// }

	// secrets

	/**
	 * `vscode.ExtensionContext.secrets` 是 SecretStorage 接口类型的实例，
	 * 它允许扩展开发者 存储和检索敏感信息。
	 * get(key) 是获取；store(key, value) 是存储；delete(key) 是删除。
	 * @param key Cline 定义的敏感信息的 key
	 * @param value 为空时，删除 key 对应的敏感信息；不为空时，存储 key 对应的敏感信息
	 */
	private async storeSecret(key: SecretKey, value?: string) {
		if (value) {
			await this.context.secrets.store(key, value)
		} else {
			await this.context.secrets.delete(key)
		}
	}

	/**
	 * `vscode.ExtensionContext.secrets` 是 SecretStorage 接口类型的实例，
	 * 它允许扩展开发者 存储和检索敏感信息。
	 * get(key) 是获取；store(key, value) 是存储；delete(key) 是删除。
	 * @param key Cline 定义的敏感信息的 key
	 * @returns 返回 key 对应的敏感信息
	 */
	async getSecret(key: SecretKey) {
		return await this.context.secrets.get(key)
	}

	// dev
	/**
	 * 重置当前上下文的状态，包括清除所有全局状态键和密钥。
	 * 该函数会依次执行以下操作：
	 * 1. 显示重置状态的提示信息。
	 * 2. 遍历并清除所有全局状态键的值。
	 * 3. 清除预定义的密钥列表中的值。
	 * 4. 如果存在 `cline` 实例，则中止其任务并将其置为 `undefined`。
	 * 5. 显示状态重置完成的提示信息。
	 * 6. 将重置后的状态发送到 Webview。
	 * 7. 向 Webview 发送一条消息，表示聊天按钮被点击。
	 */
	async resetState() {
		vscode.window.showInformationMessage("Resetting state...")
		for (const key of this.context.globalState.keys()) {
			await this.context.globalState.update(key, undefined)
		}
		const secretKeys: SecretKey[] = [
			"apiKey",
			"openRouterApiKey",
			"awsAccessKey",
			"awsSecretKey",
			"awsSessionToken",
			"openAiApiKey",
			"geminiApiKey",
			"openAiNativeApiKey",
			"deepSeekApiKey",
			"requestyApiKey",
			"togetherApiKey",
			"qwenApiKey",
			"mistralApiKey",
			"liteLlmApiKey",
			"authToken",
		]
		for (const key of secretKeys) {
			await this.storeSecret(key, undefined)
		}
		if (this.cline) {
			// 【吐槽】为什么不直接用 clearTask() 方法？
			this.cline.abortTask()
			this.cline = undefined
		}
		vscode.window.showInformationMessage("State reset")
		await this.postStateToWebview()
		await this.postMessageToWebview({
			type: "action",
			action: "chatButtonClicked",
		})
	}
}
