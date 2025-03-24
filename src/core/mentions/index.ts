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
import { Cline } from "../Cline"

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
 * 【主线】解析 用户输入/生成的 文本中的 mentions（@），并将 mentions（@）的详细信息追加到解析后的文本中。
 *
 * Cline 中的 mentions 被定义为以 "@" 开头的字符串，代表 Cline 提供的辅助功能，如：解析 URL、提供文件路径等
 * @param text 包含 mentions 的原始文本。
 * @param cwd 当前工作目录的路径。
 * @param urlContentFetcher 用于从 URL 获取内容并转换为 Markdown 的工具实例。
 * @returns 解析后的文本，包含原始文本和提及内容的详细信息。
 */
export async function parseMentions(
	text: string,
	cwd: string,
	urlContentFetcher: UrlContentFetcher,
	_cline: Cline,
): Promise<string> {
	// 创建一个Set来存储文本中出现的所有 mentions（@）
	const mentions: Set<string> = new Set()

	// 使用正则表达式匹配并替换 "@" 内容，进而让 "@" 内容不被重复匹配。这是必要的，因为 userContent 的内容大多数时候在增量更新而非覆盖，之前解析过的 "@" 内容不应重复解析
	// NOTE: 这里的 match 是完整的正则匹配结果，mention 是正则中的第一个捕获组（只有 "@" 后面的关键词）
	// 尽管 replace 方法只替换一次，但由于 mentionRegexGlobal 使用了全局标志 "g"，所以会匹配所有
	let parsedText = text.replace(mentionRegexGlobal, (match, mention) => {
		// 将匹配到的提及内容添加到Set中
		mentions.add(mention)

		// 如果提及内容是一个 URL（插件前端 @URL）
		if (mention.startsWith("http")) {
			return `'${mention}' (see below for site content)`
		}
		// 如果提及内容以 "/" 开头（插件前端 @Folder 或者 @File）
		else if (mention.startsWith("/")) {
			// 去除路径前面的斜杠
			const mentionPath = mention.slice(1)
			// 判断路径是否以斜杠结尾，区分是 文件夹 还是 文件
			return mentionPath.endsWith("/")
				? `'${mentionPath}' (see below for folder content)`
				: `'${mentionPath}' (see below for file content)`
		}
		// 如果提及内容是 "problems"（插件前端 @Problems）
		else if (mention === "problems") {
			return `Workspace Problems (see below for diagnostics)`
		}
		// 如果提及内容是 "terminal"
		else if (mention === "terminal") {
			return `Terminal Output (see below for output)`
		}
		// 如果提及内容是 "git-changes"
		else if (mention === "git-changes") {
			return `Working directory changes (see below for details)`
		}
		// 如果提及内容是一个7到40位的十六进制字符串，可能是Git提交哈希值
		else if (/^[a-f0-9]{7,40}$/.test(mention)) {
			return `Git commit '${mention}' (see below for commit info)`
		} else if (mention.startsWith("repoCrawler")) {
			return `搜索和用户描述相关的可复用仓库`
		}
		// 如果都不匹配，则返回原始匹配内容
		return match
	})

	// 从提及内容的Set中查找第一个以 "http" 开头的URL
	const urlMention = Array.from(mentions).find((mention) => mention.startsWith("http"))
	/** 用于存储启动浏览器时可能出现的错误 */
	let launchBrowserError: Error | undefined

	// 如果存在URL提及内容
	if (urlMention) {
		try {
			// 启动浏览器，以便后续获取URL的内容
			await urlContentFetcher.launchBrowser()
		} catch (error) {
			launchBrowserError = error as Error
			vscode.window.showErrorMessage(`Error fetching content for ${urlMention}: ${error.message}`)
		}
	}

	// Filter out duplicate mentions while preserving order
	const uniqueMentions = Array.from(new Set(mentions))

	// 遍历所有的 mention，为每个 mention 补充一些详细信息
	for (const mention of uniqueMentions) {
		// 如果提及内容是一个 URL（插件前端 @URL）
		if (mention.startsWith("http")) {
			let result: string
			// 如果启动浏览器时出现错误
			if (launchBrowserError) {
				result = `Error fetching content: ${launchBrowserError.message}`
			} else {
				try {
					const markdown = await urlContentFetcher.urlToMarkdown(mention)
					result = markdown
				} catch (error) {
					vscode.window.showErrorMessage(`Error fetching content for ${mention}: ${error.message}`)
					result = `Error fetching content: ${error.message}`
				}
			}
			parsedText += `\n\n<url_content url="${mention}">\n${result}\n</url_content>`
		}
		// 如果提及内容以 "/" 开头（插件前端 @Folder 或者 @File）
		else if (mention.startsWith("/")) {
			// 去除路径前面的斜杠
			const mentionPath = mention.slice(1)
			try {
				// 获取文件或文件夹的内容
				const content = await getFileOrFolderContent(mentionPath, cwd)
				// 以 "/" 结尾的路径表示文件夹，否则表示文件
				if (mention.endsWith("/")) {
					parsedText += `\n\n<folder_content path="${mentionPath}">\n${content}\n</folder_content>`
				} else {
					parsedText += `\n\n<file_content path="${mentionPath}">\n${content}\n</file_content>`
				}
			} catch (error) {
				if (mention.endsWith("/")) {
					parsedText += `\n\n<folder_content path="${mentionPath}">\nError fetching content: ${error.message}\n</folder_content>`
				} else {
					parsedText += `\n\n<file_content path="${mentionPath}">\nError fetching content: ${error.message}\n</file_content>`
				}
			}
		}
		// 如果提及内容是 "problems"（插件前端 @Problems）
		else if (mention === "problems") {
			try {
				const problems = getWorkspaceProblems(cwd)
				parsedText += `\n\n<workspace_diagnostics>\n${problems}\n</workspace_diagnostics>`
			} catch (error) {
				parsedText += `\n\n<workspace_diagnostics>\nError fetching diagnostics: ${error.message}\n</workspace_diagnostics>`
			}
		}
		// 如果提及内容是 "terminal"
		else if (mention === "terminal") {
			try {
				const terminalOutput = await getLatestTerminalOutput()
				parsedText += `\n\n<terminal_output>\n${terminalOutput}\n</terminal_output>`
			} catch (error) {
				parsedText += `\n\n<terminal_output>\nError fetching terminal output: ${error.message}\n</terminal_output>`
			}
		}
		// 如果提及内容是 "git-changes"
		else if (mention === "git-changes") {
			try {
				const workingState = await getWorkingState(cwd)
				parsedText += `\n\n<git_working_state>\n${workingState}\n</git_working_state>`
			} catch (error) {
				parsedText += `\n\n<git_working_state>\nError fetching working state: ${error.message}\n</git_working_state>`
			}
		}
		// 如果提及内容是一个7到40位的十六进制字符串，可能是Git提交哈希值
		else if (/^[a-f0-9]{7,40}$/.test(mention)) {
			try {
				const commitInfo = await getCommitInfo(mention, cwd)
				parsedText += `\n\n<git_commit hash="${mention}">\n${commitInfo}\n</git_commit>`
			} catch (error) {
				parsedText += `\n\n<git_commit hash="${mention}">\nError fetching commit info: ${error.message}\n</git_commit>`
			}
		}

		// 如果提及内容是 "repoCrawler"
		else if (mention.startsWith("repoCrawler")) {
			// 使用正则表达式从mention中提取 用户希望爬虫检索的需求
			const req = mention.slice(11)
			console.log("用户原始需求：", req)
			try {
				if (req) {
					const { repositories, url, _text, _images } = await handleRepoSearchAgent(req, _cline)
					if (repositories.length > 0) {
						// 1. 替换原有的任务，要求 Cline 下载用户选择的仓库
						let newTask = `<task>\n${_text}。请使用 git clone 命令下载这个仓库，并使用 code 命令，在当前 VS Code 工作区中打开这个仓库\n</task>`
						let _newTask = parsedText.replace(/<task>[\s\S]*<\/task>/, newTask)
						parsedText = _newTask

						// 2. 加上 URL 信息
						parsedText += "\n\n" + url
						console.log("新任务：", parsedText)
					} else {
						await _cline.say("text", "未找到合适的仓库")
					}
				}
			} catch (error) {
				console.error("搜索GitHub仓库失败:", error)
			}
		}
	}

	// 如果存在URL提及内容
	if (urlMention) {
		try {
			// 关闭浏览器，释放资源
			await urlContentFetcher.closeBrowser()
		} catch (error) {
			console.error(`Error closing browser: ${error.message}`)
		}
	}

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

// #region 仓库搜索相关
interface RepoInfo {
	clone_url: string
	full_name: string
	html_url: string
	readme: string
	recommendations: string[]
	risks: string[]
	score: number
	ssh_url: string
	strengths: string[]
	url: string
}

const handleRepoSearchAgent = async (req: string, _cline: Cline) => {
	let repositories: string | any[] = []
	let url: string = ""
	let _text: string = ""
	let _images: string[] = []
	try {
		const controller = new AbortController()
		const signal = controller.signal

		const response = await fetch("http://localhost:5000/get_url_stream", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ query: req || "React应用" }),
			signal,
		})

		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`)
		}

		// 处理SSE流
		const reader = response.body?.getReader()
		const decoder = new TextDecoder()

		if (reader) {
			try {
				while (true) {
					const { done, value } = await reader.read()
					if (done) {
						break
					}

					const text = decoder.decode(value, { stream: true })
					const lines = text.split("\n\n")

					for (const line of lines) {
						if (line.startsWith("data: ")) {
							const { step, data } = JSON.parse(line.slice(6))
							// 根据不同步骤展示不同的信息
							switch (step) {
								case "initial_requirements":
									await _cline.say("checkpoint_created")
									await _cline.say("text", `正在分析您的需求: "${data}"...`)
									break
								case "refined_requirements":
									await _cline.say("checkpoint_created")
									await _cline.say("text", `我理解您的核心需求是: "${data}"`)
									break
								case "search_keywords":
									await _cline.say("checkpoint_created")
									await _cline.say("text", `使用以下关键词搜索: ${data.join(", ")}`)
									break
								case "initial_repositories":
									await _cline.say("checkpoint_created")
									await _cline.say("text", `初步找到 ${data} 个相关仓库，正在筛选...`)
									break
								case "unique_repositories":
									await _cline.say("checkpoint_created")
									await _cline.say("text", `去重后剩余 ${data} 个仓库`)
									break
								case "recalled_repositories":
									await _cline.say("checkpoint_created")
									await _cline.say("text", `筛选出最相关的 ${data.length} 个仓库，正在评估仓库1/3...`)
									break
								case "evaluation_progress":
									await _cline.say("checkpoint_created")

									const { index, total, current }: { index: number; total: number; current: RepoInfo } = data
									url += current.html_url + "\n\n"

									await _cline.say("text", `第${index}个仓库的评估结果是\n\n${buildRepoInfoString(current)}`)
									if (index !== 3) {
										await _cline.say("text", `正在评估仓库 (${index + 1}/${total})...`)
									}
									break
								case "final_result":
									await _cline.say("checkpoint_created")

									repositories = data

									await _cline.say("text", `评估完成！`)
									break
							}
						}
					}
				}
			} catch (error) {
				console.error("读取流时出错:", error)
				controller.abort()
				throw error
			}
		}

		if (repositories.length <= 0) {
			throw new Error("未找到合适的仓库")
		}

		// 这里再提问一下用户，让用户选择一个项目进行复用
		const { text, images } = await _cline.ask(
			"followup",
			"检索到的项目已经展示结束，请您选择一个项目进行复用。在您选择后，我们会自动下载项目",
		)
		await _cline.say("user_feedback", text ?? "", images)

		_text = text ?? ""
		_images = images ?? []
	} catch (error) {
		console.error("搜索GitHub仓库失败:", error)
		await _cline.say("text", "搜索GitHub仓库失败")
	}
	return { repositories, url, _text, _images }
}

const buildRepoInfoString = (repo: RepoInfo): string => {
	let repoInfoString = `
项目名称：${repo.full_name}
仓库地址：${repo.html_url}
推荐评分：${repo.score}
优势：${repo.strengths.join("、")}
风险：${repo.risks.join("、")}
总体建议：${repo.recommendations.join("、")}

下面是该项目的详细描述：
${repo.readme.slice(12, -3)}

---
`
	return repoInfoString
}
// #endregion
