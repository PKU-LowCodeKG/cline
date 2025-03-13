import fs from "fs"
import path from "path"
import { Message } from "ollama"
import { ApiStream } from "../../api/transform/stream"
import { globalStoragePath } from "../Cline"

let interactionCount = 0
let currentLogFile = ""

export function logMessages(messages: Message[]) {
    interactionCount++

    const styles = `
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                line-height: 1.6;
                color: #333;
                max-width: 1200px;
                margin: 0 auto;
                padding: 20px;
                background: #f5f5f5;
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
                padding: 20px;
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
        </style>
    `

    const messages_html = messages.map(msg => `
        <h3>${msg.role}</h3>
        <div class="content">${msg.content.replace(/\n/g, '<br/>')}</div>
    `).join('\n')
    
    const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            ${styles}
        </head>
        <body>
            <h1>Interaction ${interactionCount}</h1>
            <h2>Input</h2>
            <div class="messages">
                ${messages_html}
            </div>
        </body>
        </html>
    `

    if (interactionCount === 1) {
        const now = new Date()
        const formattedTime = now.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        }).replace(/[\/:]/g, '-')

        const logDir = path.join(globalStoragePath, 'log')
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true })
        }

        currentLogFile = path.join(logDir, `${formattedTime}.html`)
        console.log(`Logging interactions to ${currentLogFile}`)
        fs.writeFileSync(currentLogFile, htmlContent)
    } else {
        fs.appendFileSync(currentLogFile, htmlContent)
    }
}

export async function logStreamOutput(stream: ApiStream) {
    let outputBuffer = ""

    for await (const chunk of stream) {
        if (chunk.type === "text") {
            outputBuffer += chunk.text
        }
    }

    fs.appendFileSync(currentLogFile, `
        <h2>Output</h2>
        <pre><code>${outputBuffer}</code></pre>
    `)

    return stream
}
