import { initializeApp } from "firebase/app"
import { Auth, User, getAuth, onAuthStateChanged, signInWithCustomToken, signOut } from "firebase/auth"
import * as vscode from "vscode"
import { ClineProvider } from "../../core/webview/ClineProvider"
// Cline 将 Firebase 配置对象放在了 config.ts 文件
import { firebaseConfig } from "./config"

export interface UserInfo {
	displayName: string | null
	email: string | null
	photoURL: string | null
}

/**
 * Cline 基于 Firebase npm 包 实现的身份验证管理器。
 * Firebase 是由 Google 开发的全面的后端服务平台，提供了一系列云计算服务。
 * @docs https://firebase.google.com/docs/web/setup?hl=zh-cn
 * @docs firebase/auth 官网文档 https://firebase.google.com/docs/reference/js/auth.md?hl=zh-cn
 */
export class FirebaseAuthManager {
	private providerRef: WeakRef<ClineProvider>
	private auth: Auth
	private disposables: vscode.Disposable[] = []

	constructor(provider: ClineProvider) {
		console.log("Initializing FirebaseAuthManager", { provider })
		this.providerRef = new WeakRef(provider)
		// 初始化 Firebase 并创建一个 FirebaseApp 应用对象
		const app = initializeApp(firebaseConfig)
		// 返回与提供的 FirebaseApp 关联的 Auth 实例。
		this.auth = getAuth(app)
		console.log("Firebase app initialized", { appConfig: firebaseConfig })

		// Auth state listener
		// 为用户登录状态的变化添加观察器，当用户登录或退出时触发回调函数。
		onAuthStateChanged(this.auth, this.handleAuthStateChange.bind(this))
		console.log("Auth state change listener added")

		// Try to restore session
		this.restoreSession()
	}

	/**
	 * 恢复会话。
	 * 如果之前存在 Cline 存储的 token，则尝试使用该 token 登录到 Firebase。
	 * 如果登录失败，则清除 token 和 用户信息。
	 */
	private async restoreSession() {
		console.log("Attempting to restore session")
		const provider = this.providerRef.deref()
		if (!provider) {
			console.log("Provider reference lost during session restore")
			return
		}

		const storedToken = await provider.getSecret("authToken")
		if (storedToken) {
			console.log("Found stored auth token, attempting to restore session")
			try {
				await this.signInWithCustomToken(storedToken)
				console.log("Session restored successfully")
			} catch (error) {
				console.error("Failed to restore session, clearing token:", error)
				await provider.setAuthToken(undefined)
				await provider.setUserInfo(undefined)
			}
		} else {
			console.log("No stored auth token found")
		}
	}

	/**
	 * Cline 定义的 用户登录或退出时触发的 回调函数
	 * 1. 根据用户是否登录，设置或者清除 Token 和 用户信息
	 *    - 如果用户已登录，则将 Token 和 用户信息 存储在 provider 中
	 *    - 如果用户已退出，则清除 Token 和 用户信息
	 * 2. 更新 Webview 的状态
	 * @param user 登陆状态发生改变的用户（当前用户），如果用户已退出，则为 null。
	 */
	private async handleAuthStateChange(user: User | null) {
		console.log("Auth state changed", { user })
		const provider = this.providerRef.deref()
		if (!provider) {
			console.log("Provider reference lost")
			return
		}

		if (user) {
			console.log("User signed in", { userId: user.uid })
			const idToken = await user.getIdToken()
			await provider.setAuthToken(idToken)
			// Store public user info in state
			await provider.setUserInfo({
				displayName: user.displayName,
				email: user.email,
				photoURL: user.photoURL,
			})
			console.log("User info set in provider", { user })
		} else {
			console.log("User signed out")
			await provider.setAuthToken(undefined)
			await provider.setUserInfo(undefined)
		}
		// 更新 Webview 的状态
		await provider.postStateToWebview()
		console.log("Webview state updated")
	}

	async signInWithCustomToken(token: string) {
		console.log("Signing in with custom token", { token })
		await signInWithCustomToken(this.auth, token)
	}

	async signOut() {
		console.log("Signing out")
		await signOut(this.auth)
	}

	dispose() {
		this.disposables.forEach((d) => d.dispose())
		console.log("Disposables disposed", { count: this.disposables.length })
	}
}
