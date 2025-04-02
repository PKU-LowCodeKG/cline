import * as vscode from "vscode"
import * as path from "path"
import { listFiles } from "../../services/glob/list-files"
import { Controller } from "../../core/controller"

/**
 * 获取当前工作区的第一个文件夹（如果有文件夹）的 fsPath（文件系统路径）。
 * `vscode.workspace.workspaceFolders` 是一个包含工作区中所有文件夹的数组
 */
const cwd = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).at(0)

// Note: this is not a drop-in replacement for listFiles at the start of tasks, since that will be done for Desktops when there is no workspace selected
// NOTE: 这不是任务开始时，对 listFiles() 函数的直接替换，因为当没有选择工作区时，将对 Desktops 执行（listFiles() 函数？而 这个类是针对工作区的）
/**
 * Cline 对于 工作区的监视器，用于跟踪 根工作区 cwd 中的文件结构变化。
 * 只在 Controller 实例化时调用。【原 ClineProvider 类】
 * NOTE: vscode.Disposable 是一个可以释放资源的对象，用于注册回调函数以释放资源。
 * 
 * 在 JS 或 TS 中，使用 WeakRef 可以避免由于不必要的强引用导致的对象无法被及时回收的问题。
 * https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/WeakRef
 * 可以通过 .deref() 方法获取其实际引用。
 * 如果该 target 对象已被 GC 回收则返回 undefined。
 */
class WorkspaceTracker {
	private controllerRef: WeakRef<Controller>
	private disposables: vscode.Disposable[] = []
	private filePaths: Set<string> = new Set()

	constructor(controller: Controller) {
		this.controllerRef = new WeakRef(controller)
		this.registerListeners()
	}

	/**
	 * 调用 listFiles() 方法（src\services\glob\list-files.ts）
	 * 获取当前工作区的最多 1000 个文件路径，并将其添加到 filePaths 集合中（WorkspaceTracker 实例的私有属性）。
	 */
	async populateFilePaths() {
		// should not auto get filepaths for desktop since it would immediately show permission popup before cline ever creates a file
		if (!cwd) {
			return
		}
		const [files, _] = await listFiles(cwd, true, 1_000)
		files.forEach((file) => this.filePaths.add(this.normalizeFilePath(file)))
		this.workspaceDidUpdate()
	}

	/**
	 * 在创造 WorkspaceTracker 实例时，
	 * 注册对 VS Code 文件系统事件的监听器，包括文件创建、删除和重命名。
	 */
	private registerListeners() {
		// Listen for file creation
		// .bind(this) ensures the callback refers to class instance when using this, not necessary when using arrow function
		this.disposables.push(vscode.workspace.onDidCreateFiles(this.onFilesCreated.bind(this)))
		// NOTE: 用箭头函数应该是等价的
		// this.disposables.push(vscode.workspace.onDidCreateFiles((event) => this.onFilesCreated(event)))

		// Listen for file deletion
		this.disposables.push(vscode.workspace.onDidDeleteFiles(this.onFilesDeleted.bind(this)))

		// Listen for file renaming
		this.disposables.push(vscode.workspace.onDidRenameFiles(this.onFilesRenamed.bind(this)))

		/*
		 An event that is emitted when a workspace folder is added or removed.
		 **Note:** this event will not fire if the first workspace folder is added, removed or changed,
		 because in that case the currently executing extensions (including the one that listens to this
		 event) will be terminated and restarted so that the (deprecated) `rootPath` property is updated
		 to point to the first workspace folder.
		 */
		// In other words, we don't have to worry about the root workspace folder ([0]) changing since the extension will be restarted and our cwd will be updated to reflect the new workspace folder. (We don't care about non root workspace folders, since cline will only be working within the root folder cwd)
		// this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(this.onWorkspaceFoldersChanged.bind(this)))

		// NOTE: 上面这段是说，onDidChangeWorkspaceFolders 事件会在 工作区文件夹被添加或删除 时触发，即如果用户在多根工作区模式下，添加了 /projectC：vscode.workspace.workspaceFolders = [ "/projectB", "/projectC" ]，则会触发 onDidChangeWorkspaceFolders 事件。
		// 但是 如果工作区的第一个文件夹（根工作区）发生变更，VS Code 会重启所有扩展，cwd 变量会被正确更新。
		// 而 WorkspaceTracker 只关心 cwd（根工作区 "/projectB"），因此可以忽略这个事件。
	}

	/** 当文件被创建时，添加文件路径到 filePaths 集合。 */
	private async onFilesCreated(event: vscode.FileCreateEvent) {
		await Promise.all(
			event.files.map(async (file) => {
				await this.addFilePath(file.fsPath)
			}),
		)
		this.workspaceDidUpdate()
	}

	/** 当文件被删除时，从 filePaths 集合中删除文件路径。 */
	private async onFilesDeleted(event: vscode.FileDeleteEvent) {
		let updated = false
		await Promise.all(
			event.files.map(async (file) => {
				if (await this.removeFilePath(file.fsPath)) {
					updated = true
				}
			}),
		)
		if (updated) {
			this.workspaceDidUpdate()
		}
	}

	/** 当文件被重命名时，从 filePaths 集合中删除旧文件路径，添加新文件路径。 */
	private async onFilesRenamed(event: vscode.FileRenameEvent) {
		await Promise.all(
			event.files.map(async (file) => {
				await this.removeFilePath(file.oldUri.fsPath)
				await this.addFilePath(file.newUri.fsPath)
			}),
		)
		this.workspaceDidUpdate()
	}

	/**
	 * （当工作区 文件结构 发生变更时），将文件路径的更新推送到 Webview。
	 * NOTE: 在 webview-ui\src\context\ExtensionStateContext.tsx 中处理
	 */
	private workspaceDidUpdate() {
		if (!cwd) {
			return
		}
		this.controllerRef.deref()?.postMessageToWebview({
			type: "workspaceUpdated",
			filePaths: Array.from(this.filePaths).map((file) => {
				const relativePath = path.relative(cwd, file).toPosix()
				return file.endsWith("/") ? relativePath + "/" : relativePath
			}),
		})
	}

	private normalizeFilePath(filePath: string): string {
		const resolvedPath = cwd ? path.resolve(cwd, filePath) : path.resolve(filePath)
		return filePath.endsWith("/") ? resolvedPath + "/" : resolvedPath
	}

	private async addFilePath(filePath: string): Promise<string> {
		const normalizedPath = this.normalizeFilePath(filePath)
		try {
			const stat = await vscode.workspace.fs.stat(vscode.Uri.file(normalizedPath))
			const isDirectory = (stat.type & vscode.FileType.Directory) !== 0
			const pathWithSlash = isDirectory && !normalizedPath.endsWith("/") ? normalizedPath + "/" : normalizedPath
			this.filePaths.add(pathWithSlash)
			return pathWithSlash
		} catch {
			// If stat fails, assume it's a file (this can happen for newly created files)
			this.filePaths.add(normalizedPath)
			return normalizedPath
		}
	}

	private async removeFilePath(filePath: string): Promise<boolean> {
		const normalizedPath = this.normalizeFilePath(filePath)
		return this.filePaths.delete(normalizedPath) || this.filePaths.delete(normalizedPath + "/")
	}

	/** dispose() 方法用于清理所有注册的监听器。 */
	public dispose() {
		this.disposables.forEach((d) => d.dispose())
	}
}

export default WorkspaceTracker
