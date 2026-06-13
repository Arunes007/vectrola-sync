import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	requestUrl,
	TFile,
	Modal,
	TextComponent,
} from "obsidian";

// =============================================================================
// Constants
// =============================================================================

const GOOGLE_CLIENT_ID = "212647824656-9h9gchm0msibletsog338miabe9qtbe1.apps.googleusercontent.com";
const OAUTH_SERVER = "https://vectrola-oauth.up.railway.app";
const REDIRECT_URI = `${OAUTH_SERVER}/callback`;
const SCOPES = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file";

// =============================================================================
// Types
// =============================================================================

interface VectrolaSyncSettings {
	accessToken: string;
	refreshToken: string;
	tokenExpiry: number;
	userEmail: string;
	driveFolderPath: string;
	autoSyncOnOpen: boolean;
	syncIntervalMinutes: number;
	lastSyncTime: number;
	// Sync cache: maps relative path to md5 hash
	syncCache: Record<string, string>;
}

interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime: string;
	md5Checksum?: string;
	parents?: string[];
}

const DEFAULT_SETTINGS: VectrolaSyncSettings = {
	accessToken: "",
	refreshToken: "",
	tokenExpiry: 0,
	userEmail: "",
	driveFolderPath: "/Vectrola/wiki",
	autoSyncOnOpen: true,
	syncIntervalMinutes: 5,
	lastSyncTime: 0,
	syncCache: {},
};

// =============================================================================
// PKCE Helpers
// =============================================================================

function generateCodeVerifier(): string {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	return base64UrlEncode(array);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return base64UrlEncode(new Uint8Array(digest));
}

function generateRandomState(): string {
	const array = new Uint8Array(16);
	crypto.getRandomValues(array);
	return base64UrlEncode(array);
}

function base64UrlEncode(buffer: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < buffer.length; i++) {
		binary += String.fromCharCode(buffer[i]);
	}
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

// =============================================================================
// Main Plugin
// =============================================================================

// Public API interface for DataviewJS
interface VectrolaSyncAPI {
	fetchDriveFile: (fileId: string) => Promise<ArrayBuffer>;
	isAuthenticated: () => boolean;
}

export default class VectrolaSyncPlugin extends Plugin {
	settings: VectrolaSyncSettings;
	syncInterval: number | null = null;

	// Public API for DataviewJS access
	public api: VectrolaSyncAPI;

	async onload() {
		await this.loadSettings();

		// Expose API for DataviewJS (audio player)
		this.api = {
			fetchDriveFile: this.fetchDriveFile.bind(this),
			isAuthenticated: this.isAuthenticated.bind(this),
		};

		// Add ribbon icon
		this.addRibbonIcon("refresh-cw", "Sync with Vectrola", async () => {
			await this.syncFromDrive();
		});

		// Add commands
		this.addCommand({
			id: "vectrola-sync-pull",
			name: "Pull wiki from Google Drive",
			callback: async () => {
				await this.syncFromDrive();
			},
		});

		this.addCommand({
			id: "vectrola-sync-push",
			name: "Push wiki to Google Drive",
			callback: async () => {
				await this.syncToDrive();
			},
		});

		this.addCommand({
			id: "vectrola-auth",
			name: "Sign in with Google Drive",
			callback: async () => {
				await this.authenticate();
			},
		});

		this.addCommand({
			id: "vectrola-signout",
			name: "Sign out from Google Drive",
			callback: async () => {
				await this.signOut();
			},
		});

		// Add settings tab
		this.addSettingTab(new VectrolaSyncSettingTab(this.app, this));

		// Auto-sync on vault open
		if (this.settings.autoSyncOnOpen && this.isAuthenticated()) {
			// Delay to let Obsidian fully load
			setTimeout(() => this.syncFromDrive(), 3000);
		}

		// Set up periodic sync
		this.setupSyncInterval();
	}

	onunload() {
		if (this.syncInterval) {
			window.clearInterval(this.syncInterval);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	setupSyncInterval() {
		if (this.syncInterval) {
			window.clearInterval(this.syncInterval);
		}

		if (this.settings.syncIntervalMinutes > 0 && this.isAuthenticated()) {
			this.syncInterval = window.setInterval(
				() => this.syncFromDrive(),
				this.settings.syncIntervalMinutes * 60 * 1000
			);
		}
	}

	isAuthenticated(): boolean {
		return !!(this.settings.accessToken && this.settings.refreshToken);
	}

	// =========================================================================
	// OAuth Authentication (Server-side token exchange)
	// =========================================================================

	async authenticate() {
		// Generate PKCE verifier and challenge
		const codeVerifier = generateCodeVerifier();
		const codeChallenge = await generateCodeChallenge(codeVerifier);

		// Generate random state for CSRF protection
		const state = generateRandomState();

		// Step 1: Register auth session with server (stores verifier)
		try {
			await requestUrl({
				url: `${OAUTH_SERVER}/auth/start`,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ state, code_verifier: codeVerifier }),
			});
		} catch (error) {
			console.error("Failed to start auth session:", error);
			new Notice("Failed to connect to auth server. Please try again.");
			return;
		}

		// Step 2: Build OAuth URL
		let authUrl =
			`https://accounts.google.com/o/oauth2/v2/auth?` +
			`client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}` +
			`&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
			`&response_type=code` +
			`&scope=${encodeURIComponent(SCOPES)}` +
			`&access_type=offline` +
			`&prompt=consent` +
			`&code_challenge=${codeChallenge}` +
			`&code_challenge_method=S256` +
			`&state=${state}`;

		// Add login hint if we have previous email
		if (this.settings.userEmail) {
			authUrl += `&login_hint=${encodeURIComponent(this.settings.userEmail)}`;
		}

		// Step 3: Open in system browser
		try {
			const { shell } = require("electron");
			shell.openExternal(authUrl);
		} catch {
			window.open(authUrl);
		}

		// Step 4: Prompt user to enter the code from Railway callback
		const code = await this.promptForAuthCode();
		if (!code) {
			new Notice("Authentication cancelled.");
			return;
		}

		// Step 5: Exchange code for tokens via server (server has client_secret)
		try {
			const response = await requestUrl({
				url: `${OAUTH_SERVER}/auth/token`,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ code, state }),
			});

			const tokens = response.json;

			if (tokens.error) {
				throw new Error(tokens.error);
			}

			this.settings.accessToken = tokens.access_token;
			this.settings.refreshToken = tokens.refresh_token || this.settings.refreshToken;
			this.settings.tokenExpiry = Date.now() + tokens.expires_in * 1000;

			// Try to get user email for login_hint
			try {
				const userInfo = await this.getUserInfo(tokens.access_token);
				if (userInfo.email) {
					this.settings.userEmail = userInfo.email;
				}
			} catch {
				// Not critical, ignore
			}

			await this.saveSettings();

			new Notice("✅ Successfully connected to Google Drive!");
			this.setupSyncInterval();
		} catch (error) {
			console.error("Token exchange failed:", error);
			new Notice(`Authentication failed: ${error.message || "Please try again."}`);
		}
	}

	async promptForAuthCode(): Promise<string | null> {
		return new Promise((resolve) => {
			const modal = new AuthCodeModal(this.app, (code) => {
				resolve(code);
			});
			modal.open();
		});
	}

	async getUserInfo(accessToken: string): Promise<{ email?: string }> {
		const response = await requestUrl({
			url: "https://www.googleapis.com/oauth2/v2/userinfo",
			method: "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		});
		return response.json;
	}

	async refreshAccessToken(): Promise<boolean> {
		if (!this.settings.refreshToken) {
			return false;
		}

		try {
			// Use server for refresh (has client_secret)
			const response = await requestUrl({
				url: `${OAUTH_SERVER}/auth/refresh`,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ refresh_token: this.settings.refreshToken }),
			});

			const tokens = response.json;

			if (tokens.error) {
				throw new Error(tokens.error);
			}

			this.settings.accessToken = tokens.access_token;
			this.settings.tokenExpiry = Date.now() + tokens.expires_in * 1000;
			await this.saveSettings();
			return true;
		} catch (error) {
			console.error("Token refresh failed:", error);
			return false;
		}
	}

	async getValidAccessToken(): Promise<string | null> {
		// Refresh 1 minute before expiry
		if (Date.now() > this.settings.tokenExpiry - 60000) {
			const refreshed = await this.refreshAccessToken();
			if (!refreshed) {
				new Notice("Session expired. Please sign in again.");
				return null;
			}
		}
		return this.settings.accessToken;
	}

	async signOut() {
		this.settings.accessToken = "";
		this.settings.refreshToken = "";
		this.settings.tokenExpiry = 0;
		this.settings.userEmail = "";
		await this.saveSettings();

		if (this.syncInterval) {
			window.clearInterval(this.syncInterval);
			this.syncInterval = null;
		}

		new Notice("Signed out from Google Drive.");
	}

	// =========================================================================
	// Public API for DataviewJS (audio player)
	// =========================================================================

	/**
	 * Fetch a file from Google Drive by ID.
	 * Used by DataviewJS audio player to stream music files.
	 * Token is handled internally - never exposed to caller.
	 */
	async fetchDriveFile(fileId: string): Promise<ArrayBuffer> {
		const token = await this.getValidAccessToken();
		if (!token) {
			throw new Error("Not authenticated with Google Drive");
		}

		const response = await requestUrl({
			url: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
			},
		});

		return response.arrayBuffer;
	}

	// =========================================================================
	// Google Drive API
	// =========================================================================

	async driveRequest(
		endpoint: string,
		method: string = "GET",
		body?: string | ArrayBuffer,
		contentType?: string
	): Promise<any> {
		const token = await this.getValidAccessToken();
		if (!token) {
			throw new Error("Not authenticated");
		}

		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
		};
		if (contentType) {
			headers["Content-Type"] = contentType;
		}

		const response = await requestUrl({
			url: `https://www.googleapis.com/drive/v3/${endpoint}`,
			method,
			headers,
			body: body as string,
		});

		return response.json;
	}

	async findOrCreateFolder(path: string): Promise<string> {
		const parts = path.split("/").filter((p) => p);
		let parentId = "root";

		for (const part of parts) {
			// Search for existing folder
			const query = `name='${part}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
			const searchResult = await this.driveRequest(
				`files?q=${encodeURIComponent(query)}&fields=files(id,name)`
			);

			if (searchResult.files && searchResult.files.length > 0) {
				parentId = searchResult.files[0].id;
			} else {
				// Create folder
				const metadata = {
					name: part,
					mimeType: "application/vnd.google-apps.folder",
					parents: [parentId],
				};

				const created = await this.driveRequest(
					"files?fields=id",
					"POST",
					JSON.stringify(metadata),
					"application/json"
				);
				parentId = created.id;
			}
		}

		return parentId;
	}

	async listDriveFiles(folderId: string): Promise<DriveFile[]> {
		const files: DriveFile[] = [];
		let pageToken: string | undefined;

		do {
			const query = `'${folderId}' in parents and trashed=false`;
			let url = `files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,parents)`;
			if (pageToken) {
				url += `&pageToken=${pageToken}`;
			}

			const result = await this.driveRequest(url);
			if (result.files) {
				files.push(...result.files);
			}
			pageToken = result.nextPageToken;
		} while (pageToken);

		return files;
	}

	async downloadFile(fileId: string): Promise<string> {
		const token = await this.getValidAccessToken();
		if (!token) {
			throw new Error("Not authenticated");
		}

		const response = await requestUrl({
			url: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
			},
		});

		return response.text;
	}

	async uploadFile(
		name: string,
		content: string,
		parentId: string,
		existingFileId?: string
	): Promise<string> {
		const token = await this.getValidAccessToken();
		if (!token) {
			throw new Error("Not authenticated");
		}

		const metadata = {
			name,
			...(existingFileId ? {} : { parents: [parentId] }),
		};

		const boundary = "-------314159265358979323846";
		const delimiter = "\r\n--" + boundary + "\r\n";
		const closeDelim = "\r\n--" + boundary + "--";

		const body =
			delimiter +
			"Content-Type: application/json; charset=UTF-8\r\n\r\n" +
			JSON.stringify(metadata) +
			delimiter +
			"Content-Type: text/markdown\r\n\r\n" +
			content +
			closeDelim;

		const url = existingFileId
			? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart&fields=id`
			: `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`;

		const response = await requestUrl({
			url,
			method: existingFileId ? "PATCH" : "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": `multipart/related; boundary="${boundary}"`,
			},
			body,
		});

		return response.json.id;
	}

	// =========================================================================
	// Sync Operations
	// =========================================================================

	private syncStats = { processed: 0, downloaded: 0, skipped: 0, total: 0 };
	private syncCancelled = false;
	private isSyncing = false;
	private currentNotice: Notice | null = null;
	private noticeContent: {
		label: HTMLDivElement;
		progressFill: HTMLDivElement;
		progressText: HTMLDivElement;
	} | null = null;

	private showProgressNotice() {
		// If notice exists and is still in DOM, just return
		if (this.currentNotice && document.body.contains(this.currentNotice.noticeEl)) {
			return;
		}

		// Create new progress notice
		const noticeEl = document.createDocumentFragment();
		const container = noticeEl.createDiv({ cls: "vectrola-progress-container" });

		const headerRow = container.createDiv({ cls: "vectrola-progress-header" });
		const label = headerRow.createDiv({ cls: "vectrola-progress-label", text: "🔄 Syncing..." });
		const cancelBtn = headerRow.createEl("button", { cls: "vectrola-cancel-btn", text: "✕" });

		const progressBar = container.createDiv({ cls: "vectrola-progress-bar" });
		const progressFill = progressBar.createDiv({ cls: "vectrola-progress-fill" });
		const progressText = container.createDiv({ cls: "vectrola-progress-text", text: "0/0" });

		this.currentNotice = new Notice(noticeEl, 0);
		this.noticeContent = { label, progressFill, progressText };

		// Cancel button handler
		cancelBtn.onclick = (e) => {
			e.stopPropagation();
			this.syncCancelled = true;
			this.currentNotice?.hide();
			this.currentNotice = null;
			this.noticeContent = null;
			new Notice("🚫 Sync cancelled");
		};

		// Update with current progress
		this.updateProgressDisplay();
	}

	private updateProgressDisplay() {
		if (!this.noticeContent) return;

		const { label, progressFill, progressText } = this.noticeContent;
		const current = this.syncStats.processed;
		const total = this.syncStats.total;
		const pct = total > 0 ? Math.round((current / total) * 100) : 0;

		label.textContent = `⬇️ ${this.syncStats.downloaded} ⏭️ ${this.syncStats.skipped}`;
		progressFill.style.width = `${pct}%`;
		progressText.textContent = `${current}/${total}`;
	}

	async syncFromDrive() {
		if (!this.isAuthenticated()) {
			new Notice("Please sign in with Google Drive first.");
			return;
		}

		// If already syncing, just show the progress notice
		if (this.isSyncing) {
			this.showProgressNotice();
			return;
		}

		// Start sync
		this.isSyncing = true;
		this.syncCancelled = false;
		this.syncStats = { processed: 0, downloaded: 0, skipped: 0, total: 0 };

		this.showProgressNotice();
		if (this.noticeContent) {
			this.noticeContent.label.textContent = "🔄 Connecting...";
		}

		try {
			// Find the Vectrola folder
			if (this.noticeContent) {
				this.noticeContent.label.textContent = `🔄 Finding folder...`;
			}
			const folderId = await this.findOrCreateFolder(this.settings.driveFolderPath);

			if (this.syncCancelled) { this.isSyncing = false; return; }

			// First pass: count total files
			if (this.noticeContent) {
				this.noticeContent.label.textContent = "🔄 Counting files...";
			}
			this.syncStats.total = await this.countDriveFiles(folderId);
			this.updateProgressDisplay();

			if (this.syncCancelled) { this.isSyncing = false; return; }

			// Second pass: sync files with progress
			await this.syncFolderFromDrive(folderId, "", () => {
				this.updateProgressDisplay();
			});

			if (this.syncCancelled) { this.isSyncing = false; return; }

			this.settings.lastSyncTime = Date.now();
			await this.saveSettings();

			this.currentNotice?.hide();
			this.currentNotice = null;
			this.noticeContent = null;

			if (this.syncStats.skipped > 0) {
				new Notice(`✅ Sync complete! ${this.syncStats.downloaded} downloaded, ${this.syncStats.skipped} skipped`);
			} else {
				new Notice(`✅ Sync complete! ${this.syncStats.downloaded} files downloaded`);
			}
		} catch (error) {
			if (!this.syncCancelled) {
				console.error("Sync failed:", error);
				this.currentNotice?.hide();
				new Notice(`❌ Sync failed: ${error.message}`);
			}
			this.currentNotice = null;
			this.noticeContent = null;
		} finally {
			this.isSyncing = false;
		}
	}

	async countDriveFiles(folderId: string): Promise<number> {
		if (this.syncCancelled) return 0;

		const driveFiles = await this.listDriveFiles(folderId);
		let count = 0;

		for (const file of driveFiles) {
			if (this.syncCancelled) return count;

			if (file.mimeType === "application/vnd.google-apps.folder") {
				count += await this.countDriveFiles(file.id);
			} else if (file.name.endsWith(".md")) {
				count++;
			}
		}

		return count;
	}

	async syncFolderFromDrive(folderId: string, localPath: string, onProgress?: (current: number) => void) {
		if (this.syncCancelled) return;

		const driveFiles = await this.listDriveFiles(folderId);

		for (const file of driveFiles) {
			if (this.syncCancelled) return;

			const filePath = localPath ? `${localPath}/${file.name}` : file.name;

			if (file.mimeType === "application/vnd.google-apps.folder") {
				// Create local folder if it doesn't exist
				const folder = this.app.vault.getAbstractFileByPath(filePath);
				if (!folder) {
					try {
						await this.app.vault.createFolder(filePath);
					} catch {
						// Folder may already exist, ignore
					}
				}
				await this.syncFolderFromDrive(file.id, filePath, onProgress);
			} else if (file.name.endsWith(".md")) {
				// Check if file is unchanged (compare md5 hash from cache) BEFORE incrementing
				const cachedHash = this.settings.syncCache[filePath];
				if (cachedHash && file.md5Checksum && cachedHash === file.md5Checksum) {
					// File unchanged, skip download
					this.syncStats.processed++;
					this.syncStats.skipped++;
					if (onProgress) onProgress(this.syncStats.processed);
					continue;
				}

				// Track as downloaded (not skipped)
				this.syncStats.processed++;
				this.syncStats.downloaded++;
				if (onProgress) onProgress(this.syncStats.processed);

				// Download and save markdown file
				const content = await this.downloadFile(file.id);
				const existingFile = this.app.vault.getAbstractFileByPath(filePath);

				if (existingFile instanceof TFile) {
					await this.app.vault.modify(existingFile, content);
				} else {
					// Create new file
					try {
						await this.app.vault.create(filePath, content);
					} catch {
						// File may already exist, try to modify instead
						const retryFile = this.app.vault.getAbstractFileByPath(filePath);
						if (retryFile instanceof TFile) {
							await this.app.vault.modify(retryFile, content);
						}
					}
				}

				// Update cache with new hash
				if (file.md5Checksum) {
					this.settings.syncCache[filePath] = file.md5Checksum;
				}
			}
		}
	}

	async syncToDrive() {
		if (!this.isAuthenticated()) {
			new Notice("Please sign in with Google Drive first.");
			return;
		}

		new Notice("Pushing to Google Drive...");

		try {
			const folderId = await this.findOrCreateFolder(this.settings.driveFolderPath);

			// Get all markdown files in vault
			const files = this.app.vault.getMarkdownFiles();
			let uploaded = 0;

			for (const file of files) {
				const content = await this.app.vault.read(file);

				// Find parent folder in Drive
				const parentPath = file.parent?.path || "";
				const driveParentPath = parentPath
					? `${this.settings.driveFolderPath}/${parentPath}`
					: this.settings.driveFolderPath;
				const parentFolderId = await this.findOrCreateFolder(driveParentPath);

				// Check if file exists in Drive
				const query = `name='${file.name}' and '${parentFolderId}' in parents and trashed=false`;
				const existing = await this.driveRequest(
					`files?q=${encodeURIComponent(query)}&fields=files(id)`
				);

				const existingId = existing.files?.[0]?.id;
				await this.uploadFile(file.name, content, parentFolderId, existingId);
				uploaded++;
			}

			this.settings.lastSyncTime = Date.now();
			await this.saveSettings();

			new Notice(`Pushed ${uploaded} files to Google Drive!`);
		} catch (error) {
			console.error("Push failed:", error);
			new Notice(`Push failed: ${error.message}`);
		}
	}
}

// =============================================================================
// Auth Code Modal
// =============================================================================

class AuthCodeModal extends Modal {
	private callback: (code: string | null) => void;
	private inputEl: TextComponent;

	constructor(app: App, callback: (code: string | null) => void) {
		super(app);
		this.callback = callback;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.createEl("h2", { text: "Paste Authorization Code" });
		contentEl.createEl("p", {
			text: "A browser window opened. After signing in, copy the code shown and paste it here:",
		});

		this.inputEl = new TextComponent(contentEl);
		this.inputEl.inputEl.addClass("vectrola-input-full-width");
		this.inputEl.inputEl.placeholder = "Paste code here...";

		const buttonContainer = contentEl.createDiv({ cls: "vectrola-button-container" });

		const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
		cancelBtn.onclick = () => {
			this.callback(null);
			this.close();
		};

		const submitBtn = buttonContainer.createEl("button", {
			text: "Connect",
			cls: "mod-cta",
		});
		submitBtn.onclick = () => {
			const code = this.inputEl.getValue().trim();
			this.callback(code || null);
			this.close();
		};

		// Focus the input
		setTimeout(() => this.inputEl.inputEl.focus(), 100);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// =============================================================================
// Settings Tab
// =============================================================================

class VectrolaSyncSettingTab extends PluginSettingTab {
	plugin: VectrolaSyncPlugin;

	constructor(app: App, plugin: VectrolaSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Connection Status
		new Setting(containerEl).setName("Connection").setHeading();

		if (this.plugin.isAuthenticated()) {
			const statusBox = containerEl.createEl("div", { cls: "vectrola-status-box" });
			const statusContainer = statusBox.createEl("div", { cls: "vectrola-status-container" });
			statusContainer.createEl("span", { cls: "vectrola-status-icon", text: "✅" });
			const statusText = statusContainer.createEl("div", { cls: "vectrola-status-text" });
			statusText.createEl("div", { cls: "vectrola-status-title", text: "Connected to Google Drive" });
			if (this.plugin.settings.userEmail) {
				statusText.createEl("div", { cls: "vectrola-status-subtitle", text: this.plugin.settings.userEmail });
			}

			new Setting(containerEl)
				.setName("Sign out")
				.setDesc("Disconnect from Google Drive")
				.addButton((btn) =>
					btn
						.setButtonText("Sign Out")
						.setWarning()
						.onClick(async () => {
							await this.plugin.signOut();
							this.display();
						})
				);
		} else {
			const statusBox = containerEl.createEl("div", { cls: "vectrola-status-box" });
			const statusContainer = statusBox.createEl("div", { cls: "vectrola-status-container" });
			statusContainer.createEl("span", { cls: "vectrola-status-icon", text: "🔗" });
			const statusText = statusContainer.createEl("div", { cls: "vectrola-status-text" });
			statusText.createEl("div", { cls: "vectrola-status-title", text: "Not connected" });
			statusText.createEl("div", { cls: "vectrola-status-subtitle", text: "Sign in to sync your music wiki" });

			new Setting(containerEl)
				.setName("Sign in with Google")
				.setDesc("Connect to Google Drive to sync your wiki")
				.addButton((btn) =>
					btn
						.setButtonText("Sign in with Google")
						.setCta()
						.onClick(async () => {
							await this.plugin.authenticate();
							this.display();
						})
				);
		}

		// Sync Options
		new Setting(containerEl).setName("Synchronization").setHeading();

		new Setting(containerEl)
			.setName("Drive folder path")
			.setDesc("Google Drive folder where wiki is stored")
			.addText((text) =>
				text
					.setPlaceholder("/Vectrola/wiki")
					.setValue(this.plugin.settings.driveFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.driveFolderPath = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Auto-sync on open")
			.setDesc("Automatically pull from Drive when vault opens")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoSyncOnOpen)
					.onChange(async (value) => {
						this.plugin.settings.autoSyncOnOpen = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Sync interval (minutes)")
			.setDesc("How often to sync automatically (0 to disable)")
			.addText((text) =>
				text
					.setPlaceholder("5")
					.setValue(String(this.plugin.settings.syncIntervalMinutes))
					.onChange(async (value) => {
						const num = parseInt(value) || 0;
						this.plugin.settings.syncIntervalMinutes = num;
						await this.plugin.saveSettings();
						this.plugin.setupSyncInterval();
					})
			);

		// Manual Sync
		new Setting(containerEl).setName("Manual Sync").setHeading();

		new Setting(containerEl)
			.setName("Pull from Drive")
			.setDesc("Download latest wiki from Google Drive")
			.addButton((btn) =>
				btn.setButtonText("Pull").onClick(async () => {
					await this.plugin.syncFromDrive();
				})
			);

		new Setting(containerEl)
			.setName("Push to Drive")
			.setDesc("Upload current vault to Google Drive")
			.addButton((btn) =>
				btn.setButtonText("Push").onClick(async () => {
					await this.plugin.syncToDrive();
				})
			);

		// Last sync time
		if (this.plugin.settings.lastSyncTime > 0) {
			const lastSync = new Date(this.plugin.settings.lastSyncTime).toLocaleString();
			containerEl.createEl("p", {
				text: `Last synced: ${lastSync}`,
				cls: "setting-item-description",
			});
		}
	}
}
