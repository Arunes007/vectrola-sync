/**
 * Settings tab for Vectrola Sync
 */

import { App, PluginSettingTab, Setting, Events, Notice, Platform } from "obsidian";
import { VectrolaSyncSettings } from "./types";
import type { AudioCache, CacheStats } from "./audio-cache";

// =============================================================================
// Settings Tab Interface
// =============================================================================

export interface SettingsTabDeps {
	settings: VectrolaSyncSettings;
	saveSettings: () => Promise<void>;
	events: Events;
	isAuthenticated: () => boolean;
	hasTokensOnly: () => boolean;
	authenticate: () => Promise<void>;
	signOut: () => Promise<void>;
	retryFolderDiscovery: () => Promise<void>;
	syncFromDrive: () => Promise<void>;
	syncToDrive: () => Promise<void>;
	setupSyncInterval: () => void;
	getAudioCache: () => AudioCache | null;
}

// =============================================================================
// Settings Tab Class
// =============================================================================

export class VectrolaSyncSettingTab extends PluginSettingTab {
	private deps: SettingsTabDeps;
	private authStateHandler: () => void;

	constructor(app: App, plugin: any, deps: SettingsTabDeps) {
		super(app, plugin);
		this.deps = deps;

		// Listen for auth state changes to refresh the UI
		this.authStateHandler = () => this.display();
		this.deps.events.on("auth-state-changed", this.authStateHandler);
	}

	hide(): void {
		// Cleanup event listener when settings tab is closed
		this.deps.events.off("auth-state-changed", this.authStateHandler);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Connection Status
		new Setting(containerEl).setName("Connection").setHeading();

		if (this.deps.isAuthenticated()) {
			const statusBox = containerEl.createEl("div", { cls: "vectrola-status-box" });
			const statusContainer = statusBox.createEl("div", { cls: "vectrola-status-container" });
			statusContainer.createEl("span", { cls: "vectrola-status-icon", text: "✅" });
			const statusText = statusContainer.createEl("div", { cls: "vectrola-status-text" });
			statusText.createEl("div", { cls: "vectrola-status-title", text: "Connected to Google Drive" });
			if (this.deps.settings.userEmail) {
				statusText.createEl("div", { cls: "vectrola-status-subtitle", text: this.deps.settings.userEmail });
			}

			new Setting(containerEl)
				.setName("Sign out")
				.setDesc("Disconnect from Google Drive")
				.addButton((btn) =>
					btn
						.setButtonText("Sign Out")
						.setWarning()
						.onClick(async () => {
							await this.deps.signOut();
							this.display();
						})
				);
		} else if (this.deps.hasTokensOnly()) {
			// Partially authenticated - has tokens but wiki folder not found
			const statusBox = containerEl.createEl("div", { cls: "vectrola-status-box" });
			const statusContainer = statusBox.createEl("div", { cls: "vectrola-status-container" });
			statusContainer.createEl("span", { cls: "vectrola-status-icon", text: "⚠️" });
			const statusText = statusContainer.createEl("div", { cls: "vectrola-status-text" });
			statusText.createEl("div", { cls: "vectrola-status-title", text: "Wiki folder not found" });
			statusText.createEl("div", { cls: "vectrola-status-subtitle", text: "Run 'vectrola wiki --sync' in terminal first" });

			new Setting(containerEl)
				.setName("Retry")
				.setDesc("Try to find Vectrola folders again")
				.addButton((btn) =>
					btn
						.setButtonText("Retry")
						.setCta()
						.onClick(async () => {
							await this.deps.retryFolderDiscovery();
							this.display();
						})
				);

			new Setting(containerEl)
				.setName("Sign out")
				.setDesc("Start over with a different account")
				.addButton((btn) =>
					btn
						.setButtonText("Sign Out")
						.onClick(async () => {
							await this.deps.signOut();
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
							await this.deps.authenticate();
							this.display();
						})
				);
		}

		// Sync Options
		new Setting(containerEl).setName("Synchronization").setHeading();

		// Show wiki folder status
		if (this.deps.settings.wikiFolderId) {
			new Setting(containerEl)
				.setName("Wiki folder")
				.setDesc("✓ Connected to /Vectrola/wiki")
				.addButton((btn) =>
					btn
						.setButtonText("Refresh")
						.onClick(async () => {
							await this.deps.retryFolderDiscovery();
							this.display();
						})
				);
		}

		new Setting(containerEl)
			.setName("Auto-sync on open")
			.setDesc("Automatically pull from Drive when vault opens")
			.addToggle((toggle) =>
				toggle
					.setValue(this.deps.settings.autoSyncOnOpen)
					.onChange(async (value) => {
						this.deps.settings.autoSyncOnOpen = value;
						await this.deps.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Sync interval (minutes)")
			.setDesc("How often to sync automatically (0 to disable)")
			.addText((text) =>
				text
					.setPlaceholder("5")
					.setValue(String(this.deps.settings.syncIntervalMinutes))
					.onChange(async (value) => {
						const num = parseInt(value) || 0;
						this.deps.settings.syncIntervalMinutes = num;
						await this.deps.saveSettings();
						this.deps.setupSyncInterval();
					})
			);

		// Manual Sync
		new Setting(containerEl).setName("Manual Sync").setHeading();

		new Setting(containerEl)
			.setName("Pull from Drive")
			.setDesc("Download latest wiki from Google Drive")
			.addButton((btn) =>
				btn.setButtonText("Pull").onClick(async () => {
					await this.deps.syncFromDrive();
				})
			);

		new Setting(containerEl)
			.setName("Push to Drive")
			.setDesc("Upload current vault to Google Drive")
			.addButton((btn) =>
				btn.setButtonText("Push").onClick(async () => {
					await this.deps.syncToDrive();
				})
			);

		// Last sync time
		if (this.deps.settings.lastSyncTime > 0) {
			const lastSync = new Date(this.deps.settings.lastSyncTime).toLocaleString();
			containerEl.createEl("p", {
				text: `Last synced: ${lastSync}`,
				cls: "setting-item-description",
			});
		}

		// Audio Cache Settings
		new Setting(containerEl).setName("Audio Cache").setHeading();

		new Setting(containerEl)
			.setName("Enable audio caching")
			.setDesc("Cache played songs for instant replay (uses IndexedDB)")
			.addToggle((toggle) =>
				toggle
					.setValue(this.deps.settings.audioCacheEnabled)
					.onChange(async (value) => {
						this.deps.settings.audioCacheEnabled = value;
						await this.deps.saveSettings();
					})
			);

		// Mobile: cap at 200MB to avoid iOS silent purges
		const maxLimit = Platform.isMobile ? 200 : 500;

		new Setting(containerEl)
			.setName("Cache size limit")
			.setDesc(`Maximum storage for cached audio (50-${maxLimit} MB)`)
			.addSlider((slider) =>
				slider
					.setLimits(50, maxLimit, 50)
					.setValue(Math.min(this.deps.settings.audioCacheMaxSizeMB, maxLimit))
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.deps.settings.audioCacheMaxSizeMB = value;
						await this.deps.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Preload ahead")
			.setDesc("Number of next tracks to preload (0-5)")
			.addSlider((slider) =>
				slider
					.setLimits(0, 5, 1)
					.setValue(this.deps.settings.audioCachePreloadAhead)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.deps.settings.audioCachePreloadAhead = value;
						await this.deps.saveSettings();
					})
			);

		// Cache statistics display
		const cache = this.deps.getAudioCache();
		if (cache) {
			cache.getStats().then((stats: CacheStats) => {
				const hitRate = stats.hits + stats.misses > 0
					? Math.round((stats.hits / (stats.hits + stats.misses)) * 100)
					: 0;
				const sizeText = `${(stats.totalSize / 1024 / 1024).toFixed(1)} MB`;

				const statsContainer = containerEl.createEl("div", { cls: "setting-item-description" });
				statsContainer.style.marginTop = "-10px";
				statsContainer.style.marginBottom = "10px";
				statsContainer.textContent = `Cache: ${sizeText} (${stats.fileCount} songs) | Hit rate: ${hitRate}% (${stats.hits} hits, ${stats.misses} misses)`;
			});
		}

		new Setting(containerEl)
			.setName("Clear cache")
			.setDesc("Remove all cached audio files")
			.addButton((btn) =>
				btn
					.setButtonText("Clear Cache")
					.setWarning()
					.onClick(async () => {
						const cache = this.deps.getAudioCache();
						if (cache) {
							await cache.clear();
							new Notice("Audio cache cleared");
							this.display(); // Refresh to show updated stats
						}
					})
			);
	}
}
