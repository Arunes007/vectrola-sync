/**
 * Sync engine for bi-directional Google Drive synchronization
 */

import { App, Notice, TFile } from "obsidian";
import * as SparkMD5 from "spark-md5";
import { DriveFile, VectrolaSyncSettings } from "./types";
import { DriveClient } from "./drive-api";

// =============================================================================
// Sync Engine Interface
// =============================================================================

export interface SyncEngine {
	syncFromDrive: () => Promise<void>;
	syncToDrive: () => Promise<void>;
	isSyncing: () => boolean;
}

// =============================================================================
// Sync State
// =============================================================================

interface SyncStats {
	processed: number;
	downloaded: number;
	skipped: number;
	total: number;
}

interface NoticeContent {
	label: HTMLDivElement;
	progressFill: HTMLDivElement;
	progressText: HTMLDivElement;
}

// =============================================================================
// Sync Engine Factory
// =============================================================================

export interface SyncEngineDeps {
	app: App;
	driveClient: DriveClient;
	settings: VectrolaSyncSettings;
	saveSettings: () => Promise<void>;
	isAuthenticated: () => boolean;
}

export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
	let syncStats: SyncStats = { processed: 0, downloaded: 0, skipped: 0, total: 0 };
	let syncCancelled = false;
	let syncing = false;
	let currentNotice: Notice | null = null;
	let noticeContent: NoticeContent | null = null;

	const showProgressNotice = () => {
		// If notice exists and is still in DOM, just return
		if (currentNotice && document.body.contains(currentNotice.noticeEl)) {
			return;
		}

		// Create new progress notice
		const noticeEl = document.createDocumentFragment();
		const container = noticeEl.createDiv({ cls: "vectrola-sync-progress-container" });

		const headerRow = container.createDiv({ cls: "vectrola-sync-progress-header" });
		const label = headerRow.createDiv({ cls: "vectrola-sync-progress-label", text: "🔄 Syncing..." });
		const cancelBtn = headerRow.createEl("button", { cls: "vectrola-cancel-btn", text: "✕" });

		const progressBar = container.createDiv({ cls: "vectrola-sync-progress-bar" });
		const progressFill = progressBar.createDiv({ cls: "vectrola-sync-progress-fill" });
		const progressText = container.createDiv({ cls: "vectrola-sync-progress-text", text: "0/0" });

		currentNotice = new Notice(noticeEl, 0);
		noticeContent = { label, progressFill, progressText };

		// Cancel button handler
		cancelBtn.onclick = (e) => {
			e.stopPropagation();
			syncCancelled = true;
			currentNotice?.hide();
			currentNotice = null;
			noticeContent = null;
			new Notice("🚫 Sync cancelled");
		};

		// Update with current progress
		updateProgressDisplay();
	};

	const updateProgressDisplay = () => {
		if (!noticeContent) return;

		const { label, progressFill, progressText } = noticeContent;
		const current = syncStats.processed;
		const total = syncStats.total;
		const pct = total > 0 ? Math.round((current / total) * 100) : 0;

		label.textContent = `⬇️ ${syncStats.downloaded} ⏭️ ${syncStats.skipped}`;
		(progressFill as HTMLElement).setCssStyles({ width: `${pct}%` });
		progressText.textContent = `${current}/${total}`;
	};

	// Phase 1: Collect all files recursively (no downloads, just listing)
	const collectDriveFiles = async (
		folderId: string,
		localPath: string
	): Promise<Array<{ file: DriveFile; localPath: string }>> => {
		if (syncCancelled) return [];

		const result: Array<{ file: DriveFile; localPath: string }> = [];
		const driveFiles = await deps.driveClient.listDriveFiles(folderId);

		for (const file of driveFiles) {
			if (syncCancelled) return result;

			const filePath = localPath ? `${localPath}/${file.name}` : file.name;

			if (file.mimeType === "application/vnd.google-apps.folder") {
				// Create local folder if it doesn't exist
				const folder = deps.app.vault.getAbstractFileByPath(filePath);
				if (!folder) {
					try {
						await deps.app.vault.createFolder(filePath);
					} catch {
						// Folder may already exist, ignore
					}
				}
				// Recurse into subfolder
				const subFiles = await collectDriveFiles(file.id, filePath);
				result.push(...subFiles);
			} else if (file.name.endsWith(".md")) {
				result.push({ file, localPath: filePath });
			}
		}

		return result;
	};

	// Phase 2: Download files in parallel batches
	const downloadFileBatch = async (
		files: Array<{ file: DriveFile; localPath: string }>,
		concurrency: number = 10,
		onProgress?: () => void
	) => {
		// Process in batches for controlled concurrency
		for (let i = 0; i < files.length; i += concurrency) {
			if (syncCancelled) return;

			const batch = files.slice(i, i + concurrency);
			await Promise.all(
				batch.map(async ({ file, localPath }) => {
					if (syncCancelled) return;

					try {
						// First check cache (fast path)
						const cachedHash = deps.settings.syncCache[localPath];
						if (cachedHash && file.md5Checksum && cachedHash === file.md5Checksum) {
							// File unchanged per cache, skip download
							syncStats.processed++;
							syncStats.skipped++;
							onProgress?.();
							return;
						}

						// Cache miss - check if local file exists and compare MD5 directly
						const existingFile = deps.app.vault.getAbstractFileByPath(localPath);
						if (existingFile instanceof TFile && file.md5Checksum) {
							const localContent = await deps.app.vault.read(existingFile);
							const localHash = SparkMD5.hash(localContent);

							if (localHash === file.md5Checksum) {
								// Local file matches Drive, skip download and update cache
								syncStats.processed++;
								syncStats.skipped++;
								deps.settings.syncCache[localPath] = file.md5Checksum;
								onProgress?.();
								return;
							}
						}

						// File missing or different - download it
						const content = await deps.driveClient.downloadFile(file.id);

						if (existingFile instanceof TFile) {
							await deps.app.vault.modify(existingFile, content);
						} else {
							// Create new file
							try {
								await deps.app.vault.create(localPath, content);
							} catch {
								// File may already exist, try to modify instead
								const retryFile = deps.app.vault.getAbstractFileByPath(localPath);
								if (retryFile instanceof TFile) {
									await deps.app.vault.modify(retryFile, content);
								}
							}
						}

						// Update cache with new hash
						if (file.md5Checksum) {
							deps.settings.syncCache[localPath] = file.md5Checksum;
						}

						syncStats.processed++;
						syncStats.downloaded++;
						onProgress?.();
					} catch (error) {
						console.error(`Failed to download ${localPath}:`, error);
						syncStats.processed++;
						onProgress?.();
					}
				})
			);
		}
	};

	// Helper to create nested folders within a parent folder
	const findOrCreateFolderInParent = async (parentFolderId: string, relativePath: string): Promise<string> => {
		const parts = relativePath.split("/").filter((p) => p);
		let currentParentId = parentFolderId;

		for (const part of parts) {
			// Search for existing folder
			const query = `name='${part}' and '${currentParentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
			const searchResult = await deps.driveClient.driveRequest(
				`files?q=${encodeURIComponent(query)}&fields=files(id,name)`
			);

			if (searchResult.files && searchResult.files.length > 0) {
				currentParentId = searchResult.files[0].id;
			} else {
				// Create folder
				const metadata = {
					name: part,
					mimeType: "application/vnd.google-apps.folder",
					parents: [currentParentId],
				};

				const created = await deps.driveClient.driveRequest(
					"files?fields=id",
					"POST",
					JSON.stringify(metadata),
					"application/json"
				);
				currentParentId = created.id;
			}
		}

		return currentParentId;
	};

	const syncFromDrive = async (): Promise<void> => {
		if (!deps.isAuthenticated()) {
			new Notice("Please sign in with Google Drive first.");
			return;
		}

		// Check if wiki folder is discovered
		if (!deps.settings.wikiFolderId) {
			new Notice("Wiki folder not found. Run 'vectrola wiki --sync' in terminal first.");
			return;
		}

		// If already syncing, just show the progress notice
		if (syncing) {
			showProgressNotice();
			return;
		}

		// Start sync
		syncing = true;
		syncCancelled = false;
		syncStats = { processed: 0, downloaded: 0, skipped: 0, total: 0 };

		showProgressNotice();
		if (noticeContent) {
			noticeContent.label.textContent = "🔄 Connecting...";
		}

		try {
			// Use wiki folder ID (auto-discovered from /Vectrola/wiki)
			const folderId = deps.settings.wikiFolderId;

			if (syncCancelled) { syncing = false; return; }

			// Phase 1: Collect all files (fast - just API listing)
			if (noticeContent) {
				noticeContent.label.textContent = "🔄 Scanning folders...";
			}
			const allFiles = await collectDriveFiles(folderId, "");
			syncStats.total = allFiles.length;
			updateProgressDisplay();

			if (syncCancelled) { syncing = false; return; }

			// Phase 2: Download files in parallel batches of 10
			if (noticeContent) {
				noticeContent.label.textContent = "🔄 Downloading...";
			}
			await downloadFileBatch(allFiles, 10, () => updateProgressDisplay());

			if (syncCancelled) { syncing = false; return; }

			deps.settings.lastSyncTime = Date.now();
			await deps.saveSettings();

			currentNotice?.hide();
			currentNotice = null;
			noticeContent = null;

			if (syncStats.skipped > 0) {
				new Notice(`✅ Sync complete! ${syncStats.downloaded} downloaded, ${syncStats.skipped} skipped`);
			} else {
				new Notice(`✅ Sync complete! ${syncStats.downloaded} files downloaded`);
			}
		} catch (error: any) {
			if (!syncCancelled) {
				console.error("Sync failed:", error);
				currentNotice?.hide();
				new Notice(`❌ Sync failed: ${error.message}`);
			}
			currentNotice = null;
			noticeContent = null;
		} finally {
			syncing = false;
		}
	};

	const syncToDrive = async (): Promise<void> => {
		if (!deps.isAuthenticated()) {
			new Notice("Please sign in with Google Drive first.");
			return;
		}

		// Check if wiki folder is discovered
		if (!deps.settings.wikiFolderId) {
			new Notice("Wiki folder not found. Run 'vectrola wiki --sync' in terminal first.");
			return;
		}

		new Notice("Pushing to Google Drive...");

		try {
			// Use wiki folder ID (auto-discovered from /Vectrola/wiki)
			const folderId = deps.settings.wikiFolderId;

			// Get all markdown files in vault
			const files = deps.app.vault.getMarkdownFiles();
			let uploaded = 0;

			for (const file of files) {
				const content = await deps.app.vault.read(file);

				// Find parent folder in Drive (relative to selected folder)
				const parentPath = file.parent?.path || "";
				let parentFolderId = folderId;

				if (parentPath) {
					// Create nested folders within the selected folder
					parentFolderId = await findOrCreateFolderInParent(folderId, parentPath);
				}

				// Check if file exists in Drive
				const query = `name='${file.name}' and '${parentFolderId}' in parents and trashed=false`;
				const existing = await deps.driveClient.driveRequest(
					`files?q=${encodeURIComponent(query)}&fields=files(id)`
				);

				const existingId = existing.files?.[0]?.id;
				await deps.driveClient.uploadFile(file.name, content, parentFolderId, existingId);
				uploaded++;
			}

			deps.settings.lastSyncTime = Date.now();
			await deps.saveSettings();

			new Notice(`Pushed ${uploaded} files to Google Drive!`);
		} catch (error: any) {
			console.error("Push failed:", error);
			new Notice(`Push failed: ${error.message}`);
		}
	};

	return {
		syncFromDrive,
		syncToDrive,
		isSyncing: () => syncing,
	};
}
