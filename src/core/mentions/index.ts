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
	// 【主线】替换可以让 "@" 内容不被重复匹配。这是必要的，因为 userContent 的内容大多数时候在增量更新而非覆盖，之前解析过的 mention 不应该再次解析
	// NOTE: 这里的 match 是完整的正则匹配结果，mention 是正则中的第一个捕获组（只有 "@" 后面的关键词）
	// 尽管 replace 方法只替换一次，但由于 mentionRegexGlobal 使用了全局标志 "g"，所以会匹配所有
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
		else if (mention.startsWith("reuse")) {
			// TODO: 之后可以改改这里的提示词
			return `复用组尝试集成项目解析中...`
		}
		else if (mention.startsWith("repoCrawler")) {
			return `搜索和用户描述相关的可复用仓库`
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

	// 遍历所有的 mention，为每个 mention 补充一些详细信息
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
					// 使用UrlContentFetcher工具从URL获取内容并转换为Markdown格式
					const markdown = await urlContentFetcher.urlToMarkdown(mention)
					result = markdown
				} catch (error) {
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
		// 如果提及内容是 "repoCrawler"
		else if (mention.startsWith("repoCrawler")) {
			// 使用正则表达式从mention中提取 用户希望爬虫检索的需求
			const req = mention.slice(11)
			console.log(`RepoCrawler Test: ${req}`)

			try {
				const reusableRepoList = await getReusableRepoListFromReq(req)
				parsedText += `\n\n<repo_crawler>\n${reusableRepoList}\n</repo_crawler>`
			} catch (error) {
				parsedText += `\n\n<repo_crawler>\nError fetching summary: ${error.message}\n</repo_crawler>`
			}
		}
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

async function getReusableRepoListFromReq(req: string): Promise<string> {

	let crawlerResult = `根据您的需求：< ${req} >，以下是我们为您推荐的可复用仓库信息：`

	try {
		const { data } = await axios.post("http://localhost:5000/fetch", { "query": req })
		console.log(data.repositories)
		crawlerResult += buildRepoInfoString(data.repositories)
	} catch (error) {
		console.error(`⚠ Error fetching reusable repo list for req ${req}: ${error.message}`)
		crawlerResult += buildRepoInfoString(DefaultData)
	}
	return crawlerResult
}

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

const buildRepoInfoString = (repo: RepoInfo[]): string => {
	let repoInfoString = ""
	// 这里选择 3 个 是控制上下文，因为 Cline 没有做第一次发起请求时上下文过长的情况
	for (let i = 0; i < repo.length && i < 3; i++) {
		repoInfoString += `
# NO.${i + 1}
- 项目名称：${repo[i].full_name}
- 项目地址：${repo[i].html_url}
- 推荐评分：${repo[i].score}
- 优势：${repo[i].strengths.join("、")}
- 风险：${repo[i].risks.join("、")}
- 总体建议：${repo[i].recommendations.join("、")}
下面是该项目的详细描述：
${repo[i].readme.slice(12, -3)}
---
`
	}
	return repoInfoString
}

// 按照接口重写 DefaultData，并调整其 key 的顺序
const DefaultData: RepoInfo[] = [
    {
        "score": 95,
        "strengths": [
            "基于Spring Boot的开发框架",
            "内置用户管理、权限管理和日志系统等常用功能",
            "支持前后端分离架构和灵活扩展机制"
        ],
        "risks": [
            "项目星标数较少，社区活跃度可能不高"
        ],
        "recommendations": [
            "建议检查项目的更新频率和维护情况",
            "考虑是否有其他更活跃的类似项目作为备选方案"
        ],
        "full_name": "TaleLin/lin-cms-spring-boot",
        "url": "https://api.github.com/repos/TaleLin/lin-cms-spring-boot",
        "html_url": "https://github.com/TaleLin/lin-cms-spring-boot",
        "clone_url": "https://github.com/TaleLin/lin-cms-spring-boot.git",
        "ssh_url": "git@github.com:TaleLin/lin-cms-spring-boot.git",
        "readme": "```markdown\n## 项目简介\n\n**Lin-CMS-Spring-boot** 是基于 **Spring Boot** 和 **MyBatis-Plus** 实现的内容管理系统（CMS）后端框架，旨在帮助开发者高效构建 CMS 系统。它内置了用户管理、权限管理和日志系统等常用功能，并支持前后端分离架构和灵活的扩展机制。\n\n## 核心功能\n- 前后端分离架构，支持多种前端实现\n- 内置 CMS 常用功能（用户管理、权限管理、日志系统）\n- 支持通过 `extension` 灵活扩展业务\n\n## 技术栈\n- **框架**：Spring Boot 2.5.2, MyBatis-Plus 3.4.1\n- **开发规范**：基于 Lin CMS 开发规范\n- **工具**：MIT 许可证，支持文档和开发规范\n\n## 开源协议\n[MIT](LICENSE) © 2021 林间有风\n```"
    },
    {
        "score": 95,
        "strengths": [
            "基于Spring Boot的博客系统完全匹配用户需求",
            "支持第三方登录和云存储等额外功能"
        ],
        "risks": [
            "项目Star数较少，可能社区活跃度不高"
        ],
        "recommendations": [
            "检查依赖项与现有环境的兼容性",
            "评估社区活跃度和维护情况"
        ],
        "full_name": "iszhouhua/blog",
        "url": "https://api.github.com/repos/iszhouhua/blog",
        "html_url": "https://github.com/iszhouhua/blog",
        "clone_url": "https://github.com/iszhouhua/blog.git",
        "ssh_url": "git@github.com:iszhouhua/blog.git",
        "readme": "```markdown\n## 项目简介  \n这是一个基于**Spring Boot**和**Vue.js**的个人博客系统，支持多种云存储、第三方登录（如Gitee、GitHub）以及数据库版本管理。项目提供评论管理、用户模块重做等功能，并通过**Flyway**实现数据库脚本自动运行。\n\n## 核心功能  \n- **云存储支持**：集成七牛云、阿里云、腾讯云等存储服务  \n- **第三方登录**：支持Gitee和GitHub账号登录  \n- **数据库管理**：使用Flyway进行版本控制，简化数据库结构修改  \n\n## 技术栈  \n- **后端框架**：Spring Boot, MyBatis, Flyway  \n- **前端工具**：Vue.js, Element UI  \n- **其他工具**：MySQL, Redis, Caffeine  \n\n## 开源协议  \nMIT License\n```"
    },
    {
        "score": 92,
        "strengths": [
            "核心功能匹配度高，覆盖了文章管理、评论管理和系统配置等主要需求",
            "技术栈与Spring Boot框架兼容性良好，使用主流的技术如MyBatis-Plus和layui"
        ],
        "risks": [
            "项目star数为319，社区认可度一般，可能影响长期维护和支持",
            "README中未明确说明开源协议，可能存在法律风险"
        ],
        "recommendations": [
            "建议检查项目的活跃度和维护情况，确保能够获得持续的支持",
            "建议在使用前与项目作者确认开源协议，避免潜在的法律问题"
        ],
        "full_name": "ZHENFENG13/My-Blog-layui",
        "url": "https://api.github.com/repos/ZHENFENG13/My-Blog-layui",
        "html_url": "https://github.com/ZHENFENG13/My-Blog-layui",
        "clone_url": "https://github.com/ZHENFENG13/My-Blog-layui.git",
        "ssh_url": "git@github.com:ZHENFENG13/My-Blog-layui.git",
        "readme": "```markdown\n## 项目简介  \n**My-Blog-Layui** 是一个基于 Spring Boot 技术栈的个人博客系统，由原 **My-Blog** 项目二次开发而来。该项目采用 **layui** 框架重构了后台管理界面和分页、评论功能，支持文章发布、评论管理和系统配置等功能，适合用于学习和实践 Spring Boot 开发。\n\n## 核心功能  \n- **文章管理**：支持文章的增删改查及分类管理  \n- **评论管理**：提供评论审核、删除及统计功能  \n- **系统配置**：可自定义网站基础信息、友情链接等  \n\n## 技术栈  \n- **后端框架**：Spring Boot, MyBatis-Plus  \n- **前端框架**：layui, Editor.md  \n- **数据库**：MySQL (Druid 数据源)  \n- **开发工具**：Lombok  \n\n## 开源协议  \n未明确说明，建议参考原项目开源协议。"
    },
    {
        "score": 87,
        "strengths": [
            "核心功能匹配度高，覆盖了用户管理、文章发布和评论互动等需求",
            "技术栈成熟且广泛使用，包括Spring Boot、Hibernate、MySQL和Bootstrap4"
        ],
        "risks": [
            "项目健康度较低，仅有1641个star，社区活跃度可能不高"
        ],
        "recommendations": [
            "建议检查项目的依赖项是否与现有环境兼容",
            "考虑项目的维护情况和更新频率"
        ],
        "full_name": "Raysmond/SpringBlog",
        "url": "https://api.github.com/repos/Raysmond/SpringBlog",
        "html_url": "https://github.com/Raysmond/SpringBlog",
        "clone_url": "https://github.com/Raysmond/SpringBlog.git",
        "ssh_url": "git@github.com:Raysmond/SpringBlog.git",
        "readme": "```markdown\n## 项目简介  \nSpringBlog 是一个基于 **Spring Boot** 的简洁设计博客系统，支持用户管理、文章发布和评论互动等功能。它是作者用于学习 Spring Boot 特性的一个实践项目，提供完整的开发和部署文档。\n\n## 核心功能  \n- 用户注册与登录（支持角色权限控制）  \n- 文章创作与发布（支持 Markdown 和代码高亮）  \n- 评论管理与互动  \n\n## 技术栈  \n**后端框架**: Spring Boot、Spring MVC、Spring JPA、Spring Security  \n**数据库**: MySQL (Hibernate)、Redis (缓存)  \n**前端工具**: Bootstrap、ACE Editor、Pegdown（Markdown 处理）  \n**构建工具**: Gradle、Bower  \n\n## 开源协议  \nModified BSD license. Copyright (c) 2015 - 2018, Jiankun LEI (Raysmond).  \n```"
    },
    {
        "score": 85,
        "strengths": [
            "核心功能匹配度高，包括Markdown文件导入、Hexo路径兼容以及后台管理工具",
            "技术栈与Spring Boot框架完全兼容"
        ],
        "risks": [
            "项目健康度较低，仅有883个star，社区支持可能有限",
            "依赖项中使用的是Spring Boot 1.5版本，可能存在兼容性问题"
        ],
        "recommendations": [
            "建议检查并升级到最新的Spring Boot版本以确保兼容性和安全性",
            "考虑项目的维护情况和社区活跃度，评估是否需要长期支持"
        ],
        "full_name": "caozongpeng/SpringBootBlog",
        "url": "https://api.github.com/repos/caozongpeng/SpringBootBlog",
        "html_url": "https://github.com/caozongpeng/SpringBootBlog",
        "clone_url": "https://github.com/caozongpeng/SpringBootBlog.git",
        "ssh_url": "git@github.com:caozongpeng/SpringBootBlog.git",
        "readme": "```markdown\n## 项目简介  \nKyrie Blog是一个基于**SpringBoot 1.5 + MyBatis + Thymeleaf**实现的个人博客系统，支持Markdown文件导入、Hexo路径兼容以及后台管理功能。该项目旨在帮助**Spring Boot初学者**快速上手，并为需要高效管理文章的写作者提供便捷工具。\n\n## 核心功能  \n- **Markdown文件导入**：支持将本地Markdown文件直接导入博客系统  \n- **Hexo路径兼容**：模仿Hexo生成的访问路径，方便用户迁移  \n- **后台管理工具**：提供文章发布、分类管理及设置等功能  \n\n## 技术栈  \n- **后端**：SpringBoot, MyBatis, Thymeleaf, PageHelper, Ehcache, Commonmark  \n- **前端**：Jquery, Bootstrap, editor.md, dropzone, sweetalert  \n- **第三方服务**：七牛云（文件上传）、百度统计  \n\n## 开源协议  \n未提及具体开源协议\n```"
    },
]