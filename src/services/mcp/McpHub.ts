import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport, StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
	CallToolResultSchema,
	ListResourcesResultSchema,
	ListResourceTemplatesResultSchema,
	ListToolsResultSchema,
	ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js"
import chokidar, { FSWatcher } from "chokidar"
import delay from "delay"
import deepEqual from "fast-deep-equal"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"
// Zod 是一个 TypeScript 优先的 schema（任何数据类型）的声明和验证库
// https://www.npmjs.com/package/zod
import { z } from "zod"
import { ClineProvider } from "../../core/webview/ClineProvider"
import {
	DEFAULT_MCP_TIMEOUT_SECONDS,
	McpMode,
	McpResource,
	McpResourceResponse,
	McpResourceTemplate,
	McpServer,
	McpTool,
	McpToolCallResponse,
	MIN_MCP_TIMEOUT_SECONDS,
} from "../../shared/mcp"
import { fileExistsAtPath } from "../../utils/fs"
import { arePathsEqual } from "../../utils/path"
import { secondsToMs } from "../../utils/time"
import { GlobalFileNames } from "../../global-constants"
export type McpConnection = {
	/** Cline 自定义的 MCP 服务器，不是官方的 McpServer 类型 */
	server: McpServer
	client: Client
	transport: StdioClientTransport
}

const AutoApproveSchema = z.array(z.string()).default([])

/**
 * Cline 定义的 StdioClientTransport 配置对象范式
 *
 * 官方的接口是 StdioServerParameters，Cline 自定义了这个 数据结构范式，
 * 用 safeParse 解析 StdioServerParameters 是否符合这个预期的数据结构（可选字段可以没有）
 */

const StdioConfigSchema = z.object({
	command: z.string(),
	args: z.array(z.string()).optional(),
	env: z.record(z.string()).optional(),
	autoApprove: AutoApproveSchema.optional(),
	disabled: z.boolean().optional(),
	timeout: z.number().min(MIN_MCP_TIMEOUT_SECONDS).optional().default(DEFAULT_MCP_TIMEOUT_SECONDS),
})

/**
 * 多个 MCP 服务器的信息，形如
 * {
 * 	mcpServers: {
 * 		string1(服务器名称): StdioConfigSchema1,
 * 		...
 * 	}
 * }
 */
const McpSettingsSchema = z.object({
	/** 键是服务器名称，值是 StdioConfigSchema */
	mcpServers: z.record(StdioConfigSchema),
})

/**
 * Cline 基于 MCP 的 Typescript SDK 包实现的 Hub 类，支持接入 MCP 服务器，实现功能扩展。
 * 插件的描述是：支持与本地运行的 MCP 服务器进行通信，这些服务器提供额外的工具和资源以扩展 Cline 的功能。可以使用社区创建的服务器，或者让 Cline 根据您的工作流程创建新的工具（例如，“添加一个获取最新 npm 文档的工具”）。
 *    - 创建 MCP 服务器，服务器可以暴露资源（server.resource）、提示（prompt）和工具（tool），以便客户端使用。
 *    - 创建 MCP 客户端，客户端能够连接到任何符合 MCP 规范的服务器。
 * TypeScript 形式的 MCP 服务器需要连接（connect）到传输（transport）以与客户端通信。Cline 选择了 stdio 传输（StdioClientTransport）。
 *
 * Cline 是通过在 SYSTEM PROMPT 中：
 * 1. 定义了 <use_mcp_tool> 和 <access_mcp_resource> 两个工具，并提供了使用示例（正如其他工具，目前 在一条 Assistant Message 中最多只允许一个 MCP 工具调用）
 * 2. 列出了所有 connected 的 MCP 服务器的信息：服务器名称、配置信息，工具信息，资源信息
 * 3. 如果 mode 为 full，还会给出创建新的 MCP 服务器的提示
 *
 * Model Context Protocol（MCP）是一个用于在应用程序和 LLM 之间提供上下文的标准化协议。它旨在将上下文提供与实际的 LLM 交互分离，从而简化开发流程并提高灵活性。
 * @docs https://modelcontextprotocol.io/introduction
 * @docs MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
 * @server https://github.com/modelcontextprotocol/servers
 */
export class McpHub {
	private providerRef: WeakRef<ClineProvider>
	private disposables: vscode.Disposable[] = []
	private settingsWatcher?: vscode.FileSystemWatcher
	/** chokidar 跨平台文件监视库 提供的 文件系统监视器 FS Watcher  */
	private fileWatchers: Map<string, FSWatcher> = new Map()

	/** MCP 连接对象 的数组，每个对象包括：服务器、客户端和传输。 */
	connections: McpConnection[] = []
	isConnecting: boolean = false

	constructor(provider: ClineProvider) {
		this.providerRef = new WeakRef(provider)
		this.watchMcpSettingsFile()
		this.initializeMcpServers()
	}

	/** 返回所有 存在没有 disabled 的连接的 McpServer 对象  */
	getServers(): McpServer[] {
		// Only return enabled servers
		return this.connections.filter((conn) => !conn.server.disabled).map((conn) => conn.server)
	}

	/** 返回用户在 VSCode 中对 Cline MCP 的模式设置（full, server-user-only, off）  */
	getMode(): McpMode {
		return vscode.workspace.getConfiguration("cline.mcp").get<McpMode>("mode", "full")
	}

	/**
	 * 返回 MCP 服务器的路径
	 * `~/Documents/Cline/MCP`
	 */
	async getMcpServersPath(): Promise<string> {
		const provider = this.providerRef.deref()
		if (!provider) {
			throw new Error("Provider not available")
		}
		const mcpServersPath = await provider.ensureMcpServersDirectoryExists()
		return mcpServersPath
	}

	/**
	 * 返回存放 Cline 的 MCP 设置文件的路径。
	 * `[context.globalStorageUri.fsPath]/settings/cline_mcp_settings.json`
	 * 如果该路径不存在，创建一个新的 MCP 设置文件。并设置 "mcpServers" 字段为空对象。
	 */
	async getMcpSettingsFilePath(): Promise<string> {
		const provider = this.providerRef.deref()
		if (!provider) {
			throw new Error("Provider not available")
		}
		const mcpSettingsFilePath = path.join(await provider.ensureSettingsDirectoryExists(), GlobalFileNames.mcpSettings)
		const fileExists = await fileExistsAtPath(mcpSettingsFilePath)
		if (!fileExists) {
			await fs.writeFile(
				mcpSettingsFilePath,
				`{
  "mcpServers": {
    
  }
}`,
			)
		}
		return mcpSettingsFilePath
	}

	/**
	 * 监视 MCP 设置文件的更改。
	 * 利用 vscode 的 文件保存事件，当用户保存的文件是 MCP 设置文件时，解析文件内容的 mcpServers 字段，更新服务器连接。
	 */
	private async watchMcpSettingsFile(): Promise<void> {
		const settingsPath = await this.getMcpSettingsFilePath()
		this.disposables.push(
			vscode.workspace.onDidSaveTextDocument(async (document) => {
				if (arePathsEqual(document.uri.fsPath, settingsPath)) {
					const content = await fs.readFile(settingsPath, "utf-8")
					const errorMessage =
						"Invalid MCP settings format. Please ensure your settings follow the correct JSON format."
					let config: any
					try {
						config = JSON.parse(content)
					} catch (error) {
						vscode.window.showErrorMessage(errorMessage)
						return
					}
					const result = McpSettingsSchema.safeParse(config)
					if (!result.success) {
						vscode.window.showErrorMessage(errorMessage)
						return
					}
					try {
						vscode.window.showInformationMessage("Updating MCP servers...")
						await this.updateServerConnections(result.data.mcpServers || {})
						vscode.window.showInformationMessage("MCP servers updated")
					} catch (error) {
						console.error("Failed to process MCP settings change:", error)
					}
				}
			}),
		)
	}

	/**
	 * 初始化 MCP 服务器
	 * 具体来说，读取 Cline 的 MCP 设置文件的 mcpServers 字段，更新服务器连接（似乎一开始是空对象？）。
	 */
	private async initializeMcpServers(): Promise<void> {
		try {
			const settingsPath = await this.getMcpSettingsFilePath()
			const content = await fs.readFile(settingsPath, "utf-8")
			const config = JSON.parse(content)
			await this.updateServerConnections(config.mcpServers || {})
		} catch (error) {
			console.error("Failed to initialize MCP servers:", error)
		}
	}

	/**
	 * 连接到已经存在的 MCP 服务器
	 * 1. 为 name 的 MCP 服务器建立 client 和 transport。
	 * 2. 配置 transport 的 onerror 和 onclose 事件处理函数。
	 * 	  - 更新连接对象的 服务器状态为 "disconnected"。
	 * 	  - 将 Cline 的 MCP 服务器的状态变化 通知 webview。
	 * 3. 用 自定义的 StdioConfigSchema 检查 config 参数的合法性
	 * 4. 构造 McpConnection 对象，加入到 connections 数组中。
	 * 5. 将 client 通过 transport 连接到服务器。配置 tools and resources
	 * @param name 服务器名称
	 * @param config 用 client 连接服务器的 transport 配置对象
	 */
	private async connectToServer(name: string, config: StdioServerParameters): Promise<void> {
		// Remove existing connection if it exists (should never happen, the connection should be deleted beforehand)
		this.connections = this.connections.filter((conn) => conn.server.name !== name)

		try {
			// Each MCP server requires its own transport connection and has unique capabilities, configurations, and error handling. Having separate clients also allows proper scoping of resources/tools and independent server management like reconnection.
			const client = new Client(
				{
					name: "Cline",
					version: this.providerRef.deref()?.context.extension?.packageJSON?.version ?? "1.0.0",
				},
				{
					capabilities: {},
				},
			)

			const transport = new StdioClientTransport({
				command: config.command,
				args: config.args,
				env: {
					...config.env,
					...(process.env.PATH ? { PATH: process.env.PATH } : {}),
					// ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}),
				},
				stderr: "pipe", // necessary for stderr to be available
			})

			transport.onerror = async (error) => {
				console.error(`Transport error for "${name}":`, error)
				const connection = this.connections.find((conn) => conn.server.name === name)
				if (connection) {
					connection.server.status = "disconnected"
					this.appendErrorMessage(connection, error.message)
				}
				await this.notifyWebviewOfServerChanges()
			}

			transport.onclose = async () => {
				const connection = this.connections.find((conn) => conn.server.name === name)
				if (connection) {
					connection.server.status = "disconnected"
				}
				await this.notifyWebviewOfServerChanges()
			}

			// If the config is invalid, show an error
			if (!StdioConfigSchema.safeParse(config).success) {
				console.error(`Invalid config for "${name}": missing or invalid parameters`)
				const connection: McpConnection = {
					server: {
						name,
						config: JSON.stringify(config),
						status: "disconnected",
						error: "Invalid config: missing or invalid parameters",
					},
					client,
					transport,
				}
				this.connections.push(connection)
				return
			}

			// valid schema
			const parsedConfig = StdioConfigSchema.parse(config)
			const connection: McpConnection = {
				server: {
					name,
					config: JSON.stringify(config),
					status: "connecting",
					disabled: parsedConfig.disabled,
				},
				client,
				transport,
			}
			this.connections.push(connection)

			// transport.stderr is only available after the process has been started. However we can't start it separately from the .connect() call because it also starts the transport. And we can't place this after the connect call since we need to capture the stderr stream before the connection is established, in order to capture errors during the connection process.
			// As a workaround, we start the transport ourselves, and then monkey-patch the start method to no-op so that .connect() doesn't try to start it again.
			await transport.start()
			const stderrStream = transport.stderr
			if (stderrStream) {
				stderrStream.on("data", async (data: Buffer) => {
					const errorOutput = data.toString()
					console.error(`Server "${name}" stderr:`, errorOutput)
					const connection = this.connections.find((conn) => conn.server.name === name)
					if (connection) {
						// NOTE: we do not set server status to "disconnected" because stderr logs do not necessarily mean the server crashed or disconnected, it could just be informational. In fact when the server first starts up, it immediately logs "<name> server running on stdio" to stderr.
						this.appendErrorMessage(connection, errorOutput)
						// Only need to update webview right away if it's already disconnected
						if (connection.server.status === "disconnected") {
							await this.notifyWebviewOfServerChanges()
						}
					}
				})
			} else {
				console.error(`No stderr stream for ${name}`)
			}
			transport.start = async () => {} // No-op now, .connect() won't fail

			// Connect
			await client.connect(transport)
			connection.server.status = "connected"
			connection.server.error = ""

			// Initial fetch of tools and resources
			connection.server.tools = await this.fetchToolsList(name)
			connection.server.resources = await this.fetchResourcesList(name)
			connection.server.resourceTemplates = await this.fetchResourceTemplatesList(name)
		} catch (error) {
			// Update status with error
			const connection = this.connections.find((conn) => conn.server.name === name)
			if (connection) {
				connection.server.status = "disconnected"
				this.appendErrorMessage(connection, error instanceof Error ? error.message : String(error))
			}
			throw error
		}
	}

	private appendErrorMessage(connection: McpConnection, error: string) {
		const newError = connection.server.error ? `${connection.server.error}\n${error}` : error
		connection.server.error = newError //.slice(0, 800)
	}

	private async fetchToolsList(serverName: string): Promise<McpTool[]> {
		try {
			const response = await this.connections
				.find((conn) => conn.server.name === serverName)
				?.client.request({ method: "tools/list" }, ListToolsResultSchema)

			// Get autoApprove settings
			const settingsPath = await this.getMcpSettingsFilePath()
			const content = await fs.readFile(settingsPath, "utf-8")
			const config = JSON.parse(content)
			const autoApproveConfig = config.mcpServers[serverName]?.autoApprove || []

			// Mark tools as always allowed based on settings
			const tools = (response?.tools || []).map((tool) => ({
				...tool,
				autoApprove: autoApproveConfig.includes(tool.name),
			}))

			// console.log(`[MCP] Fetched tools for ${serverName}:`, tools)
			return tools
		} catch (error) {
			// console.error(`Failed to fetch tools for ${serverName}:`, error)
			return []
		}
	}

	private async fetchResourcesList(serverName: string): Promise<McpResource[]> {
		try {
			const response = await this.connections
				.find((conn) => conn.server.name === serverName)
				?.client.request({ method: "resources/list" }, ListResourcesResultSchema)
			return response?.resources || []
		} catch (error) {
			// console.error(`Failed to fetch resources for ${serverName}:`, error)
			return []
		}
	}

	private async fetchResourceTemplatesList(serverName: string): Promise<McpResourceTemplate[]> {
		try {
			const response = await this.connections
				.find((conn) => conn.server.name === serverName)
				?.client.request({ method: "resources/templates/list" }, ListResourceTemplatesResultSchema)
			return response?.resourceTemplates || []
		} catch (error) {
			// console.error(`Failed to fetch resource templates for ${serverName}:`, error)
			return []
		}
	}

	/**
	 * 断开已经存在的服务器的连接
	 *
	 * 具体来说，清除服务器名称等于 参数 name 的 连接对象，关闭其 client 和 transport
	 */
	async deleteConnection(name: string): Promise<void> {
		const connection = this.connections.find((conn) => conn.server.name === name)
		if (connection) {
			try {
				await connection.transport.close()
				await connection.client.close()
			} catch (error) {
				console.error(`Failed to close transport for ${name}:`, error)
			}
			this.connections = this.connections.filter((conn) => conn.server.name !== name)
		}
	}

	/**
	 * 更新 MCP 服务器连接
	 * 1. 清除所有的 chokidar 文件监视器
	 * 2. 对比 newServers 的代表的新一批服务器 和 原有连接中的服务器。
	 *    清除不在 newServers 中的服务器 所在的连接对象
	 * 3. 找到服务器名称等于 name 的连接对象。
	 *    - 如果不存在，新建一个连接对象
	 *       - 为该服务器的 Transport 配置文件设置 chokidar 文件监视器
	 *       - 连接到该服务器
	 *    - 如果存在，若该服务器的 Transport 配置对象改变了
	 *       - 为该服务器的 Transport 配置文件设置 chokidar 文件监视器
	 *       - 断开该服务器的连接（清除 连接对象，关闭其 client 和 transport）
	 *       - 连接到该服务器（TODO：为什么不用 restartConnection？）
	 * 4. 将 Cline 的 MCP 服务器的状态变化 通知 webview
	 * @param newServers 新一批 MCP 服务器信息（最开始是空对象，后面是 MCP 配置文件的 mcpServers 字段）
	 */
	async updateServerConnections(newServers: Record<string, any>): Promise<void> {
		this.isConnecting = true
		this.removeAllFileWatchers()
		const currentNames = new Set(this.connections.map((conn) => conn.server.name))
		const newNames = new Set(Object.keys(newServers))

		// Delete removed servers
		for (const name of currentNames) {
			if (!newNames.has(name)) {
				await this.deleteConnection(name)
				console.log(`Deleted MCP server: ${name}`)
			}
		}

		// Update or add servers
		// name 是服务器名称，config 是 Cline 定义的 Transport 配置对象范式
		for (const [name, config] of Object.entries(newServers)) {
			const currentConnection = this.connections.find((conn) => conn.server.name === name)

			if (!currentConnection) {
				// New server
				try {
					this.setupFileWatcher(name, config)
					await this.connectToServer(name, config)
				} catch (error) {
					console.error(`Failed to connect to new MCP server ${name}:`, error)
				}
			} else if (!deepEqual(JSON.parse(currentConnection.server.config), config)) {
				// Existing server with changed config
				try {
					this.setupFileWatcher(name, config)
					await this.deleteConnection(name)
					await this.connectToServer(name, config)
					console.log(`Reconnected MCP server with updated config: ${name}`)
				} catch (error) {
					console.error(`Failed to reconnect MCP server ${name}:`, error)
				}
			}
			// If server exists with same config, do nothing
		}
		await this.notifyWebviewOfServerChanges()
		this.isConnecting = false
	}

	/**
	 * 1. 找到该服务器的 Transport 配置文件，为该文件设置 chokidar 文件监视器。
	 * 该文件监视器会在 文件改变 时，重新连接 name 服务器
	 * 2. 将 <name, watcher> 存储到 fileWatchers Map 中
	 * @param name 服务器名称
	 * @param config 应该是 StdioConfigSchema 类型
	 */
	private setupFileWatcher(name: string, config: any) {
		const filePath = config.args?.find((arg: string) => arg.includes("build/index.js"))
		if (filePath) {
			// we use chokidar instead of onDidSaveTextDocument because it doesn't require the file to be open in the editor. The settings config is better suited for onDidSave since that will be manually updated by the user or Cline (and we want to detect save events, not every file change)
			const watcher = chokidar.watch(filePath, {
				// persistent: true,
				// ignoreInitial: true,
				// awaitWriteFinish: true, // This helps with atomic writes
			})

			watcher.on("change", () => {
				console.log(`Detected change in ${filePath}. Restarting server ${name}...`)
				this.restartConnection(name)
			})

			this.fileWatchers.set(name, watcher)
		}
	}

	/** 清除所有的 chokidar 文件监视器 */
	private removeAllFileWatchers() {
		this.fileWatchers.forEach((watcher) => watcher.close())
		this.fileWatchers.clear()
	}

	/**
	 * 重新连接到已经存在的 MCP 服务器
	 * 1. 找到 MCP 服务器名称为 serverName 的连接对象
	 * 2. 更改其 服务器 状态
	 * 3. 断开该服务器的连接（清除 连接对象，关闭其 client 和 transport）
	 * 4. 连接到 该服务器
	 * @param serverName 服务器名称
	 */
	async restartConnection(serverName: string): Promise<void> {
		this.isConnecting = true
		const provider = this.providerRef.deref()
		if (!provider) {
			return
		}

		// Get existing connection and update its status
		const connection = this.connections.find((conn) => conn.server.name === serverName)
		const config = connection?.server.config
		if (config) {
			vscode.window.showInformationMessage(`Restarting ${serverName} MCP server...`)
			connection.server.status = "connecting"
			connection.server.error = ""
			await this.notifyWebviewOfServerChanges()
			await delay(500) // artificial delay to show user that server is restarting
			try {
				await this.deleteConnection(serverName)
				// Try to connect again using existing config
				await this.connectToServer(serverName, JSON.parse(config))
				vscode.window.showInformationMessage(`${serverName} MCP server connected`)
			} catch (error) {
				console.error(`Failed to restart connection for ${serverName}:`, error)
				vscode.window.showErrorMessage(`Failed to connect to ${serverName} MCP server`)
			}
		}

		await this.notifyWebviewOfServerChanges()
		this.isConnecting = false
	}

	/**
	 * 将 Cline 的 MCP 服务器的状态变化 通知 webview
	 * 1. 读取 Cline 的 MCP 设置文件的 mcpServers 字段，将其键值（即服务器名称）记为数组
	 * 2. 向 webview 发送 "mcpServers" 类型的消息
	 *    - 内容是 McpServer[]（所有的连接对象的服务器信息）
	 *    - 顺序是按照 mcpServers 中 key 的顺序
	 */
	private async notifyWebviewOfServerChanges(): Promise<void> {
		// servers should always be sorted in the order they are defined in the settings file
		const settingsPath = await this.getMcpSettingsFilePath()
		const content = await fs.readFile(settingsPath, "utf-8")
		const config = JSON.parse(content)
		const serverOrder = Object.keys(config.mcpServers || {})
		await this.providerRef.deref()?.postMessageToWebview({
			type: "mcpServers",
			mcpServers: [...this.connections]
				.sort((a, b) => {
					const indexA = serverOrder.indexOf(a.server.name)
					const indexB = serverOrder.indexOf(b.server.name)
					return indexA - indexB
				})
				.map((connection) => connection.server),
		})
	}

	async sendLatestMcpServers() {
		await this.notifyWebviewOfServerChanges()
	}

	// Using server

	// Public methods for server management

	public async toggleServerDisabled(serverName: string, disabled: boolean): Promise<void> {
		let settingsPath: string
		try {
			settingsPath = await this.getMcpSettingsFilePath()

			// Ensure the settings file exists and is accessible
			try {
				await fs.access(settingsPath)
			} catch (error) {
				console.error("Settings file not accessible:", error)
				throw new Error("Settings file not accessible")
			}
			const content = await fs.readFile(settingsPath, "utf-8")
			const config = JSON.parse(content)

			// Validate the config structure
			if (!config || typeof config !== "object") {
				throw new Error("Invalid config structure")
			}

			if (!config.mcpServers || typeof config.mcpServers !== "object") {
				config.mcpServers = {}
			}

			if (config.mcpServers[serverName]) {
				// Create a new server config object to ensure clean structure
				const serverConfig = {
					...config.mcpServers[serverName],
					disabled,
				}

				// Ensure required fields exist
				if (!serverConfig.autoApprove) {
					serverConfig.autoApprove = []
				}

				config.mcpServers[serverName] = serverConfig

				// Write the entire config back
				const updatedConfig = {
					mcpServers: config.mcpServers,
				}

				await fs.writeFile(settingsPath, JSON.stringify(updatedConfig, null, 2))

				const connection = this.connections.find((conn) => conn.server.name === serverName)
				if (connection) {
					try {
						connection.server.disabled = disabled

						// Only refresh capabilities if connected
						if (connection.server.status === "connected") {
							connection.server.tools = await this.fetchToolsList(serverName)
							connection.server.resources = await this.fetchResourcesList(serverName)
							connection.server.resourceTemplates = await this.fetchResourceTemplatesList(serverName)
						}
					} catch (error) {
						console.error(`Failed to refresh capabilities for ${serverName}:`, error)
					}
				}

				await this.notifyWebviewOfServerChanges()
			}
		} catch (error) {
			console.error("Failed to update server disabled state:", error)
			if (error instanceof Error) {
				console.error("Error details:", error.message, error.stack)
			}
			vscode.window.showErrorMessage(
				`Failed to update server state: ${error instanceof Error ? error.message : String(error)}`,
			)
			throw error
		}
	}

	async readResource(serverName: string, uri: string): Promise<McpResourceResponse> {
		const connection = this.connections.find((conn) => conn.server.name === serverName)
		if (!connection) {
			throw new Error(`No connection found for server: ${serverName}`)
		}
		if (connection.server.disabled) {
			throw new Error(`Server "${serverName}" is disabled`)
		}

		return await connection.client.request(
			{
				method: "resources/read",
				params: {
					uri,
				},
			},
			ReadResourceResultSchema,
		)
	}

	async callTool(serverName: string, toolName: string, toolArguments?: Record<string, unknown>): Promise<McpToolCallResponse> {
		const connection = this.connections.find((conn) => conn.server.name === serverName)
		if (!connection) {
			throw new Error(
				`No connection found for server: ${serverName}. Please make sure to use MCP servers available under 'Connected MCP Servers'.`,
			)
		}

		if (connection.server.disabled) {
			throw new Error(`Server "${serverName}" is disabled and cannot be used`)
		}

		let timeout = secondsToMs(DEFAULT_MCP_TIMEOUT_SECONDS) // sdk expects ms

		try {
			const config = JSON.parse(connection.server.config)
			const parsedConfig = StdioConfigSchema.parse(config)
			timeout = secondsToMs(parsedConfig.timeout)
		} catch (error) {
			console.error(`Failed to parse timeout configuration for server ${serverName}: ${error}`)
		}

		return await connection.client.request(
			{
				method: "tools/call",
				params: {
					name: toolName,
					arguments: toolArguments,
				},
			},
			CallToolResultSchema,
			{
				timeout,
			},
		)
	}

	async toggleToolAutoApprove(serverName: string, toolName: string, shouldAllow: boolean): Promise<void> {
		try {
			const settingsPath = await this.getMcpSettingsFilePath()
			const content = await fs.readFile(settingsPath, "utf-8")
			const config = JSON.parse(content)

			// Initialize autoApprove if it doesn't exist
			if (!config.mcpServers[serverName].autoApprove) {
				config.mcpServers[serverName].autoApprove = []
			}

			const autoApprove = config.mcpServers[serverName].autoApprove
			const toolIndex = autoApprove.indexOf(toolName)

			if (shouldAllow && toolIndex === -1) {
				// Add tool to autoApprove list
				autoApprove.push(toolName)
			} else if (!shouldAllow && toolIndex !== -1) {
				// Remove tool from autoApprove list
				autoApprove.splice(toolIndex, 1)
			}

			await fs.writeFile(settingsPath, JSON.stringify(config, null, 2))

			// Update the tools list to reflect the change
			const connection = this.connections.find((conn) => conn.server.name === serverName)
			if (connection) {
				connection.server.tools = await this.fetchToolsList(serverName)
				await this.notifyWebviewOfServerChanges()
			}
		} catch (error) {
			console.error("Failed to update autoApprove settings:", error)
			vscode.window.showErrorMessage("Failed to update autoApprove settings")
			throw error // Re-throw to ensure the error is properly handled
		}
	}

	public async deleteServer(serverName: string) {
		try {
			const settingsPath = await this.getMcpSettingsFilePath()
			const content = await fs.readFile(settingsPath, "utf-8")
			const config = JSON.parse(content)
			if (!config.mcpServers || typeof config.mcpServers !== "object") {
				config.mcpServers = {}
			}
			if (config.mcpServers[serverName]) {
				delete config.mcpServers[serverName]
				const updatedConfig = {
					mcpServers: config.mcpServers,
				}
				await fs.writeFile(settingsPath, JSON.stringify(updatedConfig, null, 2))
				await this.updateServerConnections(config.mcpServers)
				vscode.window.showInformationMessage(`Deleted ${serverName} MCP server`)
			} else {
				vscode.window.showWarningMessage(`${serverName} not found in MCP configuration`)
			}
		} catch (error) {
			vscode.window.showErrorMessage(
				`Failed to delete MCP server: ${error instanceof Error ? error.message : String(error)}`,
			)
			throw error
		}
	}

	public async updateServerTimeout(serverName: string, timeout: number): Promise<void> {
		try {
			// Validate timeout against schema
			const setConfigResult = StdioConfigSchema.shape.timeout.safeParse(timeout)
			if (!setConfigResult.success) {
				throw new Error(`Invalid timeout value: ${timeout}. Must be at minimum ${MIN_MCP_TIMEOUT_SECONDS} seconds.`)
			}

			const settingsPath = await this.getMcpSettingsFilePath()
			const content = await fs.readFile(settingsPath, "utf-8")
			const config = JSON.parse(content)

			if (!config.mcpServers?.[serverName]) {
				throw new Error(`Server "${serverName}" not found in settings`)
			}

			config.mcpServers[serverName] = {
				...config.mcpServers[serverName],
				timeout,
			}

			await fs.writeFile(settingsPath, JSON.stringify(config, null, 2))

			await this.updateServerConnections(config.mcpServers)
		} catch (error) {
			console.error("Failed to update server timeout:", error)
			if (error instanceof Error) {
				console.error("Error details:", error.message, error.stack)
			}
			vscode.window.showErrorMessage(
				`Failed to update server timeout: ${error instanceof Error ? error.message : String(error)}`,
			)
			throw error
		}
	}

	async dispose(): Promise<void> {
		this.removeAllFileWatchers()
		for (const connection of this.connections) {
			try {
				await this.deleteConnection(connection.server.name)
			} catch (error) {
				console.error(`Failed to close connection for ${connection.server.name}:`, error)
			}
		}
		this.connections = []
		if (this.settingsWatcher) {
			this.settingsWatcher.dispose()
		}
		this.disposables.forEach((d) => d.dispose())
	}
}
