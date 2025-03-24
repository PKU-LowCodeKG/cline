import { Anthropic } from "@anthropic-ai/sdk"
import axios from "axios"
import crypto from "crypto"
import { execa } from "execa"
import fs from "fs/promises"
import os from "os"
import pWaitFor from "p-wait-for"
import * as path from "path"
import * as vscode from "vscode"
import { buildApiHandler } from "../../api"
import { downloadTask } from "../../integrations/misc/export-markdown"
import { openFile, openImage } from "../../integrations/misc/open-file"
import { fetchOpenGraphData, isImageUrl } from "../../integrations/misc/link-preview"
import { selectImages } from "../../integrations/misc/process-images"
import { getTheme } from "../../integrations/theme/getTheme"
import WorkspaceTracker from "../../integrations/workspace/WorkspaceTracker"
import { ClineAccountService } from "../../services/account/ClineAccountService"
import { McpHub } from "../../services/mcp/McpHub"
import { UserInfo } from "../../shared/UserInfo"
import { ApiConfiguration, ApiProvider, ModelInfo } from "../../shared/api"
import { findLast } from "../../shared/array"
import { AutoApprovalSettings, DEFAULT_AUTO_APPROVAL_SETTINGS } from "../../shared/AutoApprovalSettings"
import { BrowserSettings, DEFAULT_BROWSER_SETTINGS } from "../../shared/BrowserSettings"
import { ChatContent } from "../../shared/ChatContent"
import { ChatSettings, DEFAULT_CHAT_SETTINGS } from "../../shared/ChatSettings"
import { ExtensionMessage, ExtensionState, Invoke, Platform } from "../../shared/ExtensionMessage"
import { HistoryItem } from "../../shared/HistoryItem"
import { McpDownloadResponse, McpMarketplaceCatalog, McpServer } from "../../shared/mcp"
import { ClineCheckpointRestore, WebviewMessage } from "../../shared/WebviewMessage"
import { fileExistsAtPath } from "../../utils/fs"
import { searchCommits } from "../../utils/git"
import { Cline } from "../Cline"
import { openMention } from "../mentions"
import { getNonce } from "./getNonce"
import { getUri } from "./getUri"
import { telemetryService } from "../../services/telemetry/TelemetryService"
import { TelemetrySetting } from "../../shared/TelemetrySetting"
import { cleanupLegacyCheckpoints } from "../../integrations/checkpoints/CheckpointMigration"
import CheckpointTracker from "../../integrations/checkpoints/CheckpointTracker"
import { getTotalTasksSize } from "../../utils/storage"
import { ConversationTelemetryService } from "../../services/telemetry/ConversationTelemetryService"
import { GlobalFileNames } from "../../global-constants"
import delay from "delay"

/*
https://github.com/microsoft/vscode-webview-ui-toolkit-samples/blob/main/default/weather-webview/src/providers/WeatherViewProvider.ts

https://github.com/KumarVariable/vscode-extension-sidebar-html/blob/master/src/customSidebarViewProvider.ts
*/
/**
 * `vscode.ExtensionContext.secrets` 是 SecretStorage 接口类型的实例，它允许扩展开发者 存储和检索敏感信息。
 * SecretKey 是 Cline 定义的敏感信息 key 的类型。
 * 定义了一系列敏感信息的键名，用于标识不同的API密钥或认证令牌。
 * 这些密钥在系统配置和请求认证中被使用。
 */
type SecretKey =
	| "apiKey"
	| "clineApiKey"
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
	| "authNonce"
	| "asksageApiKey"
	| "xaiApiKey"
	| "sambanovaApiKey"
type GlobalStateKey =
	| "apiProvider"
	| "apiModelId"
	| "awsRegion"
	| "awsUseCrossRegionInference"
	| "awsBedrockUsePromptCache"
	| "awsBedrockEndpoint"
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
	| "ollamaApiOptionsCtxNum"
	| "lmStudioModelId"
	| "lmStudioBaseUrl"
	| "anthropicBaseUrl"
	| "azureApiVersion"
	| "openRouterModelId"
	| "openRouterModelInfo"
	| "openRouterProviderSorting"
	| "autoApprovalSettings"
	| "browserSettings"
	| "chatSettings"
	| "vsCodeLmModelSelector"
	| "userInfo"
	| "previousModeApiProvider"
	| "previousModeModelId"
	| "previousModeThinkingBudgetTokens"
	| "previousModeModelInfo"
	| "liteLlmBaseUrl"
	| "liteLlmModelId"
	| "qwenApiLine"
	| "requestyModelId"
	| "togetherModelId"
	| "mcpMarketplaceCatalog"
	| "telemetrySetting"
	| "asksageApiUrl"
	| "thinkingBudgetTokens"
	| "planActSeparateModelsSetting"

/**
 * ClineProvider 实现了 vscode.WebviewViewProvider 接口，是 Cline 前后端服务的桥梁：
 * 1. 创建插件的 Webview 视图。
 * 2. 管理 Cline 实例的状态（只会存在一个）
 * 3. 维护 Cline 与 Webview 之间的通信。
 *
 * 在插件启动时创建一个 ClineProvider 实例，并在插件关闭时销毁该实例。
 *
 * ClineProvider 实例用两种方式创建一个 Cline 实例作为其私有属性，用于处理用户的任务请求（新建任务/继续旧任务）。
 */
export class ClineProvider implements vscode.WebviewViewProvider {
	/** 标识视图和面板 */
	public static readonly sideBarId = "claude-dev.SidebarProvider" // used in package.json as the view's id. This value cannot be changed due to how vscode caches views based on their id, and updating the id would break existing instances of the extension.
	public static readonly tabPanelId = "claude-dev.TabPanelProvider"
	/** ClineProvider 类的静态属性集合，用于存储所有正在活跃的 ClineProvider 实例 */
	private static activeInstances: Set<ClineProvider> = new Set()
	private disposables: vscode.Disposable[] = []
	private view?: vscode.WebviewView | vscode.WebviewPanel
	private cline?: Cline
	workspaceTracker?: WorkspaceTracker
	mcpHub?: McpHub
	accountService?: ClineAccountService
	private latestAnnouncementId = "march-22-2025" // update to some unique identifier when we add a new announcement
	conversationTelemetryService: ConversationTelemetryService

	/**
	 * 构造函数用于初始化ClineProvider实例及其核心组件
	 * 初始化时，向输出通道添加一条日志，将当前实例添加到活动实例集合中，并创建 WorkspaceTracker、McpHub 实例。
	 * @param context 扩展的上下文，用于访问扩展的状态和资源
	 * @param outputChannel 输出通道，用于显示消息和日志
	 */
	constructor(
		// VSCode 插件上下文
		readonly context: vscode.ExtensionContext,
		// 使用 outputChannel 来输出调试信息
		private readonly outputChannel: vscode.OutputChannel,
	) {
		this.outputChannel.appendLine("ClineProvider instantiated")
		// 将当前实例添加到活跃实例的集合中，以便于管理和追踪
		ClineProvider.activeInstances.add(this)
		this.workspaceTracker = new WorkspaceTracker(this)
		this.mcpHub = new McpHub(this)
		this.accountService = new ClineAccountService(this)
		this.conversationTelemetryService = new ConversationTelemetryService(this)

		// Clean up legacy checkpoints
		cleanupLegacyCheckpoints(this.context.globalStorageUri.fsPath, this.outputChannel).catch((error) => {
			console.error("Failed to cleanup legacy checkpoints:", error)
		})
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
		this.outputChannel.appendLine("Disposing ClineProvider...")

		// 清除任务并记录日志
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
		this.accountService = undefined
		this.conversationTelemetryService.shutdown()
		this.outputChannel.appendLine("Disposed all disposables")

		// 从活动实例集合中删除当前实例
		ClineProvider.activeInstances.delete(this)
	}

	async handleSignOut() {
		try {
			await this.storeSecret("clineApiKey", undefined)
			await this.updateGlobalState("apiProvider", "openrouter")
			await this.postStateToWebview()
			vscode.window.showInformationMessage("Successfully logged out of Cline")
		} catch (error) {
			vscode.window.showErrorMessage("Logout failed")
		}
	}

	async setUserInfo(info?: { displayName: string | null; email: string | null; photoURL: string | null }) {
		await this.updateGlobalState("userInfo", info)
	}

	/**
	 * 遍历所有正在活跃的 ClineProvider 实例，并返回最后一个“视图”可见的实例。
	 * 如果没有可见的实例，则返回 undefined。
	 */
	public static getVisibleInstance(): ClineProvider | undefined {
		return findLast(Array.from(this.activeInstances), (instance) => instance.view?.visible === true)
	}

	/**
	 * 【主线】解析和配置 VSCode 的 Webview 视图。
	 * 主要功能包括：设置 Webview 的选项和 HTML 内容、监听消息、处理视图可见性变化、监听视图关闭事件、监听主题颜色变化、清除任务状态。
	 * @param webviewView 表示一个 Webview 视图或面板
	 */
	async resolveWebviewView(webviewView: vscode.WebviewView | vscode.WebviewPanel) {
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
		webviewView.webview.html =
			this.context.extensionMode === vscode.ExtensionMode.Development
				? await this.getHMRHtmlContent(webviewView.webview)
				: this.getHtmlContent(webviewView.webview)

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

		// Listen for configuration changes
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
				if (e && e.affectsConfiguration("cline.mcpMarketplace.enabled")) {
					// Update state when marketplace tab setting changes
					await this.postStateToWebview()
				}
			},
			null,
			this.disposables,
		)

		// if the extension is starting a new session, clear previous task state
		this.clearTask()

		this.outputChannel.appendLine("Webview view resolved")
	}

	/**
	 * 【主线】使用指定的任务和可选的图片初始化 Cline 实例。
	 * 该函数确保在启动新任务之前清除任何现有任务，然后获取必要的状态以创建新的 `Cline` 实例。
	 */
	async initClineWithTask(task?: string, images?: string[]) {
		await this.clearTask() // ensures that an existing task doesn't exist before starting a new one, although this shouldn't be possible since user must clear task before starting a new one
		// 获取当前状态，包括 API 配置、自定义指令、自动批准设置、浏览器设置和聊天设置
		const { apiConfiguration, customInstructions, autoApprovalSettings, browserSettings, chatSettings } =
			await this.getState()
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
	 */
	async initClineWithHistoryItem(historyItem: HistoryItem) {
		await this.clearTask()
		const { apiConfiguration, customInstructions, autoApprovalSettings, browserSettings, chatSettings } =
			await this.getState()

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
	 * 前端通过监听 "message" 事件，在 WebView 内接收来自插件的消息。（见 webview-ui\src\context\ExtensionStateContext.tsx）
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

		// 获取在 Webview 中运行的主脚本的本地路径，并将其转换为可在 Webview 中使用的 URI。

		// The CSS file from the React build output
		const stylesUri = getUri(webview, this.context.extensionUri, ["webview-ui", "build", "assets", "index.css"])
		// The JS file from the React build output
		const scriptUri = getUri(webview, this.context.extensionUri, ["webview-ui", "build", "assets", "index.js"])

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
            <link rel="stylesheet" type="text/css" href="${stylesUri}">
            <link href="${codiconsUri}" rel="stylesheet" />
						<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src https://*.posthog.com https://*.firebaseauth.com https://*.firebaseio.com https://*.googleapis.com https://*.firebase.com; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}' 'unsafe-eval';">
            <title>Cline</title>
          </head>
          <body>
            <noscript>You need to enable JavaScript to run this app.</noscript>
            <div id="root"></div>
            <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
          </body>
        </html>
      `
	}

	/**
	 * Connects to the local Vite dev server to allow HMR, with fallback to the bundled assets
	 *
	 * @param webview A reference to the extension webview
	 * @returns A template string literal containing the HTML that should be
	 * rendered within the webview panel
	 */
	private async getHMRHtmlContent(webview: vscode.Webview): Promise<string> {
		const localPort = 25463
		const localServerUrl = `localhost:${localPort}`

		// Check if local dev server is running.
		try {
			await axios.get(`http://${localServerUrl}`)
		} catch (error) {
			vscode.window.showErrorMessage(
				"Cline: Local webview dev server is not running, HMR will not work. Please run 'npm run dev:webview' before launching the extension to enable HMR. Using bundled assets.",
			)

			return this.getHtmlContent(webview)
		}

		const nonce = getNonce()
		const stylesUri = getUri(webview, this.context.extensionUri, ["webview-ui", "build", "assets", "index.css"])
		const codiconsUri = getUri(webview, this.context.extensionUri, [
			"node_modules",
			"@vscode",
			"codicons",
			"dist",
			"codicon.css",
		])

		const scriptEntrypoint = "src/main.tsx"
		const scriptUri = `http://${localServerUrl}/${scriptEntrypoint}`

		const reactRefresh = /*html*/ `
			<script nonce="${nonce}" type="module">
				import RefreshRuntime from "http://${localServerUrl}/@react-refresh"
				RefreshRuntime.injectIntoGlobalHook(window)
				window.$RefreshReg$ = () => {}
				window.$RefreshSig$ = () => (type) => type
				window.__vite_plugin_react_preamble_installed__ = true
			</script>
		`

		const csp = [
			"default-src 'none'",
			`font-src ${webview.cspSource}`,
			`style-src ${webview.cspSource} 'unsafe-inline' https://* http://${localServerUrl} http://0.0.0.0:${localPort}`,
			`img-src ${webview.cspSource} https: data:`,
			`script-src 'unsafe-eval' https://* http://${localServerUrl} http://0.0.0.0:${localPort} 'nonce-${nonce}'`,
			`connect-src https://* ws://${localServerUrl} ws://0.0.0.0:${localPort} http://${localServerUrl} http://0.0.0.0:${localPort}`,
		]

		return /*html*/ `
			<!DOCTYPE html>
			<html lang="en">
				<head>
					<meta charset="utf-8">
					<meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
					<meta http-equiv="Content-Security-Policy" content="${csp.join("; ")}">
					<link rel="stylesheet" type="text/css" href="${stylesUri}">
					<link href="${codiconsUri}" rel="stylesheet" />
					<title>Cline</title>
				</head>
				<body>
					<div id="root"></div>
					${reactRefresh}
					<script type="module" src="${scriptUri}"></script>
				</body>
			</html>
		`
	}

	/**
	 * 【主线】设置一个事件侦听器来侦听从 webview 上下文传递的消息，并根据收到的消息执行代码。
	 * 其实就是封装了 `webview.onDidReceiveMessage()`
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
					case "authStateChanged":
						await this.setUserInfo(message.user || undefined)
						await this.postStateToWebview()
						break
					case "webviewDidLaunch":
						this.postStateToWebview()
						this.workspaceTracker?.populateFilePaths() // don't await
						getTheme().then((theme) =>
							this.postMessageToWebview({
								type: "theme",
								text: JSON.stringify(theme),
							}),
						)
						// post last cached models in case the call to endpoint fails
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

						// If user already opted in to telemetry, enable telemetry service
						this.getStateToPostToWebview().then((state) => {
							const { telemetrySetting } = state
							const isOptedIn = telemetrySetting === "enabled"
							telemetryService.updateTelemetryState(isOptedIn)
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
						await this.initClineWithTask(message.text, message.images)
						break
					case "apiConfiguration":
						if (message.apiConfiguration) {
							await this.updateApiConfiguration(message.apiConfiguration)
						}
						await this.postStateToWebview()
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
					case "optionsResponse":
						await this.postMessageToWebview({
							type: "invoke",
							invoke: "sendMessage",
							text: message.text,
						})
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
						await this.clearTask()
						await this.postStateToWebview()
						break
					case "didShowAnnouncement":
						await this.updateGlobalState("lastShownAnnouncementId", this.latestAnnouncementId)
						await this.postStateToWebview()
						break
					case "selectImages":
						const images = await selectImages()
						await this.postMessageToWebview({
							type: "selectedImages",
							images,
						})
						break
					case "exportCurrentTask":
						const currentTaskId = this.cline?.taskId
						if (currentTaskId) {
							this.exportTaskWithId(currentTaskId)
						}
						break
					case "showTaskWithId":
						this.showTaskWithId(message.text!)
						break
					case "deleteTaskWithId":
						this.deleteTaskWithId(message.text!)
						break
					case "exportTaskWithId":
						this.exportTaskWithId(message.text!)
						break
					case "resetState":
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
						openImage(message.text!)
						break
					case "openInBrowser":
						if (message.url) {
							vscode.env.openExternal(vscode.Uri.parse(message.url))
						}
						break
					case "fetchOpenGraphData":
						this.fetchOpenGraphData(message.text!)
						break
					case "checkIsImageUrl":
						this.checkIsImageUrl(message.text!)
						break
					case "openFile":
						openFile(message.text!)
						break
					case "openMention":
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
						this.cancelTask()
						break
					case "getLatestState":
						await this.postStateToWebview()
						break
					case "accountLoginClicked": {
						// Generate nonce for state validation
						const nonce = crypto.randomBytes(32).toString("hex")
						await this.storeSecret("authNonce", nonce)

						// Open browser for authentication with state param
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
						await this.handleSignOut()
						break
					}
					case "showAccountViewClicked": {
						await this.postMessageToWebview({ type: "action", action: "accountButtonClicked" })
						break
					}
					case "fetchUserCreditsData": {
						await this.fetchUserCreditsData()
						break
					}
					case "showMcpView": {
						await this.postMessageToWebview({ type: "action", action: "mcpButtonClicked" })
						break
					}
					case "openMcpSettings": {
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
						try {
							await this.mcpHub?.toggleToolAutoApprove(message.serverName!, message.toolName!, message.autoApprove!)
						} catch (error) {
							console.error(`Failed to toggle auto-approve for tool ${message.toolName}:`, error)
						}
						break
					}
					case "requestTotalTasksSize": {
						this.refreshTotalTasksSize()
						break
					}
					case "restartMcpServer": {
						try {
							await this.mcpHub?.restartConnection(message.text!)
						} catch (error) {
							console.error(`Failed to retry connection for ${message.text}:`, error)
						}
						break
					}
					case "deleteMcpServer": {
						if (message.serverName) {
							this.mcpHub?.deleteServer(message.serverName)
						}
						break
					}
					case "fetchLatestMcpServersFromHub": {
						this.mcpHub?.sendLatestMcpServers()
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
					case "updateMcpTimeout": {
						try {
							if (message.serverName && message.timeout) {
								await this.mcpHub?.updateServerTimeout(message.serverName, message.timeout)
							}
						} catch (error) {
							console.error(`Failed to update timeout for server ${message.serverName}:`, error)
						}
						break
					}
					case "openExtensionSettings": {
						const settingsFilter = message.text || ""
						await vscode.commands.executeCommand(
							"workbench.action.openSettings",
							`@ext:saoudrizwan.claude-dev ${settingsFilter}`.trim(), // trim whitespace if no settings filter
						)
						break
					}
					case "invoke": {
						if (message.text) {
							await this.postMessageToWebview({
								type: "invoke",
								invoke: message.text as Invoke,
							})
						}
						break
					}
					// telemetry
					case "openSettings": {
						await this.postMessageToWebview({
							type: "action",
							action: "settingsButtonClicked",
						})
						break
					}
					case "telemetrySetting": {
						if (message.telemetrySetting) {
							await this.updateTelemetrySetting(message.telemetrySetting)
						}
						await this.postStateToWebview()
						break
					}
					case "updateSettings": {
						// api config
						if (message.apiConfiguration) {
							await this.updateApiConfiguration(message.apiConfiguration)
						}

						// custom instructions
						await this.updateCustomInstructions(message.customInstructionsSetting)

						// telemetry setting
						if (message.telemetrySetting) {
							await this.updateTelemetrySetting(message.telemetrySetting)
						}

						// plan act setting
						await this.updateGlobalState("planActSeparateModelsSetting", message.planActSeparateModelsSetting)

						// after settings are updated, post state to webview
						await this.postStateToWebview()

						await this.postMessageToWebview({ type: "didUpdateSettings" })
						break
					}
					case "clearAllTaskHistory": {
						await this.deleteAllTaskHistory()
						await this.postStateToWebview()
						this.refreshTotalTasksSize()
						this.postMessageToWebview({ type: "relinquishControl" })
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

	async updateTelemetrySetting(telemetrySetting: TelemetrySetting) {
		await this.updateGlobalState("telemetrySetting", telemetrySetting)
		const isOptedIn = telemetrySetting === "enabled"
		telemetryService.updateTelemetryState(isOptedIn)
	}

	async togglePlanActModeWithChatSettings(chatSettings: ChatSettings, chatContent?: ChatContent) {
		const didSwitchToActMode = chatSettings.mode === "act"

		// Capture mode switch telemetry | Capture regardless of if we know the taskId
		telemetryService.captureModeSwitch(this.cline?.taskId ?? "0", chatSettings.mode)

		// Get previous model info that we will revert to after saving current mode api info
		const {
			apiConfiguration,
			previousModeApiProvider: newApiProvider,
			previousModeModelId: newModelId,
			previousModeModelInfo: newModelInfo,
			previousModeThinkingBudgetTokens: newThinkingBudgetTokens,
			planActSeparateModelsSetting,
		} = await this.getState()

		const shouldSwitchModel = planActSeparateModelsSetting === true

		if (shouldSwitchModel) {
			// Save the last model used in this mode
			await this.updateGlobalState("previousModeApiProvider", apiConfiguration.apiProvider)
			await this.updateGlobalState("previousModeThinkingBudgetTokens", apiConfiguration.thinkingBudgetTokens)
			switch (apiConfiguration.apiProvider) {
				case "anthropic":
				case "bedrock":
				case "vertex":
				case "gemini":
				case "asksage":
				case "openai-native":
				case "qwen":
				case "deepseek":
					await this.updateGlobalState("previousModeModelId", apiConfiguration.apiModelId)
					break
				case "openrouter":
				case "cline":
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
				case "requesty":
					await this.updateGlobalState("previousModeModelId", apiConfiguration.requestyModelId)
					break
			}

			// Restore the model used in previous mode
			if (newApiProvider || newModelId || newThinkingBudgetTokens !== undefined) {
				await this.updateGlobalState("apiProvider", newApiProvider)
				await this.updateGlobalState("thinkingBudgetTokens", newThinkingBudgetTokens)
				switch (newApiProvider) {
					case "anthropic":
					case "bedrock":
					case "vertex":
					case "gemini":
					case "asksage":
					case "openai-native":
					case "qwen":
					case "deepseek":
						await this.updateGlobalState("apiModelId", newModelId)
						break
					case "openrouter":
					case "cline":
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
					case "requesty":
						await this.updateGlobalState("requestyModelId", newModelId)
						break
				}

				if (this.cline) {
					const { apiConfiguration: updatedApiConfiguration } = await this.getState()
					this.cline.api = buildApiHandler(updatedApiConfiguration)
				}
			}
		}

		await this.updateGlobalState("chatSettings", chatSettings)
		await this.postStateToWebview()

		if (this.cline) {
			this.cline.updateChatSettings(chatSettings)
			if (this.cline.isAwaitingPlanResponse && didSwitchToActMode) {
				this.cline.didRespondToPlanAskBySwitchingMode = true
				// Use chatContent if provided, otherwise use default message
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

	async cancelTask() {
		if (this.cline) {
			// 获取与当前任务ID相关的历史项
			const { historyItem } = await this.getTaskWithId(this.cline.taskId)
			// 尝试中止任务
			try {
				await this.cline.abortTask()
			} catch (error) {
				console.error("Failed to abort task", error)
			}
			// 等待任务状态变为可中止状态，或者超时
			await pWaitFor(
				() =>
					this.cline === undefined ||
					this.cline.isStreaming === false ||
					this.cline.didFinishAbortingStream ||
					this.cline.isWaitingForFirstChunk, // if only first chunk is processed, then there's no need to wait for graceful abort (closes edits, browser, etc)
				{
					timeout: 3_000,
				},
			).catch(() => {
				console.error("Failed to abort task")
			})

			// 如果 Cline 实例仍然存在，将该实例标记为 已废弃，以防止影响后续 Cline 实例的 GUI
			if (this.cline) {
				// 'abandoned' will prevent this cline instance from affecting future cline instance gui. this may happen if its hanging on a streaming request
				this.cline.abandoned = true
			}

			await this.initClineWithHistoryItem(historyItem) // clears task again, so we need to abortTask manually above
			// await this.postStateToWebview() // new Cline instance will post state when it's ready. having this here sent an empty messages array to webview leading to virtuoso having to reload the entire list
		}
	}

	/**
	 * 更新全局状态中的自定义指令，并同步更新相关的 Cline 实例（如果存在）。
	 * 最后，将更新后的状态发送到Webview。
	 * @param {string} [instructions] - 可选参数，表示新的自定义指令内容。如果未提供或为空字符串，则视为清除自定义指令。
	 */
	async updateCustomInstructions(instructions?: string) {
		// User may be clearing the field
		await this.updateGlobalState("customInstructions", instructions || undefined)

		if (this.cline) {
			this.cline.customInstructions = instructions || undefined
		}
	}

	async updateApiConfiguration(apiConfiguration: ApiConfiguration) {
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
			awsBedrockUsePromptCache,
			awsBedrockEndpoint,
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
			ollamaApiOptionsCtxNum,
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
			openRouterProviderSorting,
			vsCodeLmModelSelector,
			liteLlmBaseUrl,
			liteLlmModelId,
			liteLlmApiKey,
			qwenApiLine,
			asksageApiKey,
			asksageApiUrl,
			xaiApiKey,
			thinkingBudgetTokens,
			clineApiKey,
			sambanovaApiKey,
		} = apiConfiguration
		await this.updateGlobalState("apiProvider", apiProvider)
		await this.updateGlobalState("apiModelId", apiModelId)
		await this.storeSecret("apiKey", apiKey)
		await this.storeSecret("openRouterApiKey", openRouterApiKey)
		await this.storeSecret("awsAccessKey", awsAccessKey)
		await this.storeSecret("awsSecretKey", awsSecretKey)
		await this.storeSecret("awsSessionToken", awsSessionToken)
		await this.updateGlobalState("awsRegion", awsRegion)
		await this.updateGlobalState("awsUseCrossRegionInference", awsUseCrossRegionInference)
		await this.updateGlobalState("awsBedrockUsePromptCache", awsBedrockUsePromptCache)
		await this.updateGlobalState("awsBedrockEndpoint", awsBedrockEndpoint)
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
		await this.updateGlobalState("ollamaApiOptionsCtxNum", ollamaApiOptionsCtxNum)
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
		await this.storeSecret("xaiApiKey", xaiApiKey)
		await this.updateGlobalState("azureApiVersion", azureApiVersion)
		await this.updateGlobalState("openRouterModelId", openRouterModelId)
		await this.updateGlobalState("openRouterModelInfo", openRouterModelInfo)
		await this.updateGlobalState("openRouterProviderSorting", openRouterProviderSorting)
		await this.updateGlobalState("vsCodeLmModelSelector", vsCodeLmModelSelector)
		await this.updateGlobalState("liteLlmBaseUrl", liteLlmBaseUrl)
		await this.updateGlobalState("liteLlmModelId", liteLlmModelId)
		await this.updateGlobalState("qwenApiLine", qwenApiLine)
		await this.updateGlobalState("requestyModelId", requestyModelId)
		await this.updateGlobalState("togetherModelId", togetherModelId)
		await this.storeSecret("asksageApiKey", asksageApiKey)
		await this.updateGlobalState("asksageApiUrl", asksageApiUrl)
		await this.updateGlobalState("thinkingBudgetTokens", thinkingBudgetTokens)
		await this.storeSecret("clineApiKey", clineApiKey)
		await this.storeSecret("sambanovaApiKey", sambanovaApiKey)
		if (this.cline) {
			this.cline.api = buildApiHandler(apiConfiguration)
		}
	}

	// MCP

	/* 根据操作系统的不同，返回用户的文档目录路径。只在MCP中用到 */
	async getDocumentsPath(): Promise<string> {
		if (process.platform === "win32") {
			try {
				const { stdout: docsPath } = await execa("powershell", [
					"-NoProfile", // Ignore user's PowerShell profile(s)
					"-Command",
					"[System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::MyDocuments)",
				])
				const trimmedPath = docsPath.trim()
				if (trimmedPath) {
					return trimmedPath
				}
			} catch (err) {
				// 如果获取失败，回退到默认的 `~/Documents` 路径
				console.error("Failed to retrieve Windows Documents path. Falling back to homedir/Documents.")
			}
		} else if (process.platform === "linux") {
			try {
				// First check if xdg-user-dir exists
				await execa("which", ["xdg-user-dir"])

				// If it exists, try to get XDG documents path
				const { stdout } = await execa("xdg-user-dir", ["DOCUMENTS"])
				const trimmedPath = stdout.trim()
				if (trimmedPath) {
					return trimmedPath
				}
			} catch {
				// Log error but continue to fallback
				console.error("Failed to retrieve XDG Documents path. Falling back to homedir/Documents.")
			}
		}

		// Default fallback for all platforms
		return path.join(os.homedir(), "Documents")
	}

	/** 确保 `~/Documents/Cline/MCP` 目录存在。如果目录不存在，则递归创建该目录。 */
	async ensureMcpServersDirectoryExists(): Promise<string> {
		const userDocumentsPath = await this.getDocumentsPath()
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

	/** 确保 [context.globalStorageUri.fsPath]/settings 目录存在。如果目录不存在，则递归创建该目录。 */
	async ensureSettingsDirectoryExists(): Promise<string> {
		const settingsDir = path.join(this.context.globalStorageUri.fsPath, "settings")
		await fs.mkdir(settingsDir, { recursive: true })
		return settingsDir
	}

	// VSCode LM API

	private async getVsCodeLmModels() {
		try {
			const models = await vscode.lm.selectChatModels({})
			return models || []
		} catch (error) {
			console.error("Error fetching VS Code LM models:", error)
			return []
		}
	}

	// Ollama

	async getOllamaModels(baseUrl?: string) {
		try {
			if (!baseUrl) {
				// Ollama 默认的本地 URL
				baseUrl = "http://localhost:11434"
			}
			if (!URL.canParse(baseUrl)) {
				// 检查 URL 是否有效，如果无效则返回空数组
				return []
			}
			// 向 Ollama API 发送请求，获取模型列表
			const response = await axios.get(`${baseUrl}/api/tags`)
			const modelsArray = response.data?.models?.map((model: any) => model.name) || []
			const models = [...new Set<string>(modelsArray)]
			return models
		} catch (error) {
			return []
		}
	}

	// LM Studio

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

	// Account

	async fetchUserCreditsData() {
		try {
			await Promise.all([
				this.accountService?.fetchBalance(),
				this.accountService?.fetchUsageTransactions(),
				this.accountService?.fetchPaymentTransactions(),
			])
		} catch (error) {
			console.error("Failed to fetch user credits data:", error)
		}
	}

	// Auth

	/**
	 * 验证授权状态是否有效：查看传入的参数 授权状态 `state` 是否与存储的 `authNonce` 值匹配。
	 * 如果匹配，则清除存储的 `authNonce` 并返回 `true`；否则返回 `false`。
	 * @param state - 待验证的授权状态字符串，可能为 `null`。
	 */
	public async validateAuthState(state: string | null): Promise<boolean> {
		const storedNonce = await this.getSecret("authNonce")

		// 如果传入的 `state` 为空或与存储的 `authNonce` 不匹配，返回 `false`
		if (!state || state !== storedNonce) {
			return false
		}
		// 验证成功后，清除存储的 `authNonce`，防止重复使用
		await this.storeSecret("authNonce", undefined) // Clear after use
		return true
	}

	async handleAuthCallback(customToken: string, apiKey: string) {
		try {
			// Store API key for API calls
			await this.storeSecret("clineApiKey", apiKey)

			// Send custom token to webview for Firebase auth
			await this.postMessageToWebview({
				type: "authCallback",
				customToken,
			})

			const clineProvider: ApiProvider = "cline"
			await this.updateGlobalState("apiProvider", clineProvider)

			// Update API configuration with the new provider and API key
			const { apiConfiguration } = await this.getState()
			const updatedConfig = {
				...apiConfiguration,
				apiProvider: clineProvider,
				clineApiKey: apiKey,
			}

			if (this.cline) {
				this.cline.api = buildApiHandler(updatedConfig)
			}

			await this.postStateToWebview()
			// vscode.window.showInformationMessage("Successfully logged in to Cline")
		} catch (error) {
			console.error("Failed to handle auth callback:", error)
			vscode.window.showErrorMessage("Failed to log in to Cline")
			// Even on login failure, we preserve any existing tokens
			// Only clear tokens on explicit logout
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

			// Create task with context from README and added guidelines for MCP server installation
			const task = `Set up the MCP server from ${mcpDetails.githubUrl} while adhering to these MCP server installation rules:
- Use "${mcpDetails.mcpId}" as the server name in cline_mcp_settings.json.
- Create the directory for the new MCP server before starting installation.
- Use commands aligned with the user's shell and operating system best practices.
- The following README may contain instructions that conflict with the user's OS, in which case proceed thoughtfully.
- Once installed, demonstrate the server's capabilities by using one of its tools.
Here is the project's README to help you get started:\n\n${mcpDetails.readmeContent}\n${mcpDetails.llmsInstallationContent}`

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
	 * 调用指定的 API 地址获取可用的 OpenAI 模型列表，并返回去重后的模型 ID 数组。
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
	 * 处理 OpenRouter 的回调。在用户完成 OpenRouter 授权后，通过授权码获取 API 密钥并更新相关配置。
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

	/** 确保 [context.globalStorageUri.fsPath]/cache 目录存在。如果目录不存在，则递归创建该目录。 */
	private async ensureCacheDirectoryExists(): Promise<string> {
		const cacheDir = path.join(this.context.globalStorageUri.fsPath, "cache")
		await fs.mkdir(cacheDir, { recursive: true })
		return cacheDir
	}

	/**
	 * 读取 OpenRouter 模型信息文件（openrouter_models.json）并解析为对象。
	 * @returns {Promise<Record<string, ModelInfo> | undefined>} 返回一个 Promise，解析为包含模型信息的对象，如果文件不存在则返回 undefined。
	 */
	async readOpenRouterModels(): Promise<Record<string, ModelInfo> | undefined> {
		const openRouterModelsFilePath = path.join(await this.ensureCacheDirectoryExists(), GlobalFileNames.openRouterModels)
		const fileExists = await fileExistsAtPath(openRouterModelsFilePath)
		if (fileExists) {
			const fileContents = await fs.readFile(openRouterModelsFilePath, "utf8")
			return JSON.parse(fileContents)
		}
		return undefined
	}

	/**
	 * 从OpenRouter的API获取最新的模型数据，并将其保存到 openrouter_models.json 中。
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
						case "anthropic/claude-3-7-sonnet":
						case "anthropic/claude-3-7-sonnet:beta":
						case "anthropic/claude-3.7-sonnet":
						case "anthropic/claude-3.7-sonnet:beta":
						case "anthropic/claude-3.7-sonnet:thinking":
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

	// Context menus and code actions

	getFileMentionFromPath(filePath: string) {
		const cwd = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).at(0)
		if (!cwd) {
			return "@/" + filePath
		}
		const relativePath = path.relative(cwd, filePath)
		return "@/" + relativePath
	}

	// 'Add to Cline' context menu in editor and code action
	async addSelectedCodeToChat(code: string, filePath: string, languageId: string, diagnostics?: vscode.Diagnostic[]) {
		// Ensure the sidebar view is visible
		await vscode.commands.executeCommand("claude-dev.SidebarProvider.focus")
		await delay(100)

		// Post message to webview with the selected code
		const fileMention = this.getFileMentionFromPath(filePath)

		let input = `${fileMention}\n\`\`\`\n${code}\n\`\`\``
		if (diagnostics) {
			const problemsString = this.convertDiagnosticsToProblemsString(diagnostics)
			input += `\nProblems:\n${problemsString}`
		}

		await this.postMessageToWebview({
			type: "addToInput",
			text: input,
		})

		console.log("addSelectedCodeToChat", code, filePath, languageId)
	}

	// 'Add to Cline' context menu in Terminal
	async addSelectedTerminalOutputToChat(output: string, terminalName: string) {
		// Ensure the sidebar view is visible
		await vscode.commands.executeCommand("claude-dev.SidebarProvider.focus")
		await delay(100)

		// Post message to webview with the selected terminal output
		// await this.postMessageToWebview({
		//     type: "addSelectedTerminalOutput",
		//     output,
		//     terminalName
		// })

		await this.postMessageToWebview({
			type: "addToInput",
			text: `Terminal output:\n\`\`\`\n${output}\n\`\`\``,
		})

		console.log("addSelectedTerminalOutputToChat", output, terminalName)
	}

	// 'Fix with Cline' in code actions
	async fixWithCline(code: string, filePath: string, languageId: string, diagnostics: vscode.Diagnostic[]) {
		// Ensure the sidebar view is visible
		await vscode.commands.executeCommand("claude-dev.SidebarProvider.focus")
		await delay(100)

		const fileMention = this.getFileMentionFromPath(filePath)
		const problemsString = this.convertDiagnosticsToProblemsString(diagnostics)
		await this.initClineWithTask(
			`Fix the following code in ${fileMention}\n\`\`\`\n${code}\n\`\`\`\n\nProblems:\n${problemsString}`,
		)

		console.log("fixWithCline", code, filePath, languageId, diagnostics, problemsString)
	}

	convertDiagnosticsToProblemsString(diagnostics: vscode.Diagnostic[]) {
		let problemsString = ""
		for (const diagnostic of diagnostics) {
			let label: string
			switch (diagnostic.severity) {
				case vscode.DiagnosticSeverity.Error:
					label = "Error"
					break
				case vscode.DiagnosticSeverity.Warning:
					label = "Warning"
					break
				case vscode.DiagnosticSeverity.Information:
					label = "Information"
					break
				case vscode.DiagnosticSeverity.Hint:
					label = "Hint"
					break
				default:
					label = "Diagnostic"
			}
			const line = diagnostic.range.start.line + 1 // VSCode lines are 0-indexed
			const source = diagnostic.source ? `${diagnostic.source} ` : ""
			problemsString += `\n- [${source}${label}] Line ${line}: ${diagnostic.message}`
		}
		problemsString = problemsString.trim()
		return problemsString
	}

	// Task history

	/**
	 * 根据任务ID获取任务相关的详细信息。
	 *
	 * 该函数会从全局状态中获取任务历史记录，并根据提供的任务ID查找对应的任务项。
	 * 如果找到任务项，会进一步获取任务目录路径、API对话历史文件路径、UI消息文件路径，
	 * 并读取API对话历史文件内容。如果任务不存在，则从状态中删除该任务ID并抛出错误。
	 * @param id - 任务的唯一标识符。
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
	 * @param id - 要显示的任务的唯一标识符。
	 */
	async showTaskWithId(id: string) {
		// 如果任务ID与当前任务ID不同，则获取任务历史记录并初始化客户端
		if (id !== this.cline?.taskId) {
			// non-current task
			const { historyItem } = await this.getTaskWithId(id)
			await this.initClineWithHistoryItem(historyItem) // clears existing task
		}

		await this.postMessageToWebview({
			type: "action",
			action: "chatButtonClicked",
		})
	}

	/**
	 * 通过任务ID获取任务的历史记录和API对话历史，然后调用下载函数将任务数据导出。
	 * @param id - 任务的唯一标识符，用于查找对应的任务数据
	 */
	async exportTaskWithId(id: string) {
		const { historyItem, apiConversationHistory } = await this.getTaskWithId(id)
		await downloadTask(historyItem.ts, apiConversationHistory)
	}

	async deleteAllTaskHistory() {
		await this.clearTask()
		await this.updateGlobalState("taskHistory", undefined)
		try {
			// Remove all contents of tasks directory
			const taskDirPath = path.join(this.context.globalStorageUri.fsPath, "tasks")
			if (await fileExistsAtPath(taskDirPath)) {
				await fs.rm(taskDirPath, { recursive: true, force: true })
			}
			// Remove checkpoints directory contents
			const checkpointsDirPath = path.join(this.context.globalStorageUri.fsPath, "checkpoints")
			if (await fileExistsAtPath(checkpointsDirPath)) {
				await fs.rm(checkpointsDirPath, { recursive: true, force: true })
			}
		} catch (error) {
			vscode.window.showErrorMessage(
				`Encountered error while deleting task history, there may be some files left behind. Error: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		// await this.postStateToWebview()
	}

	async refreshTotalTasksSize() {
		getTotalTasksSize(this.context.globalStorageUri.fsPath)
			.then((newTotalSize) => {
				this.postMessageToWebview({
					type: "totalTasksSize",
					totalTasksSize: newTotalSize,
				})
			})
			.catch((error) => {
				console.error("Error calculating total tasks size:", error)
			})
	}

	async deleteTaskWithId(id: string) {
		console.info("deleteTaskWithId: ", id)

		try {
			if (id === this.cline?.taskId) {
				await this.clearTask()
				console.debug("cleared task")
			}

			const { taskDirPath, apiConversationHistoryFilePath, uiMessagesFilePath } = await this.getTaskWithId(id)

			const updatedTaskHistory = await this.deleteTaskFromState(id)

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

			await fs.rmdir(taskDirPath) // succeeds if the dir is empty

			if (updatedTaskHistory.length === 0) {
				await this.deleteAllTaskHistory()
			}
		} catch (error) {
			console.debug(`Error deleting task:`, error)
		}

		this.refreshTotalTasksSize()
	}

	async deleteTaskFromState(id: string) {
		// Remove the task from history
		// 从全局状态中获取当前任务历史，如果不存在则初始化为空数组。
		const taskHistory = ((await this.getGlobalState("taskHistory")) as HistoryItem[] | undefined) || []
		// 过滤掉任务历史中指定ID的任务。
		const updatedTaskHistory = taskHistory.filter((task) => task.id !== id)
		// 使用更新后的任务历史更新全局状态。
		await this.updateGlobalState("taskHistory", updatedTaskHistory)

		// Notify the webview that the task has been deleted
		await this.postStateToWebview()

		return updatedTaskHistory
	}

	async postStateToWebview() {
		const state = await this.getStateToPostToWebview()
		this.postMessageToWebview({ type: "state", state })
	}

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
			mcpMarketplaceEnabled,
			telemetrySetting,
			planActSeparateModelsSetting,
		} = await this.getState()

		return {
			version: this.context.extension?.packageJSON?.version ?? "",
			apiConfiguration,
			customInstructions,
			uriScheme: vscode.env.uriScheme,
			currentTaskItem: this.cline?.taskId ? (taskHistory || []).find((item) => item.id === this.cline?.taskId) : undefined,
			checkpointTrackerErrorMessage: this.cline?.checkpointTrackerErrorMessage,
			clineMessages: this.cline?.clineMessages || [],
			taskHistory: (taskHistory || [])
				.filter((item) => item.ts && item.task)
				.sort((a, b) => b.ts - a.ts)
				.slice(0, 100), // for now we're only getting the latest 100 tasks, but a better solution here is to only pass in 3 for recent task history, and then get the full task history on demand when going to the task history view (maybe with pagination?)
			shouldShowAnnouncement: lastShownAnnouncementId !== this.latestAnnouncementId,
			platform: process.platform as Platform,
			autoApprovalSettings,
			browserSettings,
			chatSettings,
			userInfo,
			mcpMarketplaceEnabled,
			telemetrySetting,
			planActSeparateModelsSetting,
			vscMachineId: vscode.env.machineId,
		}
	}

	/**
	 * 中止当前任务并清除对 cline 实例的引用。
	 */
	async clearTask() {
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
	 * @returns {Promise<Object>} 返回一个包含所有配置和状态信息的对象，包括API配置、用户信息、任务历史、浏览器设置等。
	 */
	async getState() {
		const [
			storedApiProvider,
			apiModelId,
			apiKey,
			openRouterApiKey,
			clineApiKey,
			awsAccessKey,
			awsSecretKey,
			awsSessionToken,
			awsRegion,
			awsUseCrossRegionInference,
			awsBedrockUsePromptCache,
			awsBedrockEndpoint,
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
			ollamaApiOptionsCtxNum,
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
			openRouterProviderSorting,
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
			previousModeApiProvider,
			previousModeModelId,
			previousModeModelInfo,
			previousModeThinkingBudgetTokens,
			qwenApiLine,
			liteLlmApiKey,
			telemetrySetting,
			asksageApiKey,
			asksageApiUrl,
			xaiApiKey,
			thinkingBudgetTokens,
			sambanovaApiKey,
			planActSeparateModelsSettingRaw,
		] = await Promise.all([
			this.getGlobalState("apiProvider") as Promise<ApiProvider | undefined>,
			this.getGlobalState("apiModelId") as Promise<string | undefined>,
			this.getSecret("apiKey") as Promise<string | undefined>,
			this.getSecret("openRouterApiKey") as Promise<string | undefined>,
			this.getSecret("clineApiKey") as Promise<string | undefined>,
			this.getSecret("awsAccessKey") as Promise<string | undefined>,
			this.getSecret("awsSecretKey") as Promise<string | undefined>,
			this.getSecret("awsSessionToken") as Promise<string | undefined>,
			this.getGlobalState("awsRegion") as Promise<string | undefined>,
			this.getGlobalState("awsUseCrossRegionInference") as Promise<boolean | undefined>,
			this.getGlobalState("awsBedrockUsePromptCache") as Promise<boolean | undefined>,
			this.getGlobalState("awsBedrockEndpoint") as Promise<string | undefined>,
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
			this.getGlobalState("ollamaApiOptionsCtxNum") as Promise<string | undefined>,
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
			this.getGlobalState("openRouterProviderSorting") as Promise<string | undefined>,
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
			this.getGlobalState("previousModeApiProvider") as Promise<ApiProvider | undefined>,
			this.getGlobalState("previousModeModelId") as Promise<string | undefined>,
			this.getGlobalState("previousModeModelInfo") as Promise<ModelInfo | undefined>,
			this.getGlobalState("previousModeThinkingBudgetTokens") as Promise<number | undefined>,
			this.getGlobalState("qwenApiLine") as Promise<string | undefined>,
			this.getSecret("liteLlmApiKey") as Promise<string | undefined>,
			this.getGlobalState("telemetrySetting") as Promise<TelemetrySetting | undefined>,
			this.getSecret("asksageApiKey") as Promise<string | undefined>,
			this.getGlobalState("asksageApiUrl") as Promise<string | undefined>,
			this.getSecret("xaiApiKey") as Promise<string | undefined>,
			this.getGlobalState("thinkingBudgetTokens") as Promise<number | undefined>,
			this.getSecret("sambanovaApiKey") as Promise<string | undefined>,
			this.getGlobalState("planActSeparateModelsSetting") as Promise<boolean | undefined>,
		])

		let apiProvider: ApiProvider
		if (storedApiProvider) {
			apiProvider = storedApiProvider
		} else {
			// Either new user or legacy user that doesn't have the apiProvider stored in state
			// (If they're using OpenRouter or Bedrock, then apiProvider state will exist)
			if (apiKey) {
				apiProvider = "anthropic"
			} else {
				// New users should default to openrouter, since they've opted to use an API key instead of signing in
				apiProvider = "openrouter"
			}
		}

		const o3MiniReasoningEffort = vscode.workspace
			.getConfiguration("cline.modelSettings.o3Mini")
			.get("reasoningEffort", "medium")

		const mcpMarketplaceEnabled = vscode.workspace.getConfiguration("cline").get<boolean>("mcpMarketplace.enabled", true)

		// Plan/Act separate models setting is a boolean indicating whether the user wants to use different models for plan and act. Existing users expect this to be enabled, while we want new users to opt in to this being disabled by default.
		// On win11 state sometimes initializes as empty string instead of undefined
		let planActSeparateModelsSetting: boolean | undefined = undefined
		if (planActSeparateModelsSettingRaw === true || planActSeparateModelsSettingRaw === false) {
			planActSeparateModelsSetting = planActSeparateModelsSettingRaw
		} else {
			// default to true for existing users
			if (storedApiProvider) {
				planActSeparateModelsSetting = true
			} else {
				// default to false for new users
				planActSeparateModelsSetting = false
			}
			// this is a special case where it's a new state, but we want it to default to different values for existing and new users.
			// persist so next time state is retrieved it's set to the correct value.
			await this.updateGlobalState("planActSeparateModelsSetting", planActSeparateModelsSetting)
		}

		return {
			apiConfiguration: {
				apiProvider,
				apiModelId,
				apiKey,
				openRouterApiKey,
				clineApiKey,
				awsAccessKey,
				awsSecretKey,
				awsSessionToken,
				awsRegion,
				awsUseCrossRegionInference,
				awsBedrockUsePromptCache,
				awsBedrockEndpoint,
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
				ollamaApiOptionsCtxNum,
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
				// Fixes bug where switching to plan/act would result in setting this model id to previousModeModelId which may have been a non-string value by default, causing a type error in the webview when calling .toLowerCase() on it.
				openRouterModelId: openRouterModelId ? String(openRouterModelId) : undefined,
				openRouterModelInfo,
				openRouterProviderSorting,
				vsCodeLmModelSelector,
				o3MiniReasoningEffort,
				thinkingBudgetTokens,
				liteLlmBaseUrl,
				liteLlmModelId,
				liteLlmApiKey,
				asksageApiKey,
				asksageApiUrl,
				xaiApiKey,
				sambanovaApiKey,
			},
			lastShownAnnouncementId,
			customInstructions,
			taskHistory,
			autoApprovalSettings: autoApprovalSettings || DEFAULT_AUTO_APPROVAL_SETTINGS, // default value can be 0 or empty string
			browserSettings: browserSettings || DEFAULT_BROWSER_SETTINGS,
			chatSettings: chatSettings || DEFAULT_CHAT_SETTINGS,
			userInfo,
			previousModeApiProvider,
			previousModeModelId: previousModeModelId ? String(previousModeModelId) : undefined,
			previousModeModelInfo,
			previousModeThinkingBudgetTokens,
			mcpMarketplaceEnabled,
			telemetrySetting: telemetrySetting || "unset",
			planActSeparateModelsSetting,
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

	async updateGlobalState(key: GlobalStateKey, value: any) {
		await this.context.globalState.update(key, value)
	}

	async getGlobalState(key: GlobalStateKey) {
		return await this.context.globalState.get(key)
	}

	// workspace

	private async updateWorkspaceState(key: string, value: any) {
		await this.context.workspaceState.update(key, value)
	}

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

	// Open Graph Data

	async fetchOpenGraphData(url: string) {
		try {
			// Use the fetchOpenGraphData function from link-preview.ts
			const ogData = await fetchOpenGraphData(url)

			// Send the data back to the webview
			await this.postMessageToWebview({
				type: "openGraphData",
				openGraphData: ogData,
				url: url,
			})
		} catch (error) {
			console.error(`Error fetching Open Graph data for ${url}:`, error)
			// Send an error response
			await this.postMessageToWebview({
				type: "openGraphData",
				error: `Failed to fetch Open Graph data: ${error}`,
				url: url,
			})
		}
	}

	// Check if a URL is an image
	async checkIsImageUrl(url: string) {
		try {
			// Check if the URL is an image
			const isImage = await isImageUrl(url)

			// Send the result back to the webview
			await this.postMessageToWebview({
				type: "isImageUrlResult",
				isImage,
				url,
			})
		} catch (error) {
			console.error(`Error checking if URL is an image: ${url}`, error)
			// Send an error response
			await this.postMessageToWebview({
				type: "isImageUrlResult",
				isImage: false,
				url,
			})
		}
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
			"clineApiKey",
			"liteLlmApiKey",
			"asksageApiKey",
			"xaiApiKey",
			"sambanovaApiKey",
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
