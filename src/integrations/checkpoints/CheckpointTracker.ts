import fs from "fs/promises"
import os from "os"
import * as path from "path"
// simpleGit 是一个轻量化的在 node.js 中使用 git 接口的库
import simpleGit, { SimpleGit } from "simple-git"
import * as vscode from "vscode"
import { ClineProvider } from "../../core/webview/ClineProvider"
import { fileExistsAtPath } from "../../utils/fs"
import { globby } from "globby"

/**
 * Cline 实例的 Checkpoint 管理器，基于 simpleGit 实现。
 *
 * 它是 Cline 实例的工具类，作为 Cline 实例的一个属性，用于管理 Checkpoint 的创建、提交、重置等操作。
 *
 * 路径为 [context.globalStorageUri.fsPath]/tasks/[taskId]/checkpoints/.git
 * @docs simpleGit https://www.npmjs.com/package/simple-git
 */
class CheckpointTracker {
	private providerRef: WeakRef<ClineProvider>
	private taskId: string
	private disposables: vscode.Disposable[] = []
	private cwd: string
	private lastRetrievedShadowGitConfigWorkTree?: string
	lastCheckpointHash?: string

	private constructor(provider: ClineProvider, taskId: string, cwd: string) {
		/** 引用的 ClineProvider 实例 */
		this.providerRef = new WeakRef(provider)
		/** CheckpointTracker 所属的 Cline 实例绑定的任务 id */
		this.taskId = taskId
		this.cwd = cwd
	}

	/**
	 * 创建 CheckpointTracker 实例
	 * @param taskId CheckpointTracker 所属的 Cline 实例绑定的任务 id
	 * @param provider 引用的 ClineProvider 实例
	 * @returns
	 */
	public static async create(taskId: string, provider?: ClineProvider): Promise<CheckpointTracker | undefined> {
		try {
			if (!provider) {
				throw new Error("Provider is required to create a checkpoint tracker")
			}

			// Check if checkpoints are disabled in VS Code settings
			/** 这个在 Cline 插件 “设置-高级设置” 打开 VSCode 的设置面板 */
			const enableCheckpoints = vscode.workspace.getConfiguration("cline").get<boolean>("enableCheckpoints") ?? true
			if (!enableCheckpoints) {
				return undefined // Don't create tracker when disabled
			}

			// Check if git is installed by attempting to get version
			try {
				await simpleGit().version()
			} catch (error) {
				throw new Error("Git must be installed to use checkpoints.") // FIXME: must match what we check for in TaskHeader to show link
			}

			const cwd = await CheckpointTracker.getWorkingDirectory()
			const newTracker = new CheckpointTracker(provider, taskId, cwd)
			await newTracker.initShadowGit()
			return newTracker
		} catch (error) {
			console.error("Failed to create CheckpointTracker:", error)
			throw error
		}
	}

	/**
	 * CheckpointTracker 中获得当前工作目录的私有静态方法。
	 * 如果当前工作目录不是 家目录、桌面、文档、下载，返回当前工作目录。
	 * @returns 当前工作目录 string cwd
	 */
	private static async getWorkingDirectory(): Promise<string> {
		const cwd = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).at(0)
		if (!cwd) {
			throw new Error("No workspace detected. Please open Cline in a workspace to use checkpoints.")
		}
		const homedir = os.homedir()
		const desktopPath = path.join(homedir, "Desktop")
		const documentsPath = path.join(homedir, "Documents")
		const downloadsPath = path.join(homedir, "Downloads")

		switch (cwd) {
			case homedir:
				throw new Error("Cannot use checkpoints in home directory")
			case desktopPath:
				throw new Error("Cannot use checkpoints in Desktop directory")
			case documentsPath:
				throw new Error("Cannot use checkpoints in Documents directory")
			case downloadsPath:
				throw new Error("Cannot use checkpoints in Downloads directory")
			default:
				return cwd
		}
	}

	/** 返回路径：[context.globalStorageUri.fsPath]/tasks/[taskId]/checkpoints/.git */
	private async getShadowGitPath(): Promise<string> {
		const globalStoragePath = this.providerRef.deref()?.context.globalStorageUri.fsPath
		if (!globalStoragePath) {
			throw new Error("Global storage uri is invalid")
		}
		const checkpointsDir = path.join(globalStoragePath, "tasks", this.taskId, "checkpoints")
		await fs.mkdir(checkpointsDir, { recursive: true })
		const gitPath = path.join(checkpointsDir, ".git")
		return gitPath
	}

	/** 判断路径是否存在：[context.globalStorageUri.fsPath]/tasks/[taskId]/checkpoints/.git */
	public static async doesShadowGitExist(taskId: string, provider?: ClineProvider): Promise<boolean> {
		const globalStoragePath = provider?.context.globalStorageUri.fsPath
		if (!globalStoragePath) {
			return false
		}
		const gitPath = path.join(globalStoragePath, "tasks", taskId, "checkpoints", ".git")
		return await fileExistsAtPath(gitPath)
	}
	/**
	 * 初始化 Shadow Git 仓库 添加忽略规则、设置 Git 用户信息、添加所有文件并进行初始提交。
	 */
	public async initShadowGit(): Promise<string> {
		const gitPath = await this.getShadowGitPath()
		if (await fileExistsAtPath(gitPath)) {
			// Make sure it's the same cwd as the configured worktree
			const worktree = await this.getShadowGitConfigWorkTree()
			if (worktree !== this.cwd) {
				throw new Error("Checkpoints can only be used in the original workspace: " + worktree)
			}

			return gitPath
		} else {
			const checkpointsDir = path.dirname(gitPath)
			const git = simpleGit(checkpointsDir)
			await git.init()
			// 设置工作目录为当前工作空间
			await git.addConfig("core.worktree", this.cwd) // sets the working tree to the current workspace

			// Disable commit signing for shadow repo
			await git.addConfig("commit.gpgSign", "false")

			// Get LFS patterns from workspace if they exist
			let lfsPatterns: string[] = []
			try {
				const attributesPath = path.join(this.cwd, ".gitattributes")
				if (await fileExistsAtPath(attributesPath)) {
					const attributesContent = await fs.readFile(attributesPath, "utf8")
					lfsPatterns = attributesContent
						.split("\n")
						.filter((line) => line.includes("filter=lfs"))
						.map((line) => line.split(" ")[0].trim())
				}
			} catch (error) {
				console.warn("Failed to read .gitattributes:", error)
			}

			// Add basic excludes directly in git config, while respecting any .gitignore in the workspace
			// .git/info/exclude is local to the shadow git repo, so it's not shared with the main repo - and won't conflict with user's .gitignore
			// TODO: let user customize these
			// 添加基本忽略规则，同时尊重工作空间中的 .gitignore 文件
			const excludesPath = path.join(gitPath, "info", "exclude")
			await fs.mkdir(path.join(gitPath, "info"), { recursive: true })
			await fs.writeFile(
				excludesPath,
				[
					".git/", // ignore the user's .git
					`.git${GIT_DISABLED_SUFFIX}/`, // ignore the disabled nested git repos
					".DS_Store",
					"*.log",
					"node_modules/",
					"__pycache__/",
					"env/",
					"venv/",
					"target/dependency/",
					"build/dependencies/",
					"dist/",
					"out/",
					"bundle/",
					"vendor/",
					"tmp/",
					"temp/",
					"deps/",
					"pkg/",
					"Pods/",
					// Media files
					"*.jpg",
					"*.jpeg",
					"*.png",
					"*.gif",
					"*.bmp",
					"*.ico",
					// "*.svg",
					"*.mp3",
					"*.mp4",
					"*.wav",
					"*.avi",
					"*.mov",
					"*.wmv",
					"*.webm",
					"*.webp",
					"*.m4a",
					"*.flac",
					// Build and dependency directories
					"build/",
					"bin/",
					"obj/",
					".gradle/",
					".idea/",
					".vscode/",
					".vs/",
					"coverage/",
					".next/",
					".nuxt/",
					// Cache and temporary files
					"*.cache",
					"*.tmp",
					"*.temp",
					"*.swp",
					"*.swo",
					"*.pyc",
					"*.pyo",
					".pytest_cache/",
					".eslintcache",
					// Environment and config files
					".env*",
					"*.local",
					"*.development",
					"*.production",
					// Large data files
					"*.zip",
					"*.tar",
					"*.gz",
					"*.rar",
					"*.7z",
					"*.iso",
					"*.bin",
					"*.exe",
					"*.dll",
					"*.so",
					"*.dylib",
					// Database files
					"*.sqlite",
					"*.db",
					"*.sql",
					// Log files
					"*.logs",
					"*.error",
					"npm-debug.log*",
					"yarn-debug.log*",
					"yarn-error.log*",
					...lfsPatterns,
				].join("\n"),
			)

			// Set up git identity (git throws an error if user.name or user.email is not set)
			await git.addConfig("user.name", "Cline Checkpoint")
			await git.addConfig("user.email", "noreply@example.com")

			await this.addAllFiles(git)
			// Initial commit (--allow-empty ensures it works even with no files)
			await git.commit("initial commit", { "--allow-empty": null })

			return gitPath
		}
	}

	/** 获得当前 CheckpointTracker 的 git WorkTree */
	public async getShadowGitConfigWorkTree(): Promise<string | undefined> {
		if (this.lastRetrievedShadowGitConfigWorkTree) {
			return this.lastRetrievedShadowGitConfigWorkTree
		}
		try {
			const gitPath = await this.getShadowGitPath()
			const git = simpleGit(path.dirname(gitPath))
			const worktree = await git.getConfig("core.worktree")
			this.lastRetrievedShadowGitConfigWorkTree = worktree.value || undefined
			return this.lastRetrievedShadowGitConfigWorkTree
		} catch (error) {
			console.error("Failed to get shadow git config worktree:", error)
			return undefined
		}
	}
	/** 提交当前更改到Git仓库，并返回提交哈希值 */
	public async commit(): Promise<string | undefined> {
		try {
			const gitPath = await this.getShadowGitPath()
			const git = simpleGit(path.dirname(gitPath))
			await this.addAllFiles(git)
			const result = await git.commit("checkpoint", {
				"--allow-empty": null,
			})
			const commitHash = result.commit || ""
			this.lastCheckpointHash = commitHash
			return commitHash
		} catch (error) {
			console.error("Failed to create checkpoint:", error)
			return undefined
		}
	}
	/**
	 * 将 Git 仓库的 HEAD 重置到指定的提交。
	 * @param commitHash - 目标提交的哈希值，HEAD 将重置到该提交。
	 */
	public async resetHead(commitHash: string): Promise<void> {
		const gitPath = await this.getShadowGitPath()
		const git = simpleGit(path.dirname(gitPath))

		// Clean working directory and force reset
		// This ensures that the operation will succeed regardless of:
		// - Untracked files in the workspace
		// - Staged changes
		// - Unstaged changes
		// - Partial commits
		// - Merge conflicts
		await git.clean("f", ["-d", "-f"]) // Remove untracked files and directories
		await git.reset(["--hard", commitHash]) // Hard reset to target commit
	}

	/**
	 * Return an array describing changed files between one commit and either:
	 *   - another commit, or
	 *   - the current working directory (including uncommitted changes).
	 *
	 * If `rhsHash` is omitted, compares `lhsHash` to the working directory.
	 * If you want truly untracked files to appear, `git add` them first.
	 *
	 * @param lhsHash - The commit to compare from (older commit)
	 * @param rhsHash - The commit to compare to (newer commit).
	 *                  If omitted, we compare to the working directory.
	 * @returns Array of file changes with before/after content
	 */
	/**
	 * 返回一个描述两个提交之间或一个提交与当前工作目录之间更改文件的数组（包括未提交的更改）。
	 *
	 * @param lhsHash - 比较的起始提交（较旧的提交）
	 * @param rhsHash - 比较的目标提交（较新的提交）。如果省略，则与工作目录进行比较。
	 * @returns 包含文件更改前后内容的数组
	 */
	public async getDiffSet(
		lhsHash?: string,
		rhsHash?: string,
	): Promise<
		Array<{
			relativePath: string
			absolutePath: string
			before: string
			after: string
		}>
	> {
		const gitPath = await this.getShadowGitPath()
		const git = simpleGit(path.dirname(gitPath))

		// 如果未提供 lhsHash，则使用仓库的初始提交
		let baseHash = lhsHash
		if (!baseHash) {
			const rootCommit = await git.raw(["rev-list", "--max-parents=0", "HEAD"])
			baseHash = rootCommit.trim()
		}

		// Stage all changes so that untracked files appear in diff summary
		await this.addAllFiles(git)

		const diffSummary = rhsHash ? await git.diffSummary([`${baseHash}..${rhsHash}`]) : await git.diffSummary([baseHash])

		// For each changed file, gather before/after content
		const result = []
		const cwdPath = (await this.getShadowGitConfigWorkTree()) || this.cwd || ""

		for (const file of diffSummary.files) {
			const filePath = file.file
			const absolutePath = path.join(cwdPath, filePath)

			let beforeContent = ""
			try {
				beforeContent = await git.show([`${baseHash}:${filePath}`])
			} catch (_) {
				// file didn't exist in older commit => remains empty
			}

			let afterContent = ""
			if (rhsHash) {
				// if user provided a newer commit, use git.show at that commit
				try {
					afterContent = await git.show([`${rhsHash}:${filePath}`])
				} catch (_) {
					// file didn't exist in newer commit => remains empty
				}
			} else {
				// otherwise, read from disk (includes uncommitted changes)
				try {
					afterContent = await fs.readFile(absolutePath, "utf8")
				} catch (_) {
					// file might be deleted => remains empty
				}
			}

			result.push({
				relativePath: filePath,
				absolutePath,
				before: beforeContent,
				after: afterContent,
			})
		}

		return result
	}
	/** 将所有文件添加到 Git 仓库 */
	private async addAllFiles(git: SimpleGit) {
		await this.renameNestedGitRepos(true)
		try {
			await git.add(".")
		} catch (error) {
			console.error("Failed to add files to git:", error)
		} finally {
			await this.renameNestedGitRepos(false)
		}
	}
	/**
	 * 重命名嵌套的 Git 仓库目录以启用或禁用。
	 *
	 * 使用 Git 跟踪检查点时，需要临时禁用嵌套的 Git 仓库
	 *
	 * @param disable - 如果为 true，则禁用嵌套的 Git 仓库；如果为 false，则重新启用它们。
	 */
	private async renameNestedGitRepos(disable: boolean) {
		// Find all .git directories that are not at the root level
		const gitPaths = await globby("**/.git" + (disable ? "" : GIT_DISABLED_SUFFIX), {
			cwd: this.cwd,
			onlyDirectories: true,
			ignore: [".git"], // Ignore root level .git
			dot: true,
			markDirectories: false,
		})

		// For each nested .git directory, rename it based on operation
		for (const gitPath of gitPaths) {
			const fullPath = path.join(this.cwd, gitPath)
			let newPath: string
			if (disable) {
				newPath = fullPath + GIT_DISABLED_SUFFIX
			} else {
				newPath = fullPath.endsWith(GIT_DISABLED_SUFFIX) ? fullPath.slice(0, -GIT_DISABLED_SUFFIX.length) : fullPath
			}

			try {
				await fs.rename(fullPath, newPath)
				console.log(`CheckpointTracker ${disable ? "disabled" : "enabled"} nested git repo ${gitPath}`)
			} catch (error) {
				console.error(`CheckpointTracker failed to ${disable ? "disable" : "enable"} nested git repo ${gitPath}:`, error)
			}
		}
	}

	public dispose() {
		this.disposables.forEach((d) => d.dispose())
		this.disposables = []
	}
}

const GIT_DISABLED_SUFFIX = "_disabled"

export default CheckpointTracker
