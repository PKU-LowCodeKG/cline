/**
 * "fs/promises" 是 TypeScript 的 fs 模块，和 Node.js 中的 fs 相近
 * @docs API 文档：https://nodejs.cn/api/fs.html#fsaccesspath-mode-callback
 */
import fs from "fs/promises"
import * as path from "path"

/**
 * NOTE: 异步为给定文件路径 创建所有不存在的子目录，并将它们收集到一个数组中以供以后删除。
 *
 * Asynchronously creates all non-existing subdirectories for a given file path
 * and collects them in an array for later deletion.
 *
 * @param filePath - The full path to a file.
 * @returns A promise that resolves to an array of newly created directories.
 */
export async function createDirectoriesForFile(filePath: string): Promise<string[]> {
	const newDirectories: string[] = []
	const normalizedFilePath = path.normalize(filePath) // Normalize path for cross-platform compatibility
	const directoryPath = path.dirname(normalizedFilePath)

	let currentPath = directoryPath
	const dirsToCreate: string[] = []

	// Traverse up the directory tree and collect missing directories
	while (!(await fileExistsAtPath(currentPath))) {
		dirsToCreate.push(currentPath)
		currentPath = path.dirname(currentPath)
	}

	// Create directories from the topmost missing one down to the target directory
	for (let i = dirsToCreate.length - 1; i >= 0; i--) {
		await fs.mkdir(dirsToCreate[i])
		newDirectories.push(dirsToCreate[i])
	}

	return newDirectories
}

/**
 * NOTE: Cline 用 fs 检查路径是否存在。
 *
 * Helper function to check if a path exists.
 *
 * @param path - The path to check.
 * @returns A promise that resolves to true if the path exists, false otherwise.
 */
export async function fileExistsAtPath(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath)
		return true
	} catch {
		return false
	}
}

/**
 * Checks if the path is a directory
 * @param filePath - The path to check.
 * @returns A promise that resolves to true if the path is a directory, false otherwise.
 */
export async function isDirectory(filePath: string): Promise<boolean> {
	try {
		const stats = await fs.stat(filePath)
		return stats.isDirectory()
	} catch {
		return false
	}
}

/**
 * Gets the size of a file in kilobytes
 * @param filePath - Path to the file to check
 * @returns Promise<number> - Size of the file in KB, or 0 if file doesn't exist
 */
export async function getFileSizeInKB(filePath: string): Promise<number> {
	try {
		const stats = await fs.stat(filePath)
		const fileSizeInKB = stats.size / 1000 // Convert bytes to KB (decimal) - matches OS file size display
		return fileSizeInKB
	} catch {
		return 0
	}
}

/**
 * Recursively reads a directory and returns an array of absolute file paths.
 *
 * @param directoryPath - The path to the directory to read.
 * @returns A promise that resolves to an array of absolute file paths.
 * @throws Error if the directory cannot be read.
 */
export const readDirectory = async (directoryPath: string) => {
	try {
		const filePaths = await fs
			.readdir(directoryPath, { withFileTypes: true, recursive: true })
			.then((files) => files.filter((file) => file.isFile()))
			.then((files) => files.map((file) => path.resolve(file.parentPath, file.name)))
		return filePaths
	} catch {
		throw new Error(`Error reading directory at ${directoryPath}`)
	}
}
