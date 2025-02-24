import * as vscode from "vscode"
import * as path from "path"
import { openFile } from "../../integrations/misc/open-file"
import { UrlContentFetcher } from "../../services/browser/UrlContentFetcher"
import { mentionRegexGlobal } from "../../shared/context-mentions"
import fs from "fs/promises"
import { extractTextFromFile } from "../../integrations/misc/extract-text"
import { isBinaryFile } from "isbinaryfile"
import { diagnosticsToProblemsString } from "../../integrations/diagnostics"
import { getLatestTerminalOutput } from "../../integrations/terminal/get-latest-output"
import { getCommitInfo } from "../../utils/git"
import { getWorkingState } from "../../utils/git"
import { url } from "inspector"
import axios from "axios"

export function openMention(mention?: string): void {
	if (!mention) {
		return
	}

	const cwd = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).at(0)
	if (!cwd) {
		return
	}

	if (mention.startsWith("/")) {
		const relPath = mention.slice(1)
		const absPath = path.resolve(cwd, relPath)
		if (mention.endsWith("/")) {
			vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(absPath))
		} else {
			openFile(absPath)
		}
	} else if (mention === "problems") {
		vscode.commands.executeCommand("workbench.actions.view.problems")
	} else if (mention === "terminal") {
		vscode.commands.executeCommand("workbench.action.terminal.focus")
	} else if (mention.startsWith("http")) {
		vscode.env.openExternal(vscode.Uri.parse(mention))
	}
}

/**
 * 解析 对话中 用户生成的内容 文本中的 mentions（@），并将 mentions（@）的详细信息追加到解析后的文本中。
 *
 * 【mentions】Cline 中的 mentions 被定义为以 "@" 开头的字符串，代表 Cline 提供的辅助功能，如：解析 URL、提供文件路径等
 * @param text 包含 mentions 的原始文本。
 * @param cwd 当前工作目录的路径。
 * @param urlContentFetcher 用于从 URL 获取内容并转换为 Markdown 的工具实例。
 * @returns 解析后的文本，包含原始文本和提及内容的详细信息。
 */
export async function parseMentions(text: string, cwd: string, urlContentFetcher: UrlContentFetcher): Promise<string> {
	// 创建一个Set来存储文本中出现的所有 mentions（@）
	const mentions: Set<string> = new Set()

	// 使用正则表达式匹配文本中的提及内容，并对其进行替换处理
	// NOTE: 这里的 mention 是完整的正则匹配，mention 是正则中的第一个捕获组（只有 "@" 后面的关键词）
	let parsedText = text.replace(mentionRegexGlobal, (match, mention) => {
		// 将匹配到的提及内容添加到Set中
		mentions.add(mention)

		// 如果提及内容是一个 URL（插件前端 @URL）
		if (mention.startsWith("http")) {
			// 将其替换为特定格式的文本，提示用户可以查看下方的网站内容
			return `'${mention}' (see below for site content)`
		}
		// 如果提及内容以 "/" 开头（插件前端 @Folder 或者 @File）
		else if (mention.startsWith("/")) {
			// 去除路径前面的斜杠
			const mentionPath = mention.slice(1)
			// 判断路径是否以斜杠结尾，如果是则表示是文件夹，否则表示是文件
			return mentionPath.endsWith("/")
				? `'${mentionPath}' (see below for folder content)`
				: `'${mentionPath}' (see below for file content)`
		}
		// 如果提及内容是 "problems"（插件前端 @Problems）
		else if (mention === "problems") {
			// 将其替换为提示用户查看下方工作区诊断信息的文本
			return `Workspace Problems (see below for diagnostics)`
		}
		// 如果提及内容是 "terminal"
		else if (mention === "terminal") {
			// 将其替换为提示用户查看下方终端输出信息的文本
			return `Terminal Output (see below for output)`
		}
		// 如果提及内容是 "git-changes"
		else if (mention === "git-changes") {
			// 将其替换为提示用户查看下方工作目录更改详细信息的文本
			return `Working directory changes (see below for details)`
		}
		// 如果提及内容是一个7到40位的十六进制字符串，可能是Git提交哈希值
		else if (/^[a-f0-9]{7,40}$/.test(mention)) {
			// 将其替换为提示用户查看下方提交信息的文本
			return `Git commit '${mention}' (see below for commit info)`
		}
		// 如果都不匹配，则返回原始匹配内容
		return match
	})

	// 从提及内容的Set中查找第一个以 "http" 开头的URL
	const urlMention = Array.from(mentions).find((mention) => mention.startsWith("http"))
	// 用于存储启动浏览器时可能出现的错误
	let launchBrowserError: Error | undefined

	// 如果存在URL提及内容
	if (urlMention) {
		try {
			// 启动浏览器，以便后续获取URL的内容
			await urlContentFetcher.launchBrowser()
		} catch (error) {
			// 捕获启动浏览器时的错误
			launchBrowserError = error as Error
			// 在VS Code窗口中显示错误消息，提示用户获取URL内容时出错
			vscode.window.showErrorMessage(`Error fetching content for ${urlMention}: ${error.message}`)
		}
	}

	// 遍历所有的提及内容
	for (const mention of mentions) {
		// 如果提及内容是一个 URL（插件前端 @URL）
		if (mention.startsWith("http")) {
			let result: string
			// 如果启动浏览器时出现错误
			if (launchBrowserError) {
				// 结果显示为获取内容时的错误信息
				result = `Error fetching content: ${launchBrowserError.message}`
			} else {
				try {
					// To Do, 从URL下载软件项目到指定目录（默认当前工作区目录）
					// urlContentFetcher.downloadFile(mention, cwd);
					urlContentFetcher.downloadFile(mention, "D:/Downloads/test")
					// 使用UrlContentFetcher工具从URL获取内容并转换为Markdown格式
					const markdown = await urlContentFetcher.urlToMarkdown(mention)
					result = markdown
				} catch (error) {
					// 捕获获取URL内容时的错误
					vscode.window.showErrorMessage(`Error fetching content for ${mention}: ${error.message}`)
					result = `Error fetching content: ${error.message}`
				}
			}
			// 将URL的内容或错误信息以特定的标签格式追加到解析后的文本中
			parsedText += `\n\n<url_content url="${mention}">\n${result}\n</url_content>`
		}
		// 如果提及内容以 "/" 开头（插件前端 @Folder 或者 @File）
		else if (mention.startsWith("/")) {
			// 去除路径前面的斜杠
			const mentionPath = mention.slice(1)
			try {
				// 获取文件或文件夹的内容
				const content = await getFileOrFolderContent(mentionPath, cwd)
				if (mention.endsWith("/")) {
					// 如果是文件夹，将文件夹内容以特定的标签格式追加到解析后的文本中
					parsedText += `\n\n<folder_content path="${mentionPath}">\n${content}\n</folder_content>`
				} else {
					// 如果是文件，将文件内容以特定的标签格式追加到解析后的文本中
					parsedText += `\n\n<file_content path="${mentionPath}">\n${content}\n</file_content>`
				}
			} catch (error) {
				if (mention.endsWith("/")) {
					// 如果是文件夹，将获取文件夹内容时的错误信息以特定的标签格式追加到解析后的文本中
					parsedText += `\n\n<folder_content path="${mentionPath}">\nError fetching content: ${error.message}\n</folder_content>`
				} else {
					// 如果是文件，将获取文件内容时的错误信息以特定的标签格式追加到解析后的文本中
					parsedText += `\n\n<file_content path="${mentionPath}">\nError fetching content: ${error.message}\n</file_content>`
				}
			}
		}
		// 如果提及内容是 "problems"（插件前端 @Problems）
		else if (mention === "problems") {
			try {
				// 获取工作区的问题诊断信息
				const problems = getWorkspaceProblems(cwd)
				// 将工作区问题诊断信息以特定的标签格式追加到解析后的文本中
				parsedText += `\n\n<workspace_diagnostics>\n${problems}\n</workspace_diagnostics>`
			} catch (error) {
				// 将获取工作区问题诊断信息时的错误信息以特定的标签格式追加到解析后的文本中
				parsedText += `\n\n<workspace_diagnostics>\nError fetching diagnostics: ${error.message}\n</workspace_diagnostics>`
			}
		}
		// 如果提及内容是 "terminal"
		else if (mention === "terminal") {
			try {
				// 获取最新的终端输出信息
				const terminalOutput = await getLatestTerminalOutput()
				// 将终端输出信息以特定的标签格式追加到解析后的文本中
				parsedText += `\n\n<terminal_output>\n${terminalOutput}\n</terminal_output>`
			} catch (error) {
				// 将获取终端输出信息时的错误信息以特定的标签格式追加到解析后的文本中
				parsedText += `\n\n<terminal_output>\nError fetching terminal output: ${error.message}\n</terminal_output>`
			}
		}
		// 如果提及内容是 "git-changes"
		else if (mention === "git-changes") {
			try {
				// 获取工作目录的Git状态信息
				const workingState = await getWorkingState(cwd)
				// 将工作目录的Git状态信息以特定的标签格式追加到解析后的文本中
				parsedText += `\n\n<git_working_state>\n${workingState}\n</git_working_state>`
			} catch (error) {
				// 将获取工作目录Git状态信息时的错误信息以特定的标签格式追加到解析后的文本中
				parsedText += `\n\n<git_working_state>\nError fetching working state: ${error.message}\n</git_working_state>`
			}
		}
		// 如果提及内容是一个7到40位的十六进制字符串，可能是Git提交哈希值
		else if (/^[a-f0-9]{7,40}$/.test(mention)) {
			try {
				// 获取指定Git提交的详细信息
				const commitInfo = await getCommitInfo(mention, cwd)
				// 将Git提交信息以特定的标签格式追加到解析后的文本中
				parsedText += `\n\n<git_commit hash="${mention}">\n${commitInfo}\n</git_commit>`
			} catch (error) {
				// 将获取Git提交信息时的错误信息以特定的标签格式追加到解析后的文本中
				parsedText += `\n\n<git_commit hash="${mention}">\nError fetching commit info: ${error.message}\n</git_commit>`
			}
		}

		// 如果提及内容是 "reuse"
		else if (mention.startsWith("reuse")) {
			// 使用正则表达式从mention中提取GitHub仓库URL
			const urlMatch = mention.match(/https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+/)
			if (!urlMatch) {
				console.error("No valid GitHub repository URL found in reuse mention")
				return `Invalid reuse mention: No GitHub repository URL found`
			}

			const url = urlMatch[0]
			console.log(`Reuse Test: ${url}`)

			try {
				const summary = await getSummaryFromRepoUrl(url)
				parsedText += `\n\n<repo_summary>\n${summary}\n</repo_summary>`
			} catch (error) {
				parsedText += `\n\n<repo_summary>\nError fetching summary: ${error.message}\n</repo_summary>`
			}
		}
		// 如果提及内容是 "reuse:"
		// else if (mention.startsWith("reuse:")) {
		// 	const url = mention.slice(6)
		// 	console.log(`Reuse Test: ${url}`)
		
		// 	try {
		// 		const summary = await getSummaryFromRepoUrl(url)
		// 		parsedText += `\n\n<repo_summary>\n${summary}\n</repo_summary>`
		// 	} catch (error) {
		// 		parsedText += `\n\n<repo_summary>\nError fetching summary: ${error.message}\n</repo_summary>`
		// 	}
		// }
	}

	// 如果存在URL提及内容
	if (urlMention) {
		try {
			// 关闭浏览器，释放资源
			await urlContentFetcher.closeBrowser()
		} catch (error) {
			// 捕获关闭浏览器时的错误，并在控制台输出错误信息
			console.error(`Error closing browser: ${error.message}`)
		}
	}

	// 返回解析后的文本，包含原始文本和提及内容的详细信息
	return parsedText
}

async function getFileOrFolderContent(mentionPath: string, cwd: string): Promise<string> {
	const absPath = path.resolve(cwd, mentionPath)

	try {
		const stats = await fs.stat(absPath)

		if (stats.isFile()) {
			const isBinary = await isBinaryFile(absPath).catch(() => false)
			if (isBinary) {
				return "(Binary file, unable to display content)"
			}
			const content = await extractTextFromFile(absPath)
			return content
		} else if (stats.isDirectory()) {
			const entries = await fs.readdir(absPath, { withFileTypes: true })
			let folderContent = ""
			const fileContentPromises: Promise<string | undefined>[] = []
			entries.forEach((entry, index) => {
				const isLast = index === entries.length - 1
				const linePrefix = isLast ? "└── " : "├── "
				if (entry.isFile()) {
					folderContent += `${linePrefix}${entry.name}\n`
					const filePath = path.join(mentionPath, entry.name)
					const absoluteFilePath = path.resolve(absPath, entry.name)
					// const relativeFilePath = path.relative(cwd, absoluteFilePath);
					fileContentPromises.push(
						(async () => {
							try {
								const isBinary = await isBinaryFile(absoluteFilePath).catch(() => false)
								if (isBinary) {
									return undefined
								}
								const content = await extractTextFromFile(absoluteFilePath)
								return `<file_content path="${filePath.toPosix()}">\n${content}\n</file_content>`
							} catch (error) {
								return undefined
							}
						})(),
					)
				} else if (entry.isDirectory()) {
					folderContent += `${linePrefix}${entry.name}/\n`
					// not recursively getting folder contents
				} else {
					folderContent += `${linePrefix}${entry.name}\n`
				}
			})
			const fileContents = (await Promise.all(fileContentPromises)).filter((content) => content)
			return `${folderContent}\n${fileContents.join("\n\n")}`.trim()
		} else {
			return `(Failed to read contents of ${mentionPath})`
		}
	} catch (error) {
		throw new Error(`Failed to access path "${mentionPath}": ${error.message}`)
	}
}

function getWorkspaceProblems(cwd: string): string {
	const diagnostics = vscode.languages.getDiagnostics()
	const result = diagnosticsToProblemsString(
		diagnostics,
		[vscode.DiagnosticSeverity.Error, vscode.DiagnosticSeverity.Warning],
		cwd,
	)
	if (!result) {
		return "No errors or warnings detected."
	}
	return result
}

async function getSummaryFromRepoUrl(url: string): Promise<string> {
	try {
		const summary = await axios.post("https://example.com/", { url })
		return summary.data
	} catch (error) {
		console.error(`Error fetching summary for repo at ${url}: ${error.message}`)
		return `复用组：Summary for repo at ${url}
博客系统
├── 用户管理
│   ├── 修改账户信息 [1]
├── 博客管理
│   ├── 博客列表查询 [2]
│   ├── 获取博客详情 [6]
│   ├── 删除博客 [3]
│   ├── 更新博客可见性 [5]
├── 分类与标签管理
│   ├── 获取分类和标签 [4]
├── 评论管理
│   ├── 分页查询评论 [7]
│   ├── 更新评论公开状态 [8]
│   ├── 删除评论 [9]
│   ├── 修改评论 [10]
├── 友链管理
│   ├── 获取友链列表 [11]
│   ├── 更新友链公开状态 [12]
│   ├── 添加友链 [13]
├── 动态管理
│   ├── 获取动态列表 [14]
│   ├── 更新动态公开状态 [15]
├── 访客管理
│   ├── 获取访客列表 [16]
│   ├── 删除访客 [17]`
	}
}
