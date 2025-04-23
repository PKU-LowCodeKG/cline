import axios from "axios"
import * as vscode from "vscode"
import { getNonce } from "./getNonce"
import { getUri } from "./getUri"
import { getTheme } from "@integrations/theme/getTheme"
import { Controller } from "@core/controller/index"
import { findLast } from "@shared/array"
/*
https://github.com/microsoft/vscode-webview-ui-toolkit-samples/blob/main/default/weather-webview/src/providers/WeatherViewProvider.ts
https://github.com/KumarVariable/vscode-extension-sidebar-html/blob/master/src/customSidebarViewProvider.ts
*/

export class WebviewProvider implements vscode.WebviewViewProvider {
	public static readonly sideBarId = "claude-dev.SidebarProvider" // used in package.json as the view's id. This value cannot be changed due to how vscode caches views based on their id, and updating the id would break existing instances of the extension.
	public static readonly tabPanelId = "claude-dev.TabPanelProvider"
	/** 静态属性，用于存储所有 “正在活跃的 WebviewProvider 实例” */
	private static activeInstances: Set<WebviewProvider> = new Set()
	public view?: vscode.WebviewView | vscode.WebviewPanel
	private disposables: vscode.Disposable[] = []
	controller: Controller

	constructor(
		// 扩展的上下文，用于访问扩展的状态和资源
		readonly context: vscode.ExtensionContext,
		// 输出通道，用于显示消息和日志
		private readonly outputChannel: vscode.OutputChannel,
	) {
		// 将当前实例添加到 “正在活跃的实例” 集合中
		WebviewProvider.activeInstances.add(this)
		this.controller = new Controller(context, outputChannel, (message) => this.view?.webview.postMessage(message))
	}

	/**
	 * 释放资源，当用户或系统关闭侧边栏/编辑器标签时调用。
	 * VSCode 扩展使用可处置模式来清理资源，确保在不再需要时及时释放资源，防止内存泄漏并确保扩展正常运行。
	 * 此方法会释放各种资源和事件监听器。
	 */
	async dispose() {
		// 如果存在视图并且视图有 dispose 方法，则释放视图资源
		if (this.view && "dispose" in this.view) {
			this.view.dispose()
		}
		// 遍历并释放所有可处置对象
		while (this.disposables.length) {
			const x = this.disposables.pop()
			if (x) {
				x.dispose()
			}
		}
		// NOTE: 调用 controller 的 dispose 方法来完成其他清理工作
		await this.controller.dispose()
		// 从 “正在活跃的实例” 集合中删除当前实例
		// 这将确保在视图被关闭或释放时，实例不会继续存在于集合中
		WebviewProvider.activeInstances.delete(this)
	}

	/** 遍历所有 “正在活跃的 WebviewProvider 实例”，返回最后一个 visible 的实例 */
	public static getVisibleInstance(): WebviewProvider | undefined {
		return findLast(Array.from(this.activeInstances), (instance) => instance.view?.visible === true)
	}

	public static getAllInstances(): WebviewProvider[] {
		return Array.from(this.activeInstances)
	}

	public static getSidebarInstance() {
		return Array.from(this.activeInstances).find((instance) => instance.view && "onDidChangeVisibility" in instance.view)
	}

	public static getTabInstances(): WebviewProvider[] {
		return Array.from(this.activeInstances).filter((instance) => instance.view && "onDidChangeViewState" in instance.view)
	}

	/**
	 * 【主线】解析和配置 VSCode 的 Webview 视图。
	 * 主要功能包括：设置 Webview 的选项和 HTML 内容、监听消息、处理视图可见性变化、监听视图关闭事件、监听主题颜色变化、清除任务状态。
	 * @param webviewView 表示一个 Webview 视图或面板
	 */
	async resolveWebviewView(webviewView: vscode.WebviewView | vscode.WebviewPanel) {
		this.view = webviewView

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
			// WebviewView and WebviewPanel have all the same properties except for this visibility listener
			// panel
			// 可以在编辑器区域或作为一个独立的浮动窗口显示，可拖拽
			webviewView.onDidChangeViewState(
				() => {
					if (this.view?.visible) {
						this.controller.postMessageToWebview({
							type: "action",
							action: "didBecomeVisible",
						})
					}
				},
				null,
				this.disposables,
			)
		} else if ("onDidChangeVisibility" in webviewView) {
			// sidebar
			// 侧边栏或底部面板
			webviewView.onDidChangeVisibility(
				() => {
					if (this.view?.visible) {
						this.controller.postMessageToWebview({
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

		// // if the extension is starting a new session, clear previous task state
		// this.clearTask()
		{
			// Listen for configuration changes
			vscode.workspace.onDidChangeConfiguration(
				async (e) => {
					if (e && e.affectsConfiguration("workbench.colorTheme")) {
						// Sends latest theme name to webview
						await this.controller.postMessageToWebview({
							type: "theme",
							text: JSON.stringify(await getTheme()),
						})
					}
					if (e && e.affectsConfiguration("cline.mcpMarketplace.enabled")) {
						// Update state when marketplace tab setting changes
						await this.controller.postStateToWebview()
					}
				},
				null,
				this.disposables,
			)

			// if the extension is starting a new session, clear previous task state
			this.controller.clearTask()

			this.outputChannel.appendLine("Webview view resolved")
		}
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
		const stylesUri = getUri(webview, this.context.extensionUri, ["webview-ui", "build", "assets", "index.css"])
		// The JS file from the React build output
		const scriptUri = getUri(webview, this.context.extensionUri, ["webview-ui", "build", "assets", "index.js"])

		// The codicon font from the React build output
		// https://github.com/microsoft/vscode-extension-samples/blob/main/webview-codicons-sample/src/extension.ts
		// we installed this package in the extension so that we can access it how its intended from the extension (the font file is likely bundled in vscode), and we just import the css fileinto our react app we don't have access to it
		// don't forget to add font-src ${webview.cspSource};
		// NOTE: 从 React 构建输出中获取 Codicon 字体
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
				As your extension grows you will likely want to add custom styles, fonts, and/or images to your webview. If you do, you will need to update the content security policy meta tag to explicitly allow for these resources. E.g.
								<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}';">
		- 'unsafe-inline' is required for styles due to vscode-webview-toolkit's dynamic style injection
		- since we pass base64 images to the webview, we need to specify img-src ${webview.cspSource} data:;

				in meta tag we add nonce attribute: A cryptographic nonce (only used once) to allow scripts. The server must generate a unique nonce value each time it transmits a policy. It is critical to provide a nonce that cannot be guessed as bypassing a resource's policy is otherwise trivial.
				*/
		// 使用 nonce 来限制只允许运行特定的脚本
		const nonce = getNonce()

		// Tip: Install the es6-string-html VS Code extension to enable code highlighting below
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
	 * IMPORTANT: When passing methods as callbacks in JavaScript/TypeScript, the method's
	 * 'this' context can be lost. This happens because the method is passed as a
	 * standalone function reference, detached from its original object.
	 *
	 * The Problem:
	 * Doing: webview.onDidReceiveMessage(this.controller.handleWebviewMessage)
	 * Would cause 'this' inside handleWebviewMessage to be undefined or wrong,
	 * leading to "TypeError: this.setUserInfo is not a function"
	 *
	 * The Solution:
	 * We wrap the method call in an arrow function, which:
	 * 1. Preserves the lexical scope's 'this' binding
	 * 2. Ensures handleWebviewMessage is called as a method on the controller instance
	 * 3. Maintains access to all controller methods and properties
	 *
	 * Alternative solutions could use .bind() or making handleWebviewMessage an arrow
	 * function property, but this approach is clean and explicit.
	 *
	 * @param webview The webview instance to attach the message listener to
	 */
	private setWebviewMessageListener(webview: vscode.Webview) {
		webview.onDidReceiveMessage(
			(message) => {
				this.controller.handleWebviewMessage(message)
			},
			null,
			this.disposables,
		)
	}
}
