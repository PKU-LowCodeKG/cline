import * as vscode from "vscode"
import * as fs from "fs/promises"
import * as path from "path"
// 从puppeteer-core库中导入Browser、Page和launch，用于控制浏览器进行网页操作
import { Browser, Page, launch } from "puppeteer-core"
// 导入cheerio库，用于在Node.js环境中解析和操作HTML，类似于在浏览器中使用jQuery
import * as cheerio from "cheerio"
// 导入TurndownService，用于将HTML转换为Markdown格式
import TurndownService from "turndown"
// @ts-ignore 注释用于忽略TypeScript编译器的类型检查错误，因为这里的模块可能没有类型定义文件
import PCR from "puppeteer-chromium-resolver"
import { fileExistsAtPath } from "@utils/fs"

/** Cline 定义接口，用于描述 puppeteer-chromium-resolver 返回的统计信息结构 */
interface PCRStats {
	/** puppeteer对象，包含launch方法，用于启动浏览器 */
	puppeteer: { launch: typeof launch }
	/** 检测到（或者下载好）的 浏览器可执行文件 的路径 */
	executablePath: string
}

/**
 * Cline 实例的工具类之一，用于 **从指定 URL 获取网页内容并转换为 Markdown 格式**。
 *
 * 在 Cline 实例的构造函数中，会初始化一个 UrlContentFetcher 实例作为 Cline 实例的属性。
 * @docs puppeteer-core库（提供 API 控制 Chrome 或 Firefox 进行网页操作） https://www.npmjs.com/package/puppeteer-core
 * @docs cheerio库（在浏览器端和服务器端均可以 解析和操作 HTML） https://www.npmjs.com/package/cheerio
 * @docs puppeteer-chromium-resolver库（检测并下载 Chromium） https://www.npmjs.com/package/puppeteer-chromium-resolver
 */
export class UrlContentFetcher {
	// 存储VS Code扩展的上下文信息，包含全局存储路径等信息
	private context: vscode.ExtensionContext
	// 存储浏览器实例，用于控制浏览器进行网页操作
	private browser?: Browser
	// 存储浏览器页面实例，用于在浏览器中打开网页并操作
	private page?: Page

	// 构造函数，接收VS Code扩展的上下文信息作为参数
	constructor(context: vscode.ExtensionContext) {
		this.context = context
	}

	/**
	 * 确保 Chromium 浏览器存在，如果不存在则下载到 `[context.globalStorageUri.fsPath]/puppeteer` 目录下。
	 *
	 * 官方文档中，默认的 Chromium 下载路径是家目录，默认快照是 ".chromium-browser-snapshots"。这里 cline 并没有修改相关设置。
	 * @returns 返回 `Promise<PCRStats>`，包含 puppeteer 对象和 Chromium 可执行文件的路径。
	 */
	private async ensureChromiumExists(): Promise<PCRStats> {
		const globalStoragePath = this.context?.globalStorageUri?.fsPath
		if (!globalStoragePath) {
			throw new Error("Global storage uri is invalid")
		}
		// `[context.globalStorageUri.fsPath]/puppeteer` 目录
		const puppeteerDir = path.join(globalStoragePath, "puppeteer")
		const dirExists = await fileExistsAtPath(puppeteerDir)
		if (!dirExists) {
			await fs.mkdir(puppeteerDir, { recursive: true })
		}
		// 使用 puppeteer-chromium-resolver 检查 Chromium 是否存在
		// 如果存在，则返回现有 Chromium 的路径；如果不存在，则下载到指定目录并返回路径
		const stats: PCRStats = await PCR({
			downloadPath: puppeteerDir,
		})
		return stats
	}

	/**
	 * 启动浏览器实例，并创建一个新的页面实例。初始化 UrlContentFetcher 的 browser 和 page 属性。
	 */
	async launchBrowser(): Promise<void> {
		// 如果浏览器实例已经存在，则直接返回
		if (this.browser) {
			return
		}
		// 确保 Chromium 浏览器存在，并获取相关统计信息
		const stats = await this.ensureChromiumExists()
		// 使用 puppeteer 的 launch 方法启动浏览器
		this.browser = await stats.puppeteer.launch({
			// 设置浏览器启动参数，这里设置了用户代理，模拟特定的浏览器版本
			args: [
				"--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
			],
			// 指定浏览器可执行文件的路径
			executablePath: stats.executablePath,
		})
		// 在最新版本的puppeteer中，headless模式不会自动添加到用户代理中
		// 在浏览器中创建一个新的页面实例
		this.page = await this.browser?.newPage()
	}

	/**
	 * 关闭浏览器实例，将 UrlContentFetcher 的 browser 和 page 置为 undefined，释放资源
	 */
	async closeBrowser(): Promise<void> {
		// 关闭浏览器实例
		await this.browser?.close()
		this.browser = undefined
		this.page = undefined
	}

	/**
	 * 将指定 URL 的网页内容转换为 Markdown 格式。
	 *
	 * 在 `parseMentions()` 中调用时，必须先调用 `launchBrowser()` 初始化浏览器和页面实例。
	 * @param url 指定的 URL 地址字符串
	 * @returns 返回的 Markdown 格式字符串
	 */
	async urlToMarkdown(url: string): Promise<string> {
		// 如果浏览器实例或页面实例未初始化，则抛出错误
		if (!this.browser || !this.page) {
			throw new Error("Browser not initialized")
		}

		// 在浏览器页面中打开指定URL，并设置超时时间和等待条件
		await this.page.goto(url, {
			timeout: 10_000, // 超时时间为10秒
			/**
			 * domcontentloaded 表示基本的 DOM 树已经加载完成
			 * networkidle2 表示等待直到至少 500 毫秒内网络连接不超过 2 个，类似于 Playwright 的 networkidle
			 * 对于大多数文档类网站，这样的设置应该足够了
			 */
			waitUntil: ["domcontentloaded", "networkidle2"], // 等待直到DOM加载完成且网络空闲
		})
		// 获取页面的HTML内容
		const content = await this.page.content()

		// 使用cheerio加载HTML内容，以便进行解析和清理
		const $ = cheerio.load(content)
		// 移除HTML中的脚本、样式、导航栏、页脚和页眉元素
		$("script, style, nav, footer, header").remove()

		// 创建TurndownService实例，用于将HTML转换为Markdown
		const turndownService = new TurndownService()
		// 将清理后的HTML内容转换为Markdown格式
		const markdown = turndownService.turndown($.html())

		return markdown
	}
}
