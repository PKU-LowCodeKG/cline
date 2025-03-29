import fs from "fs"
import path from "path"
import { Message } from "ollama"

let interactionCount = 0
let currentLogFile = ""

// 生成标题导航
const generateTOC = (messages: Message[]) => {
	const titles = []
	titles.push(`<li><a href="#interaction-${interactionCount}">Interaction ${interactionCount}</a></li>`)
	titles.push(`<li class="sub-nav"><a href="#input-${interactionCount}">Input</a></li>`)

	// 添加每个消息的角色到导航
	messages.forEach((msg, index) => {
		titles.push(`<li class="sub-nav-role">
            <a href="#role-${interactionCount}-${index}">${msg.role}</a>
        </li>`)
	})

	return titles.join("\n")
}

export function logMessages(messages: Message[], globalStoragePath: any) {
	interactionCount++

	// 添加新的CSS样式到styles中
	const styles = `
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                line-height: 1.6;
                color: #333;
                margin: 0;
                padding: 0;
                background: #f5f5f5;
                min-height: 100vh;
            }

            .sidebar {
                position: fixed;
                top: 0;
                left: 0;
                width: 200px;
                height: 90vh;
                background: white;
                padding: 20px;
                padding-bottom: 100px; /* Add extra padding at the bottom */
                box-shadow: 2px 0 5px rgba(0,0,0,0.1);
                overflow-y: auto;
            }

            .sidebar h2 {
                color: #2c3e50;
                margin-top: 0;
                padding-bottom: 10px;
                border-bottom: 2px solid #eee;
            }

            .sidebar ul {
                list-style: none;
                padding: 0;
                margin: 0;
            }

            .sidebar li {
                margin: 10px 0;
            }

            .sidebar a {
                color: #34495e;
                text-decoration: none;
                display: block;
                padding: 5px 0;
                transition: color 0.2s;
            }

            .sidebar a:hover {
                color: #16a085;
            }

            .main-content {
                margin-left: 250px;
                padding: 40px;
                max-width: 1200px;
            }

            h1 {
                color: #2c3e50;
                border-bottom: 2px solid #eee;
                padding-bottom: 10px;
                margin-bottom: 30px;
            }

            h2 {
                color: #34495e;
                margin-top: 25px;
            }

            h3 {
                color: #16a085;
                margin-bottom: 10px;
                text-transform: capitalize;
            }

            .messages {
                background: white;
                border-radius: 8px;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                padding: 40px;
                margin-bottom: 30px;
            }

            .content {
                background: #f8f9fa;
                border-left: 4px solid #16a085;
                padding: 15px;
                margin: 10px 0;
                white-space: pre-wrap;
                overflow-wrap: break-word;
            }

            pre {
                background: #2c3e50;
                color: #ecf0f1;
                padding: 15px;
                border-radius: 6px;
                overflow-x: auto;
                margin: 15px 0;
            }

            code {
                font-family: 'Fira Code', 'Consolas', monospace;
                font-size: 14px;
            }

            .sub-nav {
                padding-left: 15px;
            }

            .sub-nav-role {
                padding-left: 30px;
                font-size: 0.9em;
            }

            .sidebar ul li {
                margin: 5px 0;
            }

            .sidebar ul li a {
                padding: 3px 0;
            }
        </style>
    `

	const messages_html = messages
		.map(
			(msg, index) => `
        <h3 id="role-${interactionCount}-${index}">${msg.role}</h3>
        <div>${msg.content.replace(/\n/g, "<br/>")}</div>
    `,
		)
		.join("\n")

	const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            ${styles}
        </head>
        <body>
            <div class="sidebar">
                <h2>Navigation</h2>
                <ul>
                    ${generateTOC(messages)}
                </ul>
            </div>
            <div class="main-content">
                <div class="messages">
                    <h1 id="interaction-${interactionCount}">Interaction ${interactionCount}</h1>
                    <h2 id="input-${interactionCount}">Input</h2>
                    <div>
                        ${messages_html}
                    </div>
                </div>
            </div>
        </body>
        </html>
    `

	if (interactionCount === 1) {
		const now = new Date()
		const formattedTime = now
			.toLocaleString("zh-CN", {
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
			})
			.replace(/[\/:]/g, "-")

        // FIXME: globalStoragePath 可能为 undefined
		const logDir = path.join(globalStoragePath, "log")
		if (!fs.existsSync(logDir)) {
			fs.mkdirSync(logDir, { recursive: true })
		}

		currentLogFile = path.join(logDir, `${formattedTime}.html`)
		console.log(`Logging interactions to ${currentLogFile}`)
		fs.writeFileSync(currentLogFile, htmlContent)
	} else {
		// Read existing content
		const existingContent = fs.readFileSync(currentLogFile, "utf8")

		// Update navigation - replace everything between <ul> and </ul>
		const updatedContent = existingContent.replace(`</ul>`, `\n${generateTOC(messages)}\n</ul>`)

		// Add new interaction content before closing body tag
		const finalContent = updatedContent.replace(
			"</body>",
			`
            <div>
                <h1 id="interaction-${interactionCount}">Interaction ${interactionCount}</h1>
                <h2 id="input-${interactionCount}">Input</h2>
                <div>
                    ${messages_html}
                </div>
            </div>
        </body>`,
		)

		fs.writeFileSync(currentLogFile, finalContent)
	}
}

/**
 * Cline 在 recursivelyMakeClineRequests 中已经维护了 chunk.type 为 text 的 LLM 输出。直接把对应的字符串输出即可
 * @param outputBuffer
 */
export function logOutput(outputBuffer: string = "") {
    // Read existing content
    const existingContent = fs.readFileSync(currentLogFile, 'utf8')
    
    // Replace entire navigation content and add output section
    const updatedContent = existingContent
        .replace(
            /<\/ul>(?!.*<\/ul>)/,  // Matches last </ul>
            `\n<li class="sub-nav"><a href="#output-${interactionCount}">Output</a></li></ul>`
        )
        .replace(
            /<\/body>(?!.*<\/body>)/,  // Matches last </body>
            `
            <div>
                <h2 id="output-${interactionCount}">Output</h2>
                <pre><code>${outputBuffer}</code></pre>
            </div>
        </body>`,
		)

	fs.writeFileSync(currentLogFile, updatedContent)
}
