import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
	CallToolResultSchema,
	ListResourcesResultSchema,
	ListResourceTemplatesResultSchema,
	ListToolsResultSchema,
	ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js"
import chokidar, { FSWatcher } from "chokidar"
import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import deepEqual from "fast-deep-equal"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"
// Zod 是一个 TypeScript 优先的 schema（任何数据类型）的声明和验证库
// https://www.npmjs.com/package/zod
import { z } from "zod"
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
import { GlobalFileNames } from "../../core/storage/disk"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { ExtensionMessage } from "../../shared/ExtensionMessage"

// Default timeout for internal MCP data requests in milliseconds; is not the same as the user facing timeout stored as DEFAULT_MCP_TIMEOUT_SECONDS
const DEFAULT_REQUEST_TIMEOUT_MS = 5000

export type McpConnection = {
	/** Cline 自定义的 MCP 服务器，不是官方的 McpServer 类型 */
	server: McpServer
	client: Client
	transport: StdioClientTransport | SSEClientTransport
}

export type McpTransportType = "stdio" | "sse"

export type McpServerConfig = z.infer<typeof ServerConfigSchema>

const AutoApproveSchema = z.array(z.string()).default([])

/**
 * Cline 定义的 StdioClientTransport 配置对象范式
 *
 * 官方的接口是 StdioServerParameters，Cline 自定义了这个 数据结构范式，
 * 用 safeParse 解析 StdioServerParameters 是否符合这个预期的数据结构（可选字段可以没有）
 */

const BaseConfigSchema = z.object({
	autoApprove: AutoApproveSchema.optional(),
	disabled: z.boolean().optional(),
	timeout: z.number().min(MIN_MCP_TIMEOUT_SECONDS).optional().default(DEFAULT_MCP_TIMEOUT_SECONDS),
})

const SseConfigSchema = BaseConfigSchema.extend({
	url: z.string().url(),
}).transform((config) => ({
	...config,
	transportType: "sse" as const,
}))

/**
 * Cline 定义的 StdioClientTransport 配置对象范式
 *
 * 官方的接口是 StdioServerParameters，Cline 自定义了这个 数据结构范式，
 * 用 safeParse 解析 StdioServerParameters 是否符合这个预期的数据结构（可选字段可以没有）
 */
const StdioConfigSchema = BaseConfigSchema.extend({
	command: z.string(),
	args: z.array(z.string()).optional(),
	env: z.record(z.string()).optional(),
}).transform((config) => ({
	...config,
	transportType: "stdio" as const,
}))

const ServerConfigSchema = z.union([StdioConfigSchema, SseConfigSchema])

const McpSettingsSchema = z.object({
	/** 键是服务器名称，值是 StdioConfigSchema */
	mcpServers: z.record(ServerConfigSchema),
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
	getMcpServersPath: () => Promise<string>
	private getSettingsDirectoryPath: () => Promise<string>
	private postMessageToWebview: (message: ExtensionMessage) => Promise<void>
	private clientVersion: string

	private disposables: vscode.Disposable[] = []
	private settingsWatcher?: vscode.FileSystemWatcher
	/** chokidar 跨平台文件监视库 提供的 文件系统监视器 FS Watcher  */
	private fileWatchers: Map<string, FSWatcher> = new Map()

	/** MCP 连接对象 的数组，每个对象包括：服务器、客户端和传输。 */
	connections: McpConnection[] = []
	isConnecting: boolean = false

	constructor(
		getMcpServersPath: () => Promise<string>,
		getSettingsDirectoryPath: () => Promise<string>,
		postMessageToWebview: (message: ExtensionMessage) => Promise<void>,
		clientVersion: string,
	) {
		this.getMcpServersPath = getMcpServersPath
		this.getSettingsDirectoryPath = getSettingsDirectoryPath
		this.postMessageToWebview = postMessageToWebview
		this.clientVersion = clientVersion
		this.watchMcpSettingsFile()
		this.initializeMcpServers()
	}

	/** 返回所有 存在没有 disabled 的连接的 McpServer 对象  */
	getServers(): McpServer[] {
		// Only return enabled servers
		return this.connections.filter((conn) => !conn.server.disabled).map((conn) => conn.server)
	}

	/**
	 * 返回存放 Cline 的 MCP 设置文件的路径。
	 * `[context.globalStorageUri.fsPath]/settings/cline_mcp_settings.json`
	 * 如果该路径不存在，创建一个新的 MCP 设置文件。并设置 "mcpServers" 字段为空对象。
	 */
	async getMcpSettingsFilePath(): Promise<string> {
		const mcpSettingsFilePath = path.join(await this.getSettingsDirectoryPath(), GlobalFileNames.mcpSettings)
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

	private async readAndValidateMcpSettingsFile(): Promise<z.infer<typeof McpSettingsSchema> | undefined> {
		try {
			const settingsPath = await this.getMcpSettingsFilePath()
			const content = await fs.readFile(settingsPath, "utf-8")

			let config: any

			// Parse JSON file content
			try {
				config = JSON.parse(content)
			} catch (error) {
				vscode.window.showErrorMessage(
					"Invalid MCP settings format. Please ensure your settings follow the correct JSON format.",
				)
				return undefined
			}

			// Validate against schema
			const result = McpSettingsSchema.safeParse(config)
			if (!result.success) {
				vscode.window.showErrorMessage("Invalid MCP settings schema.")
				return undefined
			}

			return result.data
		} catch (error) {
			console.error("Failed to read MCP settings:", error)
			return undefined
		}
	}

	private async watchMcpSettingsFile(): Promise<void> {
		const settingsPath = await this.getMcpSettingsFilePath()
		this.disposables.push(
			vscode.workspace.onDidSaveTextDocument(async (document) => {
				if (arePathsEqual(document.uri.fsPath, settingsPath)) {
					const settings = await this.readAndValidateMcpSettingsFile()
					if (settings) {
						try {
							vscode.window.showInformationMessage("Updating MCP servers...")
							await this.updateServerConnections(settings.mcpServers)
							vscode.window.showInformationMessage("MCP servers updated")
						} catch (error) {
							console.error("Failed to process MCP settings change:", error)
						}
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
		const settings = await this.readAndValidateMcpSettingsFile()
		if (settings) {
			await this.updateServerConnections(settings.mcpServers)
		}
	}

	private async connectToServer(
		name: string,
		config: z.infer<typeof StdioConfigSchema> | z.infer<typeof SseConfigSchema>,
	): Promise<void> {
		// Remove existing connection if it exists (should never happen, the connection should be deleted beforehand)
		this.connections = this.connections.filter((conn) => conn.server.name !== name)

		try {
			// Each MCP server requires its own transport connection and has unique capabilities, configurations, and error handling. Having separate clients also allows proper scoping of resources/tools and independent server management like reconnection.
			const client = new Client(
				{
					name: "Cline",
					version: this.clientVersion,
				},
				{
					capabilities: {},
				},
			)

			let transport: StdioClientTransport | SSEClientTransport

			if (config.transportType === "sse") {
				transport = new SSEClientTransport(new URL(config.url), {})
			} else {
				transport = new StdioClientTransport({
					command: config.command,
					args: config.args,
					env: {
						...config.env,
						...(process.env.PATH ? { PATH: process.env.PATH } : {}),
						// ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}),
					},
					stderr: "pipe", // necessary for stderr to be available
				})
			}

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

			const connection: McpConnection = {
				server: {
					name,
					config: JSON.stringify(config),
					status: "connecting",
					disabled: config.disabled,
				},
				client,
				transport,
			}
			this.connections.push(connection)

			if (config.transportType === "stdio") {
				// transport.stderr is only available after the process has been started. However we can't start it separately from the .connect() call because it also starts the transport. And we can't place this after the connect call since we need to capture the stderr stream before the connection is established, in order to capture errors during the connection process.
				// As a workaround, we start the transport ourselves, and then monkey-patch the start method to no-op so that .connect() doesn't try to start it again.
				await transport.start()
				const stderrStream = (transport as StdioClientTransport).stderr
				if (stderrStream) {
					stderrStream.on("data", async (data: Buffer) => {
						const output = data.toString()
						// Check if output contains INFO level log
						const isInfoLog = /^\s*INFO\b/.test(output)

						if (isInfoLog) {
							// Log normal informational messages
							console.info(`Server "${name}" info:`, output)
						} else {
							// Treat as error log
							console.error(`Server "${name}" stderr:`, output)
							const connection = this.connections.find((conn) => conn.server.name === name)
							if (connection) {
								this.appendErrorMessage(connection, output)
								// Only notify webview if server is already disconnected
								if (connection.server.status === "disconnected") {
									await this.notifyWebviewOfServerChanges()
								}
							}
						}
					})
				} else {
					console.error(`No stderr stream for ${name}`)
				}
				transport.start = async () => {} // No-op now, .connect() won't fail
			}

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
			const connection = this.connections.find((conn) => conn.server.name === serverName)

			if (!connection) {
				throw new Error(`No connection found for server: ${serverName}`)
			}

			const response = await connection.client.request({ method: "tools/list" }, ListToolsResultSchema, {
				timeout: DEFAULT_REQUEST_TIMEOUT_MS,
			})

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
				?.client.request({ method: "resources/list" }, ListResourcesResultSchema, { timeout: DEFAULT_REQUEST_TIMEOUT_MS })
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
				?.client.request({ method: "resources/templates/list" }, ListResourceTemplatesResultSchema, {
					timeout: DEFAULT_REQUEST_TIMEOUT_MS,
				})

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

	async updateServerConnections(newServers: Record<string, McpServerConfig>): Promise<void> {
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
					if (config.transportType === "stdio") {
						this.setupFileWatcher(name, config)
					}
					await this.connectToServer(name, config)
				} catch (error) {
					console.error(`Failed to connect to new MCP server ${name}:`, error)
				}
			} else if (!deepEqual(JSON.parse(currentConnection.server.config), config)) {
				// Existing server with changed config
				try {
					if (config.transportType === "stdio") {
						this.setupFileWatcher(name, config)
					}
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
	private setupFileWatcher(name: string, config: Extract<McpServerConfig, { transportType: "stdio" }>) {
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

		// Get existing connection and update its status
		const connection = this.connections.find((conn) => conn.server.name === serverName)
		const config = connection?.server.config
		if (config) {
			vscode.window.showInformationMessage(`Restarting ${serverName} MCP server...`)
			connection.server.status = "connecting"
			connection.server.error = ""
			await this.notifyWebviewOfServerChanges()
			await setTimeoutPromise(500) // artificial delay to show user that server is restarting
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
		await this.postMessageToWebview({
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
		try {
			const config = await this.readAndValidateMcpSettingsFile()
			if (!config) {
				throw new Error("Failed to read or validate MCP settings")
			}

			if (config.mcpServers[serverName]) {
				config.mcpServers[serverName].disabled = disabled

				const settingsPath = await this.getMcpSettingsFilePath()
				await fs.writeFile(settingsPath, JSON.stringify(config, null, 2))

				const connection = this.connections.find((conn) => conn.server.name === serverName)
				if (connection) {
					connection.server.disabled = disabled
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
			const parsedConfig = ServerConfigSchema.parse(config)
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

	async toggleToolAutoApprove(serverName: string, toolNames: string[], shouldAllow: boolean): Promise<void> {
		try {
			const settingsPath = await this.getMcpSettingsFilePath()
			const content = await fs.readFile(settingsPath, "utf-8")
			const config = JSON.parse(content)

			// Initialize autoApprove if it doesn't exist
			if (!config.mcpServers[serverName].autoApprove) {
				config.mcpServers[serverName].autoApprove = []
			}

			const autoApprove = config.mcpServers[serverName].autoApprove
			for (const toolName of toolNames) {
				const toolIndex = autoApprove.indexOf(toolName)

				if (shouldAllow && toolIndex === -1) {
					// Add tool to autoApprove list
					autoApprove.push(toolName)
				} else if (!shouldAllow && toolIndex !== -1) {
					// Remove tool from autoApprove list
					autoApprove.splice(toolIndex, 1)
				}
			}

			await fs.writeFile(settingsPath, JSON.stringify(config, null, 2))

			// Update the tools list to reflect the change
			const connection = this.connections.find((conn) => conn.server.name === serverName)
			if (connection && connection.server.tools) {
				// Update the autoApprove property of each tool in the in-memory server object
				connection.server.tools = connection.server.tools.map((tool) => ({
					...tool,
					autoApprove: autoApprove.includes(tool.name),
				}))
				await this.notifyWebviewOfServerChanges()
			}
		} catch (error) {
			console.error("Failed to update autoApprove settings:", error)
			vscode.window.showErrorMessage("Failed to update autoApprove settings")
			throw error // Re-throw to ensure the error is properly handled
		}
	}

	public async addRemoteServer(serverName: string, serverUrl: string) {
		try {
			const settings = await this.readAndValidateMcpSettingsFile()
			if (!settings) {
				throw new Error("Failed to read MCP settings")
			}

			if (settings.mcpServers[serverName]) {
				throw new Error(`An MCP server with the name "${serverName}" already exists`)
			}

			const urlValidation = z.string().url().safeParse(serverUrl)
			if (!urlValidation.success) {
				throw new Error(`Invalid server URL: ${serverUrl}. Please provide a valid URL.`)
			}

			const serverConfig = {
				url: serverUrl,
				disabled: false,
				autoApprove: [],
			}

			const parsedConfig = ServerConfigSchema.parse(serverConfig)

			settings.mcpServers[serverName] = parsedConfig
			const settingsPath = await this.getMcpSettingsFilePath()

			// We don't write the zod-transformed version to the file.
			// The above parse() call adds the transportType field to the server config
			// It would be fine if this was written, but we don't want to clutter up the file with internal details

			// ToDo: We could benefit from input / output types reflecting the non-transformed / transformed versions
			await fs.writeFile(
				settingsPath,
				JSON.stringify({ mcpServers: { ...settings.mcpServers, [serverName]: serverConfig } }, null, 2),
			)

			await this.updateServerConnections(settings.mcpServers)

			vscode.window.showInformationMessage(`Added ${serverName} MCP server`)
		} catch (error) {
			console.error("Failed to add remote MCP server:", error)

			throw error
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
			const setConfigResult = BaseConfigSchema.shape.timeout.safeParse(timeout)
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
