// 导入VS Code扩展API，用于与VS Code编辑器进行交互
import * as vscode from "vscode"
// 导入Node.js的fs/promises模块，用于进行文件系统的异步操作
import * as fs from "fs/promises"
// 导入Node.js的path模块，用于处理和转换文件路径
import * as path from "path"
// 从puppeteer-core库中导入Browser、Page和launch，用于控制浏览器进行网页操作
import { Browser, Page, launch } from "puppeteer-core"
// 导入cheerio库，用于在Node.js环境中解析和操作HTML，类似于在浏览器中使用jQuery
import * as cheerio from "cheerio"
// 导入TurndownService，用于将HTML转换为Markdown格式
import TurndownService from "turndown"
// @ts-ignore 注释用于忽略TypeScript编译器的类型检查错误，因为这里的模块可能没有类型定义文件
import PCR from "puppeteer-chromium-resolver"
// 从自定义的工具模块中导入fileExistsAtPath函数，用于检查文件是否存在
import { fileExistsAtPath } from "../../utils/fs"
// 为了执行git clone命令，导入Node.js的child_process模块
import { exec } from "child_process";

// 定义一个接口PCRStats，用于描述puppeteer-chromium-resolver返回的统计信息结构
interface PCRStats {
	// puppeteer对象，包含launch方法，用于启动浏览器
	puppeteer: { launch: typeof launch }
	// 浏览器可执行文件的路径
	executablePath: string
}

// 定义一个UrlContentFetcher类，用于从指定URL获取网页内容并转换为Markdown格式
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

	// 私有异步方法，用于确保Chromium浏览器存在，如果不存在则下载
	private async ensureChromiumExists(): Promise<PCRStats> {
		// 获取VS Code扩展的全局存储路径
		const globalStoragePath = this.context?.globalStorageUri?.fsPath
        // globalStoragePath: c:\Users\Administrator\AppData\Roaming\Code\User\globalStorage\saoudrizwan.claude-dev
		// 如果全局存储路径无效，则抛出错误
		if (!globalStoragePath) {
			throw new Error("Global storage uri is invalid")
		}
		// 拼接puppeteer存储目录的路径
		const puppeteerDir = path.join(globalStoragePath, "puppeteer")
		// 检查puppeteer存储目录是否存在
		const dirExists = await fileExistsAtPath(puppeteerDir)
		// 如果目录不存在，则创建该目录，递归创建子目录
		if (!dirExists) {
			await fs.mkdir(puppeteerDir, { recursive: true })
		}
		// 使用puppeteer-chromium-resolver检查Chromium是否存在
		// 如果不存在，会将其下载到path.join(puppeteerDir, ".chromium-browser-snapshots")路径下
		// 如果存在，则返回现有Chromium的路径
		const stats: PCRStats = await PCR({
			downloadPath: puppeteerDir,
		})
		return stats
	}

    async downloadFile(url: string, filePath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            exec(`git clone ${url} ${filePath}`, (error, stdout, stderr) => {
                if (error) {
                    console.error(`Error cloning repository: ${stderr}`);
                    reject(error);
                } else {
                    console.log(`Repository cloned successfully: ${stdout}`);
                    resolve();
                }
            });
        });
    }

	// 异步方法，用于启动浏览器实例
	async launchBrowser(): Promise<void> {
		// 如果浏览器实例已经存在，则直接返回
		if (this.browser) {
			return
		}
		// 调用ensureChromiumExists方法确保Chromium浏览器存在，并获取相关统计信息
		const stats = await this.ensureChromiumExists()
		// 使用puppeteer的launch方法启动浏览器
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

	// 异步方法，用于关闭浏览器实例
	async closeBrowser(): Promise<void> {
		// 关闭浏览器实例
		await this.browser?.close()
		// 将浏览器实例和页面实例置为undefined，释放资源
		this.browser = undefined
		this.page = undefined
	}

	// 异步方法，用于将指定URL的网页内容转换为Markdown格式
	// 调用此方法前必须先调用launchBrowser方法启动浏览器，使用完后调用closeBrowser方法关闭浏览器
	async urlToMarkdown(url: string): Promise<string> {
		// 如果浏览器实例或页面实例未初始化，则抛出错误
		if (!this.browser || !this.page) {
			throw new Error("Browser not initialized")
		}
		/*
        - networkidle2表示等待直到至少500毫秒内网络连接不超过2个，类似于Playwright的networkidle
        - domcontentloaded表示基本的DOM树已经加载完成
        对于大多数文档类网站，这样的设置应该足够了
        */
		// 在浏览器页面中打开指定URL，并设置超时时间和等待条件
		await this.page.goto(url, {
			timeout: 10_000, // 超时时间为10秒
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
