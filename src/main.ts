import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	requestUrl,
	TFile,
	TFolder,
} from "obsidian";

// =============================================================================
// Types
// =============================================================================

interface VectrolaSyncSettings {
	clientId: string;
	clientSecret: string;
	accessToken: string;
	refreshToken: string;
	tokenExpiry: number;
	driveFolderPath: string;
	autoSyncOnOpen: boolean;
	syncIntervalMinutes: number;
	lastSyncTime: number;
}

interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime: string;
	parents?: string[];
}

const DEFAULT_SETTINGS: VectrolaSyncSettings = {
	clientId: "",
	clientSecret: "",
	accessToken: "",
	refreshToken: "",
	tokenExpiry: 0,
	driveFolderPath: "/Vectrola/wiki",
	autoSyncOnOpen: true,
	syncIntervalMinutes: 5,
	lastSyncTime: 0,
};

// =============================================================================
// Main Plugin
// =============================================================================

export default class VectrolaSyncPlugin extends Plugin {
	settings: VectrolaSyncSettings;
	syncInterval: number | null = null;

	async onload() {
		await this.loadSettings();

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
			name: "Authenticate with Google Drive",
			callback: async () => {
				await this.authenticate();
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
	// OAuth Authentication
	// =========================================================================

	async authenticate() {
		if (!this.settings.clientId || !this.settings.clientSecret) {
			new Notice("Please configure Google OAuth credentials in settings first.");
			return;
		}

		// Generate OAuth URL
		const redirectUri = "urn:ietf:wg:oauth:2.0:oob"; // Manual copy-paste flow
		const scope = "https://www.googleapis.com/auth/drive.file";

		const authUrl =
			`https://accounts.google.com/o/oauth2/v2/auth?` +
			`client_id=${encodeURIComponent(this.settings.clientId)}` +
			`&redirect_uri=${encodeURIComponent(redirectUri)}` +
			`&response_type=code` +
			`&scope=${encodeURIComponent(scope)}` +
			`&access_type=offline` +
			`&prompt=consent`;

		// Open in browser
		window.open(authUrl);

		// Prompt user to enter the code
		const code = await this.promptForAuthCode();
		if (!code) {
			new Notice("Authentication cancelled.");
			return;
		}

		// Exchange code for tokens
		try {
			const tokenResponse = await requestUrl({
				url: "https://oauth2.googleapis.com/token",
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					code: code,
					client_id: this.settings.clientId,
					client_secret: this.settings.clientSecret,
					redirect_uri: redirectUri,
					grant_type: "authorization_code",
				}).toString(),
			});

			const tokens = tokenResponse.json;
			this.settings.accessToken = tokens.access_token;
			this.settings.refreshToken = tokens.refresh_token || this.settings.refreshToken;
			this.settings.tokenExpiry = Date.now() + tokens.expires_in * 1000;
			await this.saveSettings();

			new Notice("Successfully authenticated with Google Drive!");
			this.setupSyncInterval();
		} catch (error) {
			console.error("Token exchange failed:", error);
			new Notice("Authentication failed. Please try again.");
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

	async refreshAccessToken(): Promise<boolean> {
		if (!this.settings.refreshToken) {
			return false;
		}

		try {
			const response = await requestUrl({
				url: "https://oauth2.googleapis.com/token",
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					client_id: this.settings.clientId,
					client_secret: this.settings.clientSecret,
					refresh_token: this.settings.refreshToken,
					grant_type: "refresh_token",
				}).toString(),
			});

			const tokens = response.json;
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
		// Check if token is expired or about to expire (5 min buffer)
		if (Date.now() > this.settings.tokenExpiry - 300000) {
			const refreshed = await this.refreshAccessToken();
			if (!refreshed) {
				new Notice("Please re-authenticate with Google Drive.");
				return null;
			}
		}
		return this.settings.accessToken;
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
			let url = `files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,parents)`;
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

	async syncFromDrive() {
		if (!this.isAuthenticated()) {
			new Notice("Please authenticate with Google Drive first.");
			return;
		}

		new Notice("Syncing from Google Drive...");

		try {
			// Find or create the Vectrola folder
			const folderId = await this.findOrCreateFolder(this.settings.driveFolderPath);

			// Recursively sync all files
			await this.syncFolderFromDrive(folderId, "");

			this.settings.lastSyncTime = Date.now();
			await this.saveSettings();

			new Notice("Sync complete!");
		} catch (error) {
			console.error("Sync failed:", error);
			new Notice(`Sync failed: ${error.message}`);
		}
	}

	async syncFolderFromDrive(folderId: string, localPath: string) {
		const driveFiles = await this.listDriveFiles(folderId);

		for (const file of driveFiles) {
			const filePath = localPath ? `${localPath}/${file.name}` : file.name;

			if (file.mimeType === "application/vnd.google-apps.folder") {
				// Create local folder and recurse
				const folder = this.app.vault.getAbstractFileByPath(filePath);
				if (!folder) {
					await this.app.vault.createFolder(filePath);
				}
				await this.syncFolderFromDrive(file.id, filePath);
			} else if (file.name.endsWith(".md")) {
				// Download and save markdown file
				const content = await this.downloadFile(file.id);
				const existingFile = this.app.vault.getAbstractFileByPath(filePath);

				if (existingFile instanceof TFile) {
					// Check if remote is newer
					const driveModified = new Date(file.modifiedTime).getTime();
					if (driveModified > existingFile.stat.mtime) {
						await this.app.vault.modify(existingFile, content);
					}
				} else {
					// Create new file
					await this.app.vault.create(filePath, content);
				}
			}
		}
	}

	async syncToDrive() {
		if (!this.isAuthenticated()) {
			new Notice("Please authenticate with Google Drive first.");
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

import { Modal, TextComponent } from "obsidian";

class AuthCodeModal extends Modal {
	private callback: (code: string | null) => void;
	private inputEl: TextComponent;

	constructor(app: App, callback: (code: string | null) => void) {
		super(app);
		this.callback = callback;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.createEl("h2", { text: "Enter Authorization Code" });
		contentEl.createEl("p", {
			text: "After authorizing in your browser, copy the code and paste it here:",
		});

		this.inputEl = new TextComponent(contentEl);
		this.inputEl.inputEl.addClass("vectrola-input-full-width");

		const buttonContainer = contentEl.createDiv({ cls: "vectrola-button-container" });

		const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
		cancelBtn.onclick = () => {
			this.callback(null);
			this.close();
		};

		const submitBtn = buttonContainer.createEl("button", {
			text: "Submit",
			cls: "mod-cta",
		});
		submitBtn.onclick = () => {
			const code = this.inputEl.getValue().trim();
			this.callback(code || null);
			this.close();
		};
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

		containerEl.createEl("h2", { text: "Vectrola Sync Settings" });

		// Auth status
		const authStatus = containerEl.createEl("p");
		if (this.plugin.isAuthenticated()) {
			authStatus.innerHTML = "✅ <strong>Authenticated with Google Drive</strong>";
			authStatus.addClass("vectrola-status-authenticated");
		} else {
			authStatus.innerHTML = "❌ <strong>Not authenticated</strong>";
			authStatus.addClass("vectrola-status-unauthenticated");
		}

		// OAuth Credentials
		containerEl.createEl("h3", { text: "Google OAuth Credentials" });
		containerEl.createEl("p", {
			text: "Get credentials from Google Cloud Console. Create an OAuth 2.0 Client ID (Desktop app).",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Client ID")
			.setDesc("Your Google OAuth Client ID")
			.addText((text) =>
				text
					.setPlaceholder("xxxx.apps.googleusercontent.com")
					.setValue(this.plugin.settings.clientId)
					.onChange(async (value) => {
						this.plugin.settings.clientId = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Client Secret")
			.setDesc("Your Google OAuth Client Secret")
			.addText((text) =>
				text
					.setPlaceholder("GOCSPX-xxxx")
					.setValue(this.plugin.settings.clientSecret)
					.onChange(async (value) => {
						this.plugin.settings.clientSecret = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Authenticate")
			.setDesc("Connect to Google Drive")
			.addButton((btn) =>
				btn.setButtonText("Authenticate").onClick(async () => {
					await this.plugin.authenticate();
					this.display(); // Refresh to show new auth status
				})
			);

		// Sync Settings
		containerEl.createEl("h3", { text: "Sync Settings" });

		new Setting(containerEl)
			.setName("Drive Folder Path")
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
		containerEl.createEl("h3", { text: "Manual Sync" });

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
