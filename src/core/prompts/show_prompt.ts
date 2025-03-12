import fs from "fs"
import path from "path"
import { Message } from "ollama"
import { ApiStream } from "../../api/transform/stream"
import {globalStoragePath} from "../Cline"

let interactionCount = 0
let currentLogFile = ""

export function logMessages(messages: Message[]) {
    interactionCount++
    
    // If this is the first interaction, create a new log file
    if (interactionCount === 1) {
        const now = new Date()
        const formattedTime = now.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        }).replace(/[\/:]/g, '-')
        
        // Create log directory if it doesn't exist
        const logDir = path.join(globalStoragePath, 'log')
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true })
        }
        
        currentLogFile = path.join(logDir, `${formattedTime}.md`)
        console.log(`Logging interactions to ${currentLogFile}`)
        fs.writeFileSync(currentLogFile, `# Interaction ${interactionCount}\n\n## Input\n\`\`\`json\n${JSON.stringify(messages, null, 2)}\n\`\`\`\n`)
    } else {
        // Append to existing file
        fs.appendFileSync(currentLogFile, `\n# Interaction ${interactionCount}\n\n## Input\n\`\`\`json\n${JSON.stringify(messages, null, 2)}\n\`\`\`\n`)
    }
}

export async function logStreamOutput(stream: ApiStream) {
    // Create a buffer to store the complete output
    let outputBuffer = ""

    // Process each chunk from the stream
    for await (const chunk of stream) {
        if (chunk.type === "text") {
            outputBuffer += chunk.text
        }
    }

    // Append the complete output to the log file
    fs.appendFileSync(currentLogFile, `\n## Output\n\`\`\`\n${outputBuffer}\n\`\`\`\n`)

    // Return the original stream
    return stream
}
