import {
	App,
	Plugin,
	Notice,
	TFile,
	Events,
	Platform,
} from "obsidian";

import { ICONS, setIconContent } from "./icons";

// Import from extracted modules
import {
	VectrolaSyncSettings,
	VectrolaSyncAPI,
	TrackInfo,
	DEFAULT_SETTINGS,
} from "./types";
import { createAuthManager, AuthManager } from "./auth";
import { createDriveClient, DriveClient } from "./drive-api";
import { createSyncEngine, SyncEngine } from "./sync";
import { VectrolaSyncSettingTab } from "./settings-tab";

// =============================================================================
// Main Plugin
// =============================================================================

export default class VectrolaSyncPlugin extends Plugin {
	settings: VectrolaSyncSettings;
	syncInterval: number | null = null;

	// Public API for DataviewJS access
	public api: VectrolaSyncAPI;

	// Event emitter for auth state changes
	public events: Events = new Events();

	// Module instances
	private auth!: AuthManager;
	private drive!: DriveClient;
	private sync!: SyncEngine;

	async onload() {
		console.log('[onload] Plugin loading...');
		await this.loadSettings();

		// CRITICAL: Clear any lingering animation states from previous session
		// This prevents pulse animation from continuing after Obsidian restart
		document.querySelectorAll('.is-playing').forEach(el => {
			el.classList.remove('is-playing');
		});
		// Also clear any existing player bar from previous session
		document.getElementById('vectrola-global-player')?.remove();
		document.getElementById('vectrola-full-player')?.remove();
		document.getElementById('vectrola-full-player-backdrop')?.remove();

		// Reset player state if it exists from previous session
		if (window.vectrolaPlayer) {
			if (window.vectrolaPlayer.audio) {
				window.vectrolaPlayer.audio.pause();
				window.vectrolaPlayer.audio.currentTime = 0;
			}
			window.vectrolaPlayer.isPlaying = false;
		}

		// Initialize modules
		// Drive client needs a token getter - we'll set it up after auth
		this.drive = createDriveClient(() => this.auth.getValidAccessToken());

		// Auth manager
		this.auth = createAuthManager({
			settings: this.settings,
			saveSettings: () => this.saveSettings(),
			events: this.events,
			driveRequest: (endpoint, method, body, contentType) =>
				this.drive.driveRequest(endpoint, method, body, contentType),
			setupSyncInterval: () => this.setupSyncInterval(),
			clearSyncInterval: () => {
				if (this.syncInterval) {
					window.clearInterval(this.syncInterval);
					this.syncInterval = null;
				}
			},
		});

		// Sync engine
		this.sync = createSyncEngine({
			app: this.app,
			driveClient: this.drive,
			settings: this.settings,
			saveSettings: () => this.saveSettings(),
			isAuthenticated: () => this.auth.isAuthenticated(),
		});

		// Register OAuth callback handler for obsidian://vectrola-auth
		this.registerObsidianProtocolHandler("vectrola-auth", (params) => {
			this.auth.handleOAuthCallback(params);
		});

		// Register vectrola code block processor for audio player
		this.registerMarkdownCodeBlockProcessor("vectrola", (source, el, ctx) => {
			this.renderVectrolaPlayer(source, el);
		});

		// Expose API for audio player
		this.api = {
			fetchDriveFile: (id: string) => this.drive.downloadFileBuffer(id),
			isAuthenticated: () => this.auth.isAuthenticated(),
		};

		// Add ribbon icon
		this.addRibbonIcon("refresh-cw", "Sync with Vectrola", async () => {
			await this.sync.syncFromDrive();
		});

		// Add commands
		this.addCommand({
			id: "vectrola-sync-pull",
			name: "Pull wiki from Google Drive",
			callback: async () => {
				await this.sync.syncFromDrive();
			},
		});

		this.addCommand({
			id: "vectrola-sync-push",
			name: "Push wiki to Google Drive",
			callback: async () => {
				await this.sync.syncToDrive();
			},
		});

		this.addCommand({
			id: "vectrola-auth",
			name: "Sign in with Google Drive",
			callback: async () => {
				await this.auth.authenticate();
			},
		});

		this.addCommand({
			id: "vectrola-signout",
			name: "Sign out from Google Drive",
			callback: async () => {
				await this.auth.signOut();
			},
		});

		// Add settings tab
		this.addSettingTab(new VectrolaSyncSettingTab(this.app, this, {
			settings: this.settings,
			saveSettings: () => this.saveSettings(),
			events: this.events,
			isAuthenticated: () => this.auth.isAuthenticated(),
			hasTokensOnly: () => this.auth.hasTokensOnly(),
			authenticate: () => this.auth.authenticate(),
			signOut: () => this.auth.signOut(),
			retryFolderDiscovery: () => this.auth.retryFolderDiscovery(),
			syncFromDrive: () => this.sync.syncFromDrive(),
			syncToDrive: () => this.sync.syncToDrive(),
			setupSyncInterval: () => this.setupSyncInterval(),
		}));

		// Auto-sync on vault open
		if (this.settings.autoSyncOnOpen && this.auth.isAuthenticated()) {
			// Delay to let Obsidian fully load
			setTimeout(() => this.sync.syncFromDrive(), 3000);
		}

		// Set up periodic sync
		this.setupSyncInterval();

		// Force re-render of cached pages to register highlight updaters
		this.app.workspace.onLayoutReady(() => {
			console.log('[onLayoutReady] Triggering re-render of active markdown views');
			// Small delay to ensure everything is loaded
			setTimeout(() => {
				// If player doesn't exist but we have saved state, create it
				if (!window.vectrolaPlayer) {
					const saved = localStorage.getItem('vectrola-last-track');
					if (saved) {
						console.log('[onLayoutReady] Creating player from localStorage');
						try {
							const data = JSON.parse(saved);
							window.vectrolaPlayer = {
								audio: new Audio(),
								currentTrack: data.track,
								currentIndex: data.index,
								isPlaying: false,
								shuffleMode: false,
								repeatMode: 'off',
								shuffleHistory: [],
								playlist: data.playlist || [],
								playlistSource: data.playlistSource,
								ui: null,
								overlayVisible: false,
								volume: 1,
								endingHandled: false,
							};
							window.vectrolaPlayer.audio.preload = "none";
						} catch (e) {
							console.warn('[onLayoutReady] Failed to restore player:', e);
						}
					}
				}

				// Ensure MediaSession handlers are registered if player exists
				if (window.vectrolaPlayer) {
					console.log('[onLayoutReady] Registering MediaSession handlers');
					this.setupAudioEventListeners();
				}

				this.app.workspace.iterateAllLeaves((leaf) => {
					if (leaf.view.getViewType() === 'markdown') {
						const view = leaf.view as any;
						// Trigger re-render of the preview
						if (view.previewMode?.rerender) {
							console.log('[onLayoutReady] Re-rendering view:', leaf.getDisplayText());
							view.previewMode.rerender(true);
						}
					}
				});
			}, 500);
		});
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

		if (this.settings.syncIntervalMinutes > 0 && this.auth.isAuthenticated()) {
			this.syncInterval = window.setInterval(
				() => this.sync.syncFromDrive(),
				this.settings.syncIntervalMinutes * 60 * 1000
			);
		}
	}

	// =========================================================================
	// Vectrola Audio Player Renderer
	// =========================================================================

	private renderVectrolaPlayer(source: string, container: HTMLElement) {
		console.log('[renderVectrolaPlayer] Called for page');
		try {
			const config = JSON.parse(source);
			const playlist: TrackInfo[] = config.playlist || [];
			const pageTitle: string = config.title || "";

			if (!playlist.length) {
				container.createEl("p", { text: "No tracks available" });
				return;
			}

			// Initialize global player state if needed
			if (!window.vectrolaPlayer) {
				window.vectrolaPlayer = {
					audio: new Audio(),
					currentTrack: null,
					currentIndex: -1,
					isPlaying: false,
					shuffleMode: false,
					repeatMode: 'off',
					shuffleHistory: [],
					playlist: [],
					playlistSource: null,
					ui: null,
					overlayVisible: false,
					volume: 1,
					endingHandled: false,
				};
				window.vectrolaPlayer.audio.preload = "none";

				// Restore last played track from localStorage
				const saved = localStorage.getItem('vectrola-last-track');
				if (saved) {
					try {
						const data = JSON.parse(saved);
						window.vectrolaPlayer.currentTrack = data.track;
						window.vectrolaPlayer.currentIndex = data.index;
						window.vectrolaPlayer.playlist = data.playlist || [];
						window.vectrolaPlayer.playlistSource = data.playlistSource;
						// Don't auto-play, just show the track info
					} catch (e) {
						console.warn('Failed to restore last track:', e);
					}
				}

				// Set up audio event listeners (only once)
				this.setupAudioEventListeners();
			}

			const player = window.vectrolaPlayer;

			// Local wrapper for playTrack that sets this page's playlist
			const playTrack = (index: number) => {
				player.playlist = playlist;
				player.playlistSource = pageTitle;
				this.playTrack(index);
			};

			// === PAGE HEADER - Apple Music Style ===
			const header = container.createEl("div");
			header.className = "vectrola-page-header";

			// Artwork with title overlay
			const artworkContainer = header.createEl("div");
			artworkContainer.className = "vectrola-header-artwork";

			// Apply gradient or image
			if (config.artwork?.url) {
				const img = artworkContainer.createEl("img");
				img.src = config.artwork.url;
				img.alt = pageTitle;
			} else {
				// Use mood-based gradient from first track or page title
				const gradient = this.getMoodGradient(playlist[0]?.mood || pageTitle);
				artworkContainer.addClass(gradient);
			}

			// Title overlay on artwork
			const titleOverlay = artworkContainer.createEl("div");
			titleOverlay.className = "vectrola-header-title-overlay";
			titleOverlay.textContent = pageTitle;

			// Info section (right of artwork)
			const infoSection = header.createEl("div");
			infoSection.className = "vectrola-header-info";

			// Playlist name
			const titleEl = infoSection.createEl("h1");
			titleEl.className = "vectrola-header-name";
			titleEl.textContent = pageTitle;

			// Description (track count)
			const descEl = infoSection.createEl("p");
			descEl.className = "vectrola-header-description";
			descEl.textContent = `${playlist.length} Songs`;

			// Action buttons row
			const actionsEl = infoSection.createEl("div");
			actionsEl.className = "vectrola-header-actions";

			// Play button
			const playBtn = actionsEl.createEl("button");
			playBtn.className = "vectrola-header-btn vectrola-header-btn-play";
			setIconContent(playBtn, 'play');
			playBtn.appendChild(document.createTextNode(" Play"));
			playBtn.addEventListener("click", () => playTrack(0));

			// Shuffle button
			const shuffleBtn = actionsEl.createEl("button");
			shuffleBtn.className = "vectrola-header-btn vectrola-header-btn-shuffle";
			setIconContent(shuffleBtn, 'shuffle');
			shuffleBtn.appendChild(document.createTextNode(" Shuffle"));
			shuffleBtn.addEventListener("click", () => {
				player.shuffleMode = true;
				player.shuffleHistory = [];
				// Update player bar shuffle button
				const sBtn = document.getElementById("vectrola-shuffle-btn");
				if (sBtn) sBtn.classList.add("is-active");
				const randomIndex = Math.floor(Math.random() * playlist.length);
				playTrack(randomIndex);
			});

			// === TRACK LIST HEADER (Column titles) ===
			const listHeader = container.createEl("div");
			listHeader.className = "vectrola-list-header";
			const colSong = listHeader.createEl("span");
			colSong.className = "vectrola-col-song";
			colSong.textContent = "Song";
			const colArtist = listHeader.createEl("span");
			colArtist.className = "vectrola-col-artist";
			colArtist.textContent = "Artist";
			const colAlbum = listHeader.createEl("span");
			colAlbum.className = "vectrola-col-album";
			colAlbum.textContent = "Album";
			const colTime = listHeader.createEl("span");
			colTime.className = "vectrola-col-time";
			colTime.textContent = "Time";

			// Build track list
			const trackListEl = container.createEl("div");
			trackListEl.className = "vectrola-track-list";

			// Update track highlight for this page's list
			const updateLocalHighlight = () => {
				console.log('[updateLocalHighlight] Running, trackListEl in document:', document.contains(trackListEl), 'currentTrack:', player.currentTrack?.title);
				const rows = trackListEl.querySelectorAll(".vectrola-track-row");
				console.log('[updateLocalHighlight] Rows found:', rows.length);
				rows.forEach((row, i) => {
					const track = playlist[i];
					const isCurrentTrack = player.currentTrack && player.currentTrack.track_id === track.track_id;
					if (isCurrentTrack) {
						console.log('[updateLocalHighlight] Found match at index', i, 'track:', track.title);
					}
					row.classList.toggle("is-playing", !!isCurrentTrack);
					// Also toggle audio-playing based on whether audio is actually playing
					row.classList.toggle("audio-playing", !!isCurrentTrack && player.isPlaying);
				});
			};

			// Render each track row - Apple Music style
			playlist.forEach((track, i) => {
				const row = trackListEl.createEl("div");
				row.className = "vectrola-track-row";
				row.dataset.index = String(i);

				// Thumbnail with artwork or gradient fallback
				const thumb = row.createEl("div");
				thumb.className = "vectrola-track-row-thumbnail";
				if (track.artwork_url) {
					const img = thumb.createEl("img");
					img.src = track.artwork_url;
					img.alt = track.title;
				} else {
					thumb.addClass(this.getMoodGradient(track.mood));
					setIconContent(thumb, 'music');
				}

				// Equalizer bars overlay (shown when playing)
				const equalizer = thumb.createEl("div");
				equalizer.className = "vectrola-equalizer";
				for (let b = 0; b < 3; b++) {
					equalizer.createEl("span", { cls: "vectrola-eq-bar" });
				}

				// Song column (title only)
				const titleCol = row.createEl("div", { text: track.title });
				titleCol.className = "vectrola-track-row-title vectrola-col-song";

				// Artist column
				const artistCol = row.createEl("div", { text: track.artist || "" });
				artistCol.className = "vectrola-track-row-artist vectrola-col-artist";

				// Album column
				const albumCol = row.createEl("div", { text: track.album || "" });
				albumCol.className = "vectrola-track-row-album vectrola-col-album";

				// Time column
				const timeCol = row.createEl("div", { text: track.duration || "" });
				timeCol.className = "vectrola-track-row-duration vectrola-col-time";

				// More options button (three dots)
				const moreBtn = row.createEl("button");
				moreBtn.className = "vectrola-track-row-more";
				setIconContent(moreBtn, 'more');
				moreBtn.title = "Track details";
				moreBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					this.app.workspace.openLinkText(track.link, "", false);
				});

				// Row click to play
				row.addEventListener("click", () => {
					player.playlist = playlist;
					player.playlistSource = pageTitle;
					player.shuffleHistory = [];
					playTrack(i);
				});
			});

			// Create or get player bar
			this.ensurePlayerBar();

			// Update highlight when page loads
			updateLocalHighlight();

			// Register this page's highlight updater globally
			if (!window.vectrolaHighlightUpdaters) {
				window.vectrolaHighlightUpdaters = new Set();
			}
			window.vectrolaHighlightUpdaters.add(updateLocalHighlight);
			console.log('[Highlight] Registered updater, total:', window.vectrolaHighlightUpdaters.size);

			// Watch container width and toggle compact mode (hide Artist/Album columns)
			const resizeObserver = new ResizeObserver((entries) => {
				for (const entry of entries) {
					const width = entry.contentRect.width;
					const isCompact = width < 700;
					trackListEl.classList.toggle("vectrola-compact", isCompact);
					listHeader.classList.toggle("vectrola-compact", isCompact);
				}
			});
			resizeObserver.observe(container);

			// Cleanup when page unloads
			const observer = new MutationObserver(() => {
				if (!document.contains(trackListEl)) {
					console.log('[Highlight] Deleting updater - trackListEl removed from document, remaining:', (window.vectrolaHighlightUpdaters?.size || 1) - 1);
					window.vectrolaHighlightUpdaters?.delete(updateLocalHighlight);
					resizeObserver.disconnect();
					observer.disconnect();
				}
			});
			observer.observe(document.body, { childList: true, subtree: true });

		} catch (e) {
			console.error("Failed to render Vectrola player:", e);
			container.createEl("p", { text: "Error loading player", cls: "vectrola-error" });
		}
	}

	private updatePositionState() {
		const player = window.vectrolaPlayer;
		if (!player) return;
		if ('mediaSession' in navigator &&
			player.audio.duration &&
			!isNaN(player.audio.duration) &&
			!isNaN(player.audio.currentTime)) {
			try {
				navigator.mediaSession.setPositionState({
					duration: player.audio.duration,
					playbackRate: player.audio.playbackRate || 1.0,
					position: Math.min(player.audio.currentTime, player.audio.duration)
				});
			} catch (e) {
				// Ignore - some browsers don't support setPositionState
			}
		}
	}

	private setupAudioEventListeners() {
		const player = window.vectrolaPlayer;
		if (!player) return;

		console.log('[setupAudioEventListeners] Called, mediaSession available:', 'mediaSession' in navigator);

		// UI progress updates only (setPositionState removed to prevent continuous flooding)
		player.audio.addEventListener("timeupdate", () => {
			const pf = document.getElementById("vectrola-progress-fill");
			const ct = document.getElementById("vectrola-current-time");
			if (player.audio.duration && pf && ct) {
				(pf as HTMLElement).setCssStyles({ width: (player.audio.currentTime / player.audio.duration) * 100 + "%" });
				ct.textContent = this.formatTime(player.audio.currentTime);
			}
		});

		player.audio.addEventListener("loadedmetadata", () => {
			const tt = document.getElementById("vectrola-total-time");
			if (tt) tt.textContent = this.formatTime(player.audio.duration);

			// FIX: Reset iOS watchdog flag here ONLY after the previous track is fully terminated
			player.endingHandled = false;

			// Tell iOS this is a finite track and declare initial position state
			console.log('[MediaSession] loadedmetadata - updating position state', {
				duration: player.audio.duration,
				currentTime: player.audio.currentTime
			});
			this.updatePositionState();
		});

		// Trigger discrete position state updates on seek completion
		player.audio.addEventListener("seeked", () => {
			this.updatePositionState();
		});

		player.audio.addEventListener("ended", () => {
			if (!player.endingHandled) {
				player.endingHandled = true; // Safeguard against the watchdog race condition
				this.nextTrack();
			}
		});

		// iOS workaround: detect end of track via timeupdate when ended event doesn't fire
		player.audio.addEventListener("timeupdate", () => {
			if (player.audio.duration &&
				!player.audio.paused &&
				!player.endingHandled &&
				player.audio.currentTime >= player.audio.duration - 0.5) {
				player.endingHandled = true;
				this.nextTrack();
			}
		});

		// If the user manually seeks backward, unlock the watchdog flag
		player.audio.addEventListener("seeking", () => {
			if (player.audio.duration && player.audio.currentTime < player.audio.duration - 0.5) {
				player.endingHandled = false;
			}
		});

		// Sync MediaSession playback state with actual audio state and trigger discrete updates
		player.audio.addEventListener("play", () => {
			if ('mediaSession' in navigator) {
				navigator.mediaSession.playbackState = 'playing';
			}
			this.updatePositionState();
		});

		player.audio.addEventListener("pause", () => {
			if ('mediaSession' in navigator) {
				navigator.mediaSession.playbackState = 'paused';
			}
			this.updatePositionState();
		});

		// Save position to localStorage on pause
		player.audio.addEventListener("pause", () => {
			const saved = localStorage.getItem('vectrola-last-track');
			if (saved && player.currentTrack) {
				try {
					const data = JSON.parse(saved);
					data.position = player.audio.currentTime;
					localStorage.setItem('vectrola-last-track', JSON.stringify(data));
				} catch (e) {
					// Ignore
				}
			}
		});

		// Media Session action handlers (lock screen controls)
		if ('mediaSession' in navigator) {
			console.log('[MediaSession] Registering action handlers...');
			try {
				navigator.mediaSession.setActionHandler('play', () => {
					console.log('[MediaSession] play handler called');
					if (player.audio.paused) this.togglePlayPause();
				});
				console.log('[MediaSession] play handler registered');
			} catch (e) { console.error('[MediaSession] play not supported:', e); }
			try {
				navigator.mediaSession.setActionHandler('pause', () => {
					console.log('[MediaSession] pause handler called');
					if (!player.audio.paused) this.togglePlayPause();
				});
				console.log('[MediaSession] pause handler registered');
			} catch (e) { console.error('[MediaSession] pause not supported:', e); }
			try {
				navigator.mediaSession.setActionHandler('nexttrack', () => {
					console.log('[MediaSession] nexttrack handler called');
					this.nextTrack();
				});
				console.log('[MediaSession] nexttrack handler registered');
			} catch (e) { console.error('[MediaSession] nexttrack not supported:', e); }
			try {
				navigator.mediaSession.setActionHandler('previoustrack', () => {
					console.log('[MediaSession] previoustrack handler called');
					this.prevTrack();
				});
				console.log('[MediaSession] previoustrack handler registered');
			} catch (e) { console.error('[MediaSession] previoustrack not supported:', e); }

			// Unregister seek handlers to force iOS lock screen to prioritize track navigation UI (⏮ ⏭)
			try {
				navigator.mediaSession.setActionHandler('seekbackward', null);
				console.log('[MediaSession] seekbackward set to null');
			} catch (e) { console.error('[MediaSession] seekbackward null failed:', e); }
			try {
				navigator.mediaSession.setActionHandler('seekforward', null);
				console.log('[MediaSession] seekforward set to null');
			} catch (e) { console.error('[MediaSession] seekforward null failed:', e); }
			console.log('[MediaSession] All action handlers registered');
		} else {
			console.warn('[MediaSession] navigator.mediaSession not available');
		}
	}

	private formatTime(seconds: number): string {
		if (isNaN(seconds)) return "0:00";
		const mins = Math.floor(seconds / 60);
		const secs = Math.floor(seconds % 60);
		return `${mins}:${secs.toString().padStart(2, "0")}`;
	}

	private async playTrack(index: number) {
		const player = window.vectrolaPlayer;
		if (!player || index < 0 || index >= player.playlist.length) return;

		// REMOVED: player.endingHandled = false; (Now handled inside 'loadedmetadata' event)

		const track = player.playlist[index];
		const sources = track.sources || { local: {}, cloud: {} };
		let audioLoaded = false;

		// Clean up previous blob URL if any
		if (player.audio.src && player.audio.src.startsWith("blob:")) {
			URL.revokeObjectURL(player.audio.src);
		}

		// === DESKTOP: Try local files ===
		if (!Platform.isMobile && sources.local) {
			try {
				const os = require("os");
				const fs = require("fs");
				const hostname = os.hostname();

				// Try current device first
				const currentDevice = sources.local[hostname];
				if (currentDevice?.file_path && fs.existsSync(currentDevice.file_path)) {
					const buffer = fs.readFileSync(currentDevice.file_path);
					const blob = new Blob([buffer], { type: "audio/mpeg" });
					player.audio.src = URL.createObjectURL(blob);
					audioLoaded = true;
					console.log("Playing from local:", currentDevice.file_path);
				}

				// Fall back to other devices
				if (!audioLoaded) {
					for (const [device, deviceData] of Object.entries(sources.local)) {
						if (device === hostname) continue;
						const filePath = (deviceData as any)?.file_path;
						if (filePath && fs.existsSync(filePath)) {
							const buffer = fs.readFileSync(filePath);
							const blob = new Blob([buffer], { type: "audio/mpeg" });
							player.audio.src = URL.createObjectURL(blob);
							audioLoaded = true;
							console.log("Playing from local (other device):", filePath);
							break;
						}
					}
				}
			} catch (e) {
				console.warn("Local file access failed:", e);
			}
		}

		// === MOBILE: Try vault path ===
		if (!audioLoaded && Platform.isMobile) {
			const gdrivePath = sources.cloud?.gdrive?.path;
			if (gdrivePath) {
				const vaultPath = `audio/${gdrivePath}`;
				const file = this.app.vault.getAbstractFileByPath(vaultPath);
				if (file instanceof TFile) {
					try {
						const buffer = await this.app.vault.readBinary(file);
						const blob = new Blob([buffer], { type: "audio/mpeg" });
						player.audio.src = URL.createObjectURL(blob);
						audioLoaded = true;
						console.log("Playing from vault:", vaultPath);
					} catch (e) {
						console.warn("Vault read failed:", e);
					}
				}
			}
		}

		// === CLOUD: Google Drive (both platforms) ===
		if (!audioLoaded && sources.cloud?.gdrive?.file_id && this.auth.isAuthenticated()) {
			const gdriveId = sources.cloud.gdrive.file_id;
			try {
				const arrayBuffer = await this.drive.downloadFileBuffer(gdriveId);
				const blob = new Blob([arrayBuffer], { type: "audio/mpeg" });
				player.audio.src = URL.createObjectURL(blob);
				audioLoaded = true;
				console.log("Playing from GDrive:", gdriveId);
			} catch (e) {
				console.warn("GDrive playback failed:", e);
			}
		}

		// No source found - show helpful message based on what sources exist
		if (!audioLoaded) {
			const hasLocalSources = Object.keys(sources.local || {}).length > 0;
			const hasCloudSources = Object.keys(sources.cloud || {}).length > 0;

			let message = `⚠️ Cannot play "${track.title}"\n`;

			if (hasLocalSources && !hasCloudSources) {
				// Has local paths from other devices but not this one
				const devices = Object.keys(sources.local).join(", ");
				message += `File exists on: ${devices}\n`;
				message += `Re-ingest on this device: vectrola ingest <path>`;
			} else if (hasCloudSources && !this.auth.isAuthenticated()) {
				// Has cloud sources but not authenticated
				message += `Available on Google Drive.\n`;
				message += `Sign in to Vectrola Sync to play.`;
			} else if (!hasLocalSources && !hasCloudSources) {
				// No sources at all - need to ingest
				message += `No file path found.\n`;
				message += `Run: vectrola ingest <path-to-file>`;
			} else {
				// Has sources but all failed
				message += `File not accessible.\n`;
				message += `Re-ingest: vectrola ingest <path>`;
			}

			new Notice(message, 5000);
			return;
		}

		player.currentIndex = index;
		player.currentTrack = track;

		// Update Media Session metadata for lock screen controls
		if ('mediaSession' in navigator) {
			console.log('[MediaSession] Setting metadata:', { title: track.title, artist: track.artist, album: track.album || '' });
			navigator.mediaSession.metadata = new MediaMetadata({
				title: track.title,
				artist: track.artist,
				album: track.album || '',
				artwork: track.artwork_url ? [
					{ src: track.artwork_url, sizes: '512x512', type: 'image/jpeg' }
				] : []
			});
			navigator.mediaSession.playbackState = 'playing';
			console.log('[MediaSession] Metadata set, playbackState = playing');
		}

		// Persist last played track to localStorage
		localStorage.setItem('vectrola-last-track', JSON.stringify({
			track: track,
			index: index,
			playlist: player.playlist,
			playlistSource: player.playlistSource,
			position: 0
		}));

		try {
			await player.audio.play();
			player.isPlaying = true;
		} catch (e) {
			console.error("Playback failed:", e);
			new Notice(`❌ Playback failed: ${(e as Error).message}`);
			return;
		}

		// Update UI
		const titleEl = document.getElementById("vectrola-track-title");
		const artistEl = document.getElementById("vectrola-track-artist");
		const ppBtn = document.getElementById("vectrola-playpause-btn");
		const thumbnail = document.getElementById("vectrola-thumbnail");
		const artistContainer = document.querySelector(".vectrola-track-artist-container");

		if (titleEl) {
			titleEl.replaceChildren();
			const link = document.createElement("a");
			link.textContent = track.title;
			link.href = "#";
			link.style.textDecoration = 'none';
			link.style.color = 'inherit';
			link.addEventListener("click", (e) => {
				e.preventDefault();
				if (track.link) {
					this.app.workspace.openLinkText(track.link, "", false);
				}
			});
			titleEl.appendChild(link);
		}
		if (artistEl) artistEl.textContent = track.artist;
		if (ppBtn) setIconContent(ppBtn, 'pause');

		// Update thumbnail
		this.updateThumbnail(track);

		// Add playing animations
		thumbnail?.classList.add("is-playing");
		artistContainer?.classList.add("is-playing");

		// Update overlay if visible
		if (player.overlayVisible) {
			this.updateOverlayContent();
		}

		// Update all registered highlight updaters
		console.log('[playTrack] Calling highlight updaters after play, count:', window.vectrolaHighlightUpdaters?.size || 0);
		window.vectrolaHighlightUpdaters?.forEach(fn => fn());

		// Add audio-playing class to current track row for equalizer animation
		document.querySelectorAll(".vectrola-track-row.is-playing").forEach(row => {
			row.classList.add("audio-playing");
		});
		console.log('[playTrack] Track playing:', track.title, 'index:', index);

		if (player.shuffleMode && !player.shuffleHistory.includes(index)) {
			player.shuffleHistory.push(index);
		}
	}

	private togglePlayPause() {
		const player = window.vectrolaPlayer;
		if (!player) return;

		// If no track selected, play first track
		if (player.currentIndex === -1) {
			if (player.playlist.length > 0) {
				this.playTrack(0);
			}
			return;
		}

		// If audio source not loaded (restored from localStorage), re-initialize track
		if (!player.audio.src && player.currentIndex >= 0 && player.playlist.length > 0) {
			this.playTrack(player.currentIndex);
			return;
		}

		const ppBtn = document.getElementById("vectrola-playpause-btn");
		if (player.isPlaying) {
			player.audio.pause();
			player.isPlaying = false;
			// Save current position for resume after sleep
			localStorage.setItem('vectrola-last-position', String(player.audio.currentTime));
			if (ppBtn) setIconContent(ppBtn, 'play');
			// Update Media Session playback state
			if ('mediaSession' in navigator) {
				navigator.mediaSession.playbackState = 'paused';
			}
			// Stop marquee and pulse animations
			document.querySelector(".vectrola-track-artist-container")?.classList.remove("is-playing");
			document.getElementById("vectrola-thumbnail")?.classList.remove("is-playing");
			// Stop equalizer animation on track rows
			document.querySelectorAll(".vectrola-track-row.is-playing").forEach(row => {
				row.classList.remove("audio-playing");
			});
		} else {
			// Check if blob URL might be expired (after sleep/suspend)
			const currentSrc = player.audio.src;
			const isBlobUrl = currentSrc && currentSrc.startsWith("blob:");

			if (isBlobUrl && player.audio.readyState === 0) {
				// Blob URL expired, re-load the track and restore position
				if (player.currentIndex >= 0 && player.playlist.length > 0) {
					const savedTime = parseFloat(localStorage.getItem('vectrola-last-position') || '0');
					this.playTrack(player.currentIndex);
					// Restore position after new blob loads
					if (savedTime > 0) {
						player.audio.addEventListener('canplay', () => {
							player.audio.currentTime = savedTime;
						}, { once: true });
					}
					return;
				}
			}

			player.audio.play().catch(e => {
				console.error("Playback failed:", e);
				// If play fails, try re-loading the track
				if (player.currentIndex >= 0 && player.playlist.length > 0) {
					const savedTime = parseFloat(localStorage.getItem('vectrola-last-position') || '0');
					this.playTrack(player.currentIndex);
					if (savedTime > 0) {
						player.audio.addEventListener('canplay', () => {
							player.audio.currentTime = savedTime;
						}, { once: true });
					}
				}
			});
			player.isPlaying = true;
			if (ppBtn) setIconContent(ppBtn, 'pause');
			// Update Media Session playback state
			if ('mediaSession' in navigator) {
				navigator.mediaSession.playbackState = 'playing';
			}
			// Start marquee animation
			document.querySelector(".vectrola-track-artist-container")?.classList.add("is-playing");
			document.getElementById("vectrola-thumbnail")?.classList.add("is-playing");
			// Start equalizer animation on track rows
			document.querySelectorAll(".vectrola-track-row.is-playing").forEach(row => {
				row.classList.add("audio-playing");
			});
		}
	}

	private nextTrack() {
		const player = window.vectrolaPlayer;
		if (!player || !player.playlist.length) return;

		if (player.repeatMode === 'one') {
			// Repeat the same track
			player.audio.currentTime = 0;
			player.audio.play().catch(e => console.error("Playback failed:", e));
			return;
		}

		let nextIndex: number;
		if (player.shuffleMode) {
			const unplayed = player.playlist.map((_, i) => i).filter(i => !player.shuffleHistory.includes(i));
			if (unplayed.length === 0) {
				if (player.repeatMode === 'all') {
					player.shuffleHistory = [];
					this.nextTrack();
				}
				// If repeat is off and all played, stop
				return;
			}
			nextIndex = unplayed[Math.floor(Math.random() * unplayed.length)];
		} else {
			nextIndex = (player.currentIndex + 1) % player.playlist.length;
			if (nextIndex === 0 && player.repeatMode === 'off') {
				// End of playlist, don't wrap around
				return;
			}
		}

		// Optimistic UI update - set track info immediately
		player.currentIndex = nextIndex;
		player.currentTrack = player.playlist[nextIndex];
		console.log('[nextTrack] Setting currentIndex:', nextIndex, 'track:', player.currentTrack?.title);
		this.updateFullPlayerUI();
		const queueList = document.querySelector('.vectrola-queue-list');
		if (queueList) this.rebuildQueueList(queueList as HTMLElement);

		// Update all registered highlight updaters
		console.log('[nextTrack] Calling highlight updaters, count:', window.vectrolaHighlightUpdaters?.size || 0);
		window.vectrolaHighlightUpdaters?.forEach(fn => fn());

		// Then load and play audio in background
		this.playTrack(nextIndex);
	}

	private prevTrack() {
		const player = window.vectrolaPlayer;
		if (!player || !player.playlist.length) return;

		let prevIndex: number;
		if (player.shuffleMode && player.shuffleHistory.length > 1) {
			player.shuffleHistory.pop();
			prevIndex = player.shuffleHistory[player.shuffleHistory.length - 1];
		} else {
			prevIndex = player.currentIndex <= 0 ? player.playlist.length - 1 : player.currentIndex - 1;
		}

		// Optimistic UI update - set track info immediately
		player.currentIndex = prevIndex;
		player.currentTrack = player.playlist[prevIndex];
		console.log('[prevTrack] Setting currentIndex:', prevIndex, 'track:', player.currentTrack?.title);
		this.updateFullPlayerUI();
		const queueList = document.querySelector('.vectrola-queue-list');
		if (queueList) this.rebuildQueueList(queueList as HTMLElement);

		// Update all registered highlight updaters
		console.log('[prevTrack] Calling highlight updaters, count:', window.vectrolaHighlightUpdaters?.size || 0);
		window.vectrolaHighlightUpdaters?.forEach(fn => fn());

		// Then load and play audio in background
		this.playTrack(prevIndex);
	}

	private toggleShuffle() {
		const player = window.vectrolaPlayer;
		if (!player) return;

		player.shuffleMode = !player.shuffleMode;
		const sBtn = document.getElementById("vectrola-shuffle-btn");
		if (sBtn) {
			sBtn.classList.toggle("is-active", player.shuffleMode);
			this.flashButton(sBtn);
		}
		if (!player.shuffleMode) {
			player.shuffleHistory = [];
		} else if (player.currentIndex >= 0) {
			player.shuffleHistory = [player.currentIndex];
		}

		// Update full player UI if open
		if (document.getElementById("vectrola-full-player")) {
			this.updateFullPlayerUI();
			// Rebuild queue list to reflect current state
			const queueList = document.querySelector('.vectrola-queue-list');
			if (queueList) {
				this.rebuildQueueList(queueList as HTMLElement);
			}
		}
	}

	private toggleRepeat() {
		const player = window.vectrolaPlayer;
		if (!player) return;

		// Cycle: off -> all -> one -> off
		if (player.repeatMode === 'off') {
			player.repeatMode = 'all';
		} else if (player.repeatMode === 'all') {
			player.repeatMode = 'one';
		} else {
			player.repeatMode = 'off';
		}

		const rBtn = document.getElementById("vectrola-repeat-btn");
		if (rBtn) {
			rBtn.classList.toggle("is-active", player.repeatMode !== 'off');
			// Update icon for repeat one
			if (player.repeatMode === 'one') {
				setIconContent(rBtn, 'repeatOne');
			} else {
				setIconContent(rBtn, 'repeat');
			}
			this.flashButton(rBtn);
		}
	}

	private flashButton(btn: HTMLElement) {
		btn.classList.add("is-clicked");
		setTimeout(() => btn.classList.remove("is-clicked"), 300);
	}

	private calculatePlayerPosition(): { bottom: string; left: string; width: string } {
		const margin = 16; // Margin from edges
		let bottomPx = margin;
		let leftPx = margin;
		let rightPx = margin;

		// 1. Detect bottom UI (status bar or mobile navbar)
		if (Platform.isMobileApp) {
			const mobileNav = document.querySelector('.mobile-navbar');
			if (mobileNav) {
				const rect = mobileNav.getBoundingClientRect();
				bottomPx = window.innerHeight - rect.top + margin;
			}
		} else {
			// Desktop: detect status bar
			const statusBar = document.querySelector('.status-bar');
			if (statusBar) {
				const rect = statusBar.getBoundingClientRect();
				bottomPx = window.innerHeight - rect.top + margin;
			}
		}

		// 2. Detect left sidebar
		const leftSplit = document.querySelector('.workspace-split.mod-left-split');
		if (leftSplit) {
			const rect = leftSplit.getBoundingClientRect();
			if (rect.width > 0) {
				leftPx = rect.right + margin;
			}
		}

		// 3. Detect right sidebar
		const rightSplit = document.querySelector('.workspace-split.mod-right-split');
		if (rightSplit) {
			const rect = rightSplit.getBoundingClientRect();
			if (rect.width > 0) {
				rightPx = window.innerWidth - rect.left + margin;
			}
		}

		// 4. Calculate width for centering
		const availableWidth = window.innerWidth - leftPx - rightPx;
		const maxPlayerWidth = 800;
		const playerWidth = Math.min(availableWidth, maxPlayerWidth);
		const centeredLeft = leftPx + (availableWidth - playerWidth) / 2;

		// Add iOS safe area to bottom
		const bottomValue = Platform.isMobileApp
			? `calc(${bottomPx}px + env(safe-area-inset-bottom, 0px))`
			: `${bottomPx}px`;

		return {
			bottom: bottomValue,
			left: `${Math.max(centeredLeft, margin)}px`,
			width: `${playerWidth}px`
		};
	}

	private getMoodGradient(mood?: string): string {
		if (!mood) return "vectrola-gradient-default";
		const m = mood.toLowerCase();
		if (m.includes("melanchol") || m.includes("sad") || m.includes("sorrow")) return "vectrola-gradient-melancholic";
		if (m.includes("romantic") || m.includes("love") || m.includes("passion")) return "vectrola-gradient-romantic";
		if (m.includes("upbeat") || m.includes("party") || m.includes("dance") || m.includes("happy") || m.includes("joy")) return "vectrola-gradient-upbeat";
		if (m.includes("chill") || m.includes("relax") || m.includes("peaceful") || m.includes("calm")) return "vectrola-gradient-chill";
		return "vectrola-gradient-default";
	}

	private createThumbnail(track: TrackInfo | null): HTMLElement {
		const container = document.createElement("div");
		container.className = "vectrola-thumbnail";
		container.id = "vectrola-thumbnail";

		if (track?.artwork_url) {
			const img = document.createElement("img");
			img.src = track.artwork_url;
			img.alt = track.title;
			img.loading = "lazy";
			img.onerror = () => {
				// Fallback if image fails to load
				container.replaceChildren();
				const gradient = document.createElement("div");
				gradient.className = `vectrola-thumbnail-gradient ${this.getMoodGradient(track.mood)}`;
				setIconContent(gradient, 'music');
				container.appendChild(gradient);
			};
			container.appendChild(img);
		} else {
			const gradient = document.createElement("div");
			gradient.className = `vectrola-thumbnail-gradient ${this.getMoodGradient(track?.mood)}`;
			setIconContent(gradient, 'music');
			container.appendChild(gradient);
		}

		return container;
	}

	private createControlButton(iconName: keyof typeof ICONS, id?: string, extraClass?: string): HTMLButtonElement {
		const btn = document.createElement("button");
		btn.className = `vectrola-control-btn${extraClass ? ` ${extraClass}` : ""}`;
		if (id) btn.id = id;
		setIconContent(btn, iconName);
		btn.addEventListener("click", () => this.flashButton(btn));
		return btn;
	}

	private createControls(): HTMLElement {
		const controls = document.createElement("div");
		controls.className = "vectrola-controls";

		const player = window.vectrolaPlayer;

		// Shuffle
		const shuffleBtn = this.createControlButton("shuffle", "vectrola-shuffle-btn");
		shuffleBtn.title = "Shuffle";
		if (player?.shuffleMode) shuffleBtn.classList.add("is-active");
		shuffleBtn.addEventListener("click", () => this.toggleShuffle());

		// Previous
		const prevBtn = this.createControlButton("previous");
		prevBtn.title = "Previous";
		prevBtn.addEventListener("click", () => this.prevTrack());

		// Play/Pause (larger)
		const playPauseBtn = this.createControlButton(
			player?.isPlaying ? "pause" : "play",
			"vectrola-playpause-btn",
			"vectrola-playpause-btn"
		);
		playPauseBtn.title = "Play/Pause";
		playPauseBtn.addEventListener("click", () => this.togglePlayPause());

		// Next
		const nextBtn = this.createControlButton("next");
		nextBtn.title = "Next";
		nextBtn.addEventListener("click", () => this.nextTrack());

		// Repeat
		const repeatBtn = this.createControlButton(
			player?.repeatMode === 'one' ? "repeatOne" : "repeat",
			"vectrola-repeat-btn"
		);
		repeatBtn.title = "Repeat";
		if (player?.repeatMode !== 'off') repeatBtn.classList.add("is-active");
		repeatBtn.addEventListener("click", () => this.toggleRepeat());

		controls.append(shuffleBtn, prevBtn, playPauseBtn, nextBtn, repeatBtn);
		return controls;
	}

	private createVolumeControl(): HTMLElement {
		const container = document.createElement("div");
		container.className = "vectrola-volume";

		// Horizontal slider (to the left of button)
		const slider = document.createElement("input");
		slider.type = "range";
		slider.min = "0";
		slider.max = "100";
		slider.value = String(Math.round((window.vectrolaPlayer?.volume ?? 1) * 100));
		slider.className = "vectrola-volume-slider";
		slider.id = "vectrola-volume-slider";

		slider.addEventListener("input", (e) => {
			const value = parseInt((e.target as HTMLInputElement).value);
			if (window.vectrolaPlayer) {
				window.vectrolaPlayer.audio.volume = value / 100;
				window.vectrolaPlayer.volume = value / 100;
			}
			this.updateVolumeIcon(value);
		});

		// Prevent slider clicks from toggling visibility
		slider.addEventListener("click", (e) => e.stopPropagation());

		// Volume button
		const volumeBtn = document.createElement("button");
		volumeBtn.className = "vectrola-volume-btn";
		volumeBtn.id = "vectrola-volume-btn";
		setIconContent(volumeBtn, 'volume');
		volumeBtn.title = "Volume";

		// Click to toggle slider visibility
		volumeBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			container.classList.toggle("is-expanded");
		});

		// Click outside to close
		document.addEventListener("click", (e) => {
			if (!container.contains(e.target as Node)) {
				container.classList.remove("is-expanded");
			}
		});

		// Order: slider first (left), then button (right)
		container.append(slider, volumeBtn);
		return container;
	}

	private updateVolumeIcon(value: number) {
		const volumeBtn = document.getElementById("vectrola-volume-btn");
		if (volumeBtn) {
			setIconContent(volumeBtn, value === 0 ? 'volumeMute' : 'volume');
		}
	}

	private updateThumbnail(track: TrackInfo | null) {
		const container = document.getElementById("vectrola-thumbnail");
		if (!container) return;

		container.replaceChildren();
		container.classList.remove("is-playing");

		if (track?.artwork_url) {
			const img = document.createElement("img");
			img.src = track.artwork_url;
			img.alt = track.title;
			img.loading = "lazy";
			// Apply inline styles for mobile compatibility
			if (Platform.isMobile) {
				(img as HTMLElement).setCssStyles({
					width: '100%',
					height: '100%',
					objectFit: 'cover'
				});
			}
			img.onerror = () => {
				container.replaceChildren();
				const gradient = document.createElement("div");
				gradient.className = `vectrola-thumbnail-gradient ${this.getMoodGradient(track.mood)}`;
				setIconContent(gradient, 'music');
				if (Platform.isMobile) {
					const svg = gradient.querySelector('svg');
					if (svg) {
						svg.style.width = '19px';
						svg.style.height = '19px';
						svg.style.color = 'rgba(255,255,255,0.6)';
					}
				}
				container.appendChild(gradient);
			};
			container.appendChild(img);
		} else {
			const gradient = document.createElement("div");
			gradient.className = `vectrola-thumbnail-gradient ${this.getMoodGradient(track?.mood)}`;
			setIconContent(gradient, 'music');
			if (Platform.isMobile) {
				const svg = gradient.querySelector('svg');
				if (svg) {
					svg.style.width = '19px';
					svg.style.height = '19px';
					svg.style.color = 'rgba(255,255,255,0.6)';
				}
			}
			container.appendChild(gradient);
		}

		if (window.vectrolaPlayer?.isPlaying) {
			container.classList.add("is-playing");
		}
	}

	private showOverlay() {
		const player = window.vectrolaPlayer;
		if (!player) return;

		// Create backdrop if needed
		let backdrop = document.getElementById("vectrola-overlay-backdrop");
		if (!backdrop) {
			backdrop = document.createElement("div");
			backdrop.id = "vectrola-overlay-backdrop";
			backdrop.className = "vectrola-overlay-backdrop";
			backdrop.addEventListener("click", () => this.hideOverlay());
			document.body.appendChild(backdrop);
		}

		// Create overlay if needed
		let overlay = document.getElementById("vectrola-overlay");
		if (!overlay) {
			overlay = document.createElement("div");
			overlay.id = "vectrola-overlay";
			overlay.className = "vectrola-overlay";

			const artwork = document.createElement("div");
			artwork.className = "vectrola-overlay-artwork";
			artwork.id = "vectrola-overlay-artwork";

			const info = document.createElement("div");
			info.className = "vectrola-overlay-info";

			const title = document.createElement("div");
			title.className = "vectrola-overlay-title";
			title.id = "vectrola-overlay-title";

			const artist = document.createElement("div");
			artist.className = "vectrola-overlay-artist";
			artist.id = "vectrola-overlay-artist";

			info.append(title, artist);

			// Controls in overlay
			const controls = this.createControls();
			controls.className = "vectrola-overlay-controls";

			overlay.append(artwork, info, controls);
			document.body.appendChild(overlay);
		}

		// Update content
		this.updateOverlayContent();

		// Position above player bar
		const playerBar = document.getElementById("vectrola-global-player");
		if (playerBar) {
			const barRect = playerBar.getBoundingClientRect();
			(overlay as HTMLElement).setCssStyles({
				bottom: `${window.innerHeight - barRect.top + 16}px`,
				left: `${Math.max(16, (window.innerWidth - 300) / 2)}px`
			});
		}

		// Show with animation
		requestAnimationFrame(() => {
			backdrop?.classList.add("is-visible");
			overlay?.classList.add("is-visible");
		});

		player.overlayVisible = true;
	}

	private hideOverlay() {
		const backdrop = document.getElementById("vectrola-overlay-backdrop");
		const overlay = document.getElementById("vectrola-overlay");

		backdrop?.classList.remove("is-visible");
		overlay?.classList.remove("is-visible");

		if (window.vectrolaPlayer) {
			window.vectrolaPlayer.overlayVisible = false;
		}
	}

	private toggleOverlay() {
		const player = window.vectrolaPlayer;
		if (!player) return;

		if (player.overlayVisible) {
			this.hideOverlay();
		} else {
			this.showOverlay();
		}
	}

	private updateOverlayContent() {
		const track = window.vectrolaPlayer?.currentTrack;
		if (!track) return;

		const artwork = document.getElementById("vectrola-overlay-artwork");
		const title = document.getElementById("vectrola-overlay-title");
		const artist = document.getElementById("vectrola-overlay-artist");

		if (artwork) {
			artwork.replaceChildren();
			if (track.artwork_url) {
				const img = document.createElement("img");
				img.src = track.artwork_url;
				img.alt = track.title;
				artwork.appendChild(img);
			} else {
				const gradient = this.getMoodGradient(track.mood);
				const gradientDiv = document.createElement("div");
				gradientDiv.className = `vectrola-thumbnail-gradient ${gradient} vectrola-overlay-gradient-fallback`;
				setIconContent(gradientDiv, 'music');
				artwork.appendChild(gradientDiv);
			}
		}

		if (title) title.textContent = track.title;
		if (artist) artist.textContent = track.artist;
	}

	private ensurePlayerBar() {
		const player = window.vectrolaPlayer;
		if (!player) return;

		let playerBar = document.getElementById("vectrola-global-player");
		if (playerBar) return; // Already exists

		// Create player bar
		playerBar = document.createElement("div");
		playerBar.id = "vectrola-global-player";

		// Set dynamic position (bottom, left, width)
		const pos = this.calculatePlayerPosition();

		if (Platform.isMobile) {
			// === MOBILE PLAYER BAR - Ultra-compact pill design (iOS-style) ===
			// Use safe area inset for notched devices (iPhone X+)
			const safeBottom = 'max(70px, calc(58px + env(safe-area-inset-bottom, 12px)))';

			(playerBar as HTMLElement).setCssStyles({
				position: 'fixed',
				bottom: safeBottom,
				left: '30px',
				right: '30px',
				width: 'auto',
				background: 'rgba(28, 28, 30, 0.95)',
				borderRadius: '20px',  // Slightly smaller radius for thinner pill
				boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)',
				zIndex: '10',  // Very low so Obsidian side menu overlaps
				overflow: 'hidden',
				transition: 'transform 0.2s ease, box-shadow 0.2s ease'  // Smooth transitions
			});
			// Set backdrop filter directly on style (TypeScript doesn't know it)
			playerBar.style.setProperty('backdrop-filter', 'blur(20px)');
			playerBar.style.setProperty('-webkit-backdrop-filter', 'blur(20px)');
			// Prevent text selection on long press
			playerBar.style.setProperty('-webkit-user-select', 'none');
			playerBar.style.setProperty('user-select', 'none');
			// Touch action for better gesture handling
			playerBar.style.setProperty('touch-action', 'manipulation');

			// Progress bar at BOTTOM (inside pill)
			const progressContainer = document.createElement("div");
			progressContainer.id = "vectrola-progress-bar";
			(progressContainer as HTMLElement).setCssStyles({
				position: 'absolute',
				bottom: '0',
				left: '0',
				right: '0',
				height: '2px',  // Thinner progress bar
				background: 'rgba(255, 255, 255, 0.1)',
				cursor: 'pointer',
				borderRadius: '0 0 20px 20px'  // Match bottom corners of pill
			});

			const progressFill = document.createElement("div");
			progressFill.id = "vectrola-progress-fill";
			(progressFill as HTMLElement).setCssStyles({
				height: '100%',
				background: '#E53935',
				width: '0%',
				borderRadius: '0 0 0 20px',
				transition: 'width 0.1s linear'
			});
			progressContainer.appendChild(progressFill);

			// Click to seek
			progressContainer.addEventListener("click", (e) => {
				e.stopPropagation();
				if (player.audio.duration) {
					const rect = progressContainer.getBoundingClientRect();
					const pct = (e.clientX - rect.left) / rect.width;
					player.audio.currentTime = pct * player.audio.duration;
				}
			});

			// Content row - ultra-compact layout
			const content = document.createElement("div");
			(content as HTMLElement).setCssStyles({
				display: 'flex',
				flexDirection: 'row',
				alignItems: 'center',
				gap: '8px',
				padding: '4px 8px',
				paddingBottom: '6px'  // Account for progress bar at bottom
			});

			// Thumbnail - smaller for compact pill
			const thumbnail = document.createElement("div");
			thumbnail.id = "vectrola-thumbnail";
			thumbnail.className = "vectrola-thumbnail";  // Enable CSS animations
			(thumbnail as HTMLElement).setCssStyles({
				width: '28px',
				height: '28px',
				minWidth: '28px',
				borderRadius: '6px',
				overflow: 'hidden',
				flexShrink: '0',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				background: 'linear-gradient(135deg, #2d3436 0%, #636e72 100%)',
				position: 'relative'  // For ::after pseudo-element animation
			});
			if (player.currentTrack?.artwork_url) {
				const img = document.createElement("img");
				img.src = player.currentTrack.artwork_url;
				(img as HTMLElement).setCssStyles({
					width: '100%',
					height: '100%',
					objectFit: 'cover'
				});
				thumbnail.appendChild(img);
			} else {
				setIconContent(thumbnail, 'music');
				const svg = thumbnail.querySelector('svg');
				if (svg) {
					svg.style.width = '19px';
					svg.style.height = '19px';
					svg.style.color = 'rgba(255,255,255,0.6)';
				}
			}

			// Track info
			const trackInfo = document.createElement("div");
			(trackInfo as HTMLElement).setCssStyles({
				flex: '1',
				minWidth: '0',
				overflow: 'hidden'
			});

			// Title container with marquee support
			const titleContainer = document.createElement("div");
			titleContainer.className = "vectrola-mobile-marquee-container";

			const trackTitle = document.createElement("div");
			trackTitle.id = "vectrola-track-title";
			trackTitle.className = "vectrola-mobile-marquee-text";
			trackTitle.textContent = player.currentTrack?.title || "Select a track";
			(trackTitle as HTMLElement).setCssStyles({
				fontSize: '14px',
				fontWeight: '600',
				color: 'white',
				whiteSpace: 'nowrap',
				lineHeight: '1.3',
				textDecoration: 'none'
			});
			titleContainer.appendChild(trackTitle);

			// Artist container with marquee support
			const artistContainer = document.createElement("div");
			artistContainer.className = "vectrola-mobile-marquee-container";

			const trackArtist = document.createElement("div");
			trackArtist.id = "vectrola-track-artist";
			trackArtist.className = "vectrola-mobile-marquee-text artist-text";
			trackArtist.textContent = player.currentTrack?.artist || "";
			(trackArtist as HTMLElement).setCssStyles({
				fontSize: '12px',
				color: 'rgba(255, 255, 255, 0.6)',
				whiteSpace: 'nowrap',
				textDecoration: 'none'
			});
			artistContainer.appendChild(trackArtist);

			trackInfo.append(titleContainer, artistContainer);

			// Enable marquee scrolling for all text (Apple Music style - always scrolls)
			const enableMarquee = () => {
				setTimeout(() => {
					// Calculate scroll distance for title (or use small default for short text)
					const titleOverflow = trackTitle.scrollWidth - titleContainer.clientWidth;
					const titleDistance = titleOverflow > 0 ? titleOverflow + 10 : 20;
					trackTitle.style.setProperty('--marquee-distance', `-${titleDistance}px`);
					trackTitle.classList.add('is-scrolling');

					// Calculate scroll distance for artist (or use small default for short text)
					const artistOverflow = trackArtist.scrollWidth - artistContainer.clientWidth;
					const artistDistance = artistOverflow > 0 ? artistOverflow + 10 : 20;
					trackArtist.style.setProperty('--marquee-distance', `-${artistDistance}px`);
					trackArtist.classList.add('is-scrolling');
				}, 100); // Small delay to let DOM render
			};
			enableMarquee();

			// Mini controls - HORIZONTAL
			const miniControls = document.createElement("div");
			(miniControls as HTMLElement).setCssStyles({
				display: 'flex',
				flexDirection: 'row',
				alignItems: 'center',
				gap: '4px',
				flexShrink: '0'
			});

			// Play/Pause button - compact
			const playPauseBtn = document.createElement("button");
			playPauseBtn.id = "vectrola-playpause-btn";
			(playPauseBtn as HTMLElement).setCssStyles({
				width: '32px',
				height: '32px',
				minWidth: '32px',
				border: 'none',
				background: 'transparent',
				borderRadius: '50%',
				cursor: 'pointer',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				color: 'white',
				padding: '0'
			});
			setIconContent(playPauseBtn, player?.isPlaying ? "pause" : "play");

			playPauseBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.togglePlayPause();
			});

			// Next button - compact
			const nextBtn = document.createElement("button");
			(nextBtn as HTMLElement).setCssStyles({
				width: '32px',
				height: '32px',
				minWidth: '32px',
				border: 'none',
				background: 'transparent',
				borderRadius: '50%',
				cursor: 'pointer',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				color: 'white',
				padding: '0'
			});
			setIconContent(nextBtn, "next");
			nextBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.nextTrack();
			});

			miniControls.append(playPauseBtn, nextBtn);
			content.append(thumbnail, trackInfo, miniControls);

			// Tap on content opens full player (short tap only)
			let tapStartTime = 0;
			let tapStartX = 0;
			let tapStartY = 0;
			let isDragging = false;
			let longPressTimer: ReturnType<typeof setTimeout> | null = null;
			const LONG_PRESS_DURATION = 300;
			const TAP_MOVE_THRESHOLD = 10;
			const barEl = playerBar;  // Capture reference for closures

			const startDrag = () => {
				isDragging = true;
				barEl.style.transition = 'none';
				barEl.style.transform = 'scale(1.03)';
				barEl.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.5)';
				// Haptic feedback if available
				if (navigator.vibrate) navigator.vibrate(10);
			};

			const endDrag = () => {
				if (isDragging) {
					isDragging = false;
					barEl.style.transition = 'transform 0.2s ease, box-shadow 0.2s ease, bottom 0.2s ease';
					barEl.style.transform = 'scale(1)';
					barEl.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.4)';
					// Snap to safe bottom position if dragged too low
					const currentBottom = parseInt(barEl.style.bottom) || 20;
					if (currentBottom < 20) {
						barEl.style.bottom = '20px';
					}
				}
			};

			content.addEventListener('touchstart', (e) => {
				const touch = e.touches[0];
				tapStartTime = Date.now();
				tapStartX = touch.clientX;
				tapStartY = touch.clientY;
				longPressTimer = setTimeout(() => startDrag(), LONG_PRESS_DURATION);
				// Touch feedback - slight scale down
				barEl.style.transform = 'scale(0.98)';
				if (navigator.vibrate) navigator.vibrate(10);
			}, { passive: true });

			content.addEventListener('touchmove', (e) => {
				const touch = e.touches[0];
				const deltaX = Math.abs(touch.clientX - tapStartX);
				const deltaY = Math.abs(touch.clientY - tapStartY);

				// Cancel long press if moved before timer
				if (longPressTimer && (deltaX > TAP_MOVE_THRESHOLD || deltaY > TAP_MOVE_THRESHOLD)) {
					clearTimeout(longPressTimer);
					longPressTimer = null;
				}

				// If dragging, move the bar
				if (isDragging) {
					e.preventDefault();
					const newBottom = window.innerHeight - touch.clientY - 28; // Center on finger
					const clampedBottom = Math.max(20, Math.min(newBottom, window.innerHeight - 100));
					barEl.style.bottom = `${clampedBottom}px`;
				}
			}, { passive: false });

			content.addEventListener('touchend', (e) => {
				if (longPressTimer) {
					clearTimeout(longPressTimer);
					longPressTimer = null;
				}

				if (isDragging) {
					endDrag();
				} else {
					// Reset touch feedback scale
					barEl.style.transform = 'scale(1)';

					// Don't open full player if tap was on a button (play/pause or next)
					const target = e.target as HTMLElement;
					if (target.closest('button')) {
						return; // Let the button's click handler deal with it
					}

					// Check if it was a tap (short duration, minimal movement)
					const touch = e.changedTouches[0];
					const deltaX = Math.abs(touch.clientX - tapStartX);
					const deltaY = Math.abs(touch.clientY - tapStartY);
					const duration = Date.now() - tapStartTime;

					if (duration < 300 && deltaX < TAP_MOVE_THRESHOLD && deltaY < TAP_MOVE_THRESHOLD) {
						this.showFullPlayer();
					}
				}
			});

			content.addEventListener('touchcancel', () => {
				if (longPressTimer) {
					clearTimeout(longPressTimer);
					longPressTimer = null;
				}
				// Reset touch feedback scale
				barEl.style.transform = 'scale(1)';
				endDrag();
			});

			// Remove the simple click handler (replaced by touch handling above)
			// content.addEventListener("click", () => this.showFullPlayer());

			// Assemble
			playerBar.append(progressContainer, content);
			document.body.appendChild(playerBar);

			// Store UI references
			player.ui = {
				playerBar,
				progressFill,
				trackTitle,
				trackArtist,
				thumbnail,
				currentTime: null as any,
				totalTime: null as any,
			};

		} else {
			// === DESKTOP PLAYER BAR - Keep existing behavior ===
			playerBar.className = "vectrola-player-bar";
			(playerBar as HTMLElement).setCssStyles({
				bottom: pos.bottom,
				left: pos.left,
				width: pos.width,
				right: 'auto'
			});

			// Progress bar at TOP
			const progressContainer = document.createElement("div");
			progressContainer.className = "vectrola-progress-container";
			progressContainer.id = "vectrola-progress-bar";

			const progressFill = document.createElement("div");
			progressFill.className = "vectrola-progress-fill";
			progressFill.id = "vectrola-progress-fill";
			progressContainer.appendChild(progressFill);

			progressContainer.addEventListener("click", (e) => {
				e.stopPropagation();
				if (player.audio.duration) {
					const rect = progressContainer.getBoundingClientRect();
					const pct = (e.clientX - rect.left) / rect.width;
					player.audio.currentTime = pct * player.audio.duration;
				}
			});

			// Content row
			const content = document.createElement("div");
			content.className = "vectrola-content";

			// Thumbnail
			const thumbnail = this.createThumbnail(player.currentTrack);
			thumbnail.addEventListener("click", () => this.toggleOverlay());

			// Track info
			const trackInfo = document.createElement("div");
			trackInfo.className = "vectrola-track-info";

			const trackTitle = document.createElement("div");
			trackTitle.className = "vectrola-track-title";
			trackTitle.id = "vectrola-track-title";
			if (player.currentTrack) {
				const link = document.createElement("a");
				link.textContent = player.currentTrack.title;
				link.href = "#";
				link.addEventListener("click", (e) => {
					e.preventDefault();
					if (player.currentTrack?.link) {
						this.app.workspace.openLinkText(player.currentTrack.link, "", false);
					}
				});
				trackTitle.appendChild(link);
			} else {
				trackTitle.textContent = "Select a track";
			}

			const artistContainer = document.createElement("div");
			artistContainer.className = "vectrola-track-artist-container";
			if (player.isPlaying) artistContainer.classList.add("is-playing");

			const trackArtist = document.createElement("div");
			trackArtist.className = "vectrola-track-artist";
			trackArtist.id = "vectrola-track-artist";
			trackArtist.textContent = player.currentTrack?.artist || "";

			artistContainer.appendChild(trackArtist);
			trackInfo.append(trackTitle, artistContainer);

			// Time display
			const timeDisplay = document.createElement("div");
			timeDisplay.className = "vectrola-time";

			const currentTime = document.createElement("span");
			currentTime.className = "vectrola-time-current";
			currentTime.id = "vectrola-current-time";
			currentTime.textContent = "0:00";

			const separator = document.createElement("span");
			separator.className = "vectrola-time-separator";
			separator.textContent = "/";

			const totalTime = document.createElement("span");
			totalTime.className = "vectrola-time-total";
			totalTime.id = "vectrola-total-time";
			totalTime.textContent = "0:00";

			timeDisplay.append(currentTime, separator, totalTime);

			const controls = this.createControls();
			const volume = this.createVolumeControl();

			content.append(controls, thumbnail, trackInfo, timeDisplay, volume);
			playerBar.append(progressContainer, content);
			document.body.appendChild(playerBar);

			player.ui = {
				playerBar,
				progressFill,
				trackTitle,
				trackArtist,
				thumbnail,
				currentTime: document.getElementById("vectrola-current-time") as HTMLElement,
				totalTime: document.getElementById("vectrola-total-time") as HTMLElement,
			};

			// Draggable
			let isDragging = false;
			let dragOffset = { x: 0, y: 0 };
			const bar = playerBar;

			const canDrag = (target: HTMLElement) => {
				return !target.closest('button, input, .vectrola-progress-container, a');
			};

			bar.addEventListener('mousedown', (e) => {
				if (!canDrag(e.target as HTMLElement)) return;
				isDragging = true;
				const rect = bar.getBoundingClientRect();
				dragOffset.x = e.clientX - rect.left;
				dragOffset.y = e.clientY - rect.top;
				bar.classList.add('is-dragging');
				e.preventDefault();
			});

			document.addEventListener('mousemove', (e) => {
				if (!isDragging) return;
				const x = e.clientX - dragOffset.x;
				const y = e.clientY - dragOffset.y;
				const maxX = window.innerWidth - bar.offsetWidth;
				const maxY = window.innerHeight - bar.offsetHeight;
				(bar as HTMLElement).setCssStyles({
					left: `${Math.max(0, Math.min(x, maxX))}px`,
					top: `${Math.max(0, Math.min(y, maxY))}px`,
					bottom: 'auto'
				});
			});

			document.addEventListener('mouseup', () => {
				if (isDragging) {
					isDragging = false;
					bar.classList.remove('is-dragging');
				}
			});

			bar.addEventListener('dblclick', (e) => {
				if (!canDrag(e.target as HTMLElement)) return;
				const pos = this.calculatePlayerPosition();
				(bar as HTMLElement).setCssStyles({
					bottom: pos.bottom,
					left: pos.left,
					top: '',
					width: pos.width
				});
			});

			if (player.isPlaying) {
				thumbnail.classList.add("is-playing");
				artistContainer.classList.add("is-playing");
			}
		}

		// Update position on resize
		const updatePosition = () => {
			const barEl = document.getElementById("vectrola-global-player");
			if (barEl && !Platform.isMobile) {
				const pos = this.calculatePlayerPosition();
				(barEl as HTMLElement).setCssStyles({
					bottom: pos.bottom,
					left: pos.left,
					top: '',
					width: pos.width
				});
			}
		};

		window.addEventListener("resize", updatePosition);

		if (Platform.isMobileApp) {
			window.addEventListener("orientationchange", () => {
				setTimeout(updatePosition, 100);
			});
		}
	}

	// =========================================================================
	// Full Player Modal (Mobile) - Complete Inline Styles
	// =========================================================================

	private showFullPlayer() {
		const player = window.vectrolaPlayer;
		if (!player) return;

		// Remove existing if any
		document.getElementById("vectrola-full-player-backdrop")?.remove();
		document.getElementById("vectrola-full-player")?.remove();

		// Backdrop
		const backdrop = document.createElement("div");
		backdrop.id = "vectrola-full-player-backdrop";
		(backdrop as HTMLElement).setCssStyles({
			position: 'fixed',
			top: '0',
			left: '0',
			right: '0',
			bottom: '0',
			background: 'rgba(0, 0, 0, 0.85)',
			zIndex: '2000',
			opacity: '0',
			transition: 'opacity 0.3s ease'
		});
		backdrop.addEventListener("click", () => this.hideFullPlayer());

		// Full player container
		const fullPlayer = document.createElement("div");
		fullPlayer.id = "vectrola-full-player";
		(fullPlayer as HTMLElement).setCssStyles({
			position: 'fixed',
			left: '0',
			right: '0',
			bottom: '0',
			top: '50px',
			background: 'rgba(28, 28, 30, 0.98)',
			zIndex: '2001',
			borderRadius: '20px 20px 0 0',
			display: 'flex',
			flexDirection: 'column',
			padding: '0 20px calc(40px + env(safe-area-inset-bottom, 0px))',  // Safe area for home indicator
			overflowY: 'auto',
			transform: 'translateY(100%)',
			transition: 'transform 0.3s ease',
			overscrollBehavior: 'contain'  // Prevent scroll chaining
		});
		fullPlayer.style.setProperty('backdrop-filter', 'blur(30px)');
		fullPlayer.style.setProperty('-webkit-backdrop-filter', 'blur(30px)');
		// Prevent text selection
		fullPlayer.style.setProperty('-webkit-user-select', 'none');
		fullPlayer.style.setProperty('user-select', 'none');
		fullPlayer.style.setProperty('-webkit-backdrop-filter', 'blur(30px)');

		// Drag handle
		const dragHandle = document.createElement("div");
		(dragHandle as HTMLElement).setCssStyles({
			padding: '12px 0',
			display: 'flex',
			justifyContent: 'center',
			cursor: 'pointer'
		});
		const handleBar = document.createElement("div");
		(handleBar as HTMLElement).setCssStyles({
			width: '36px',
			height: '5px',
			background: 'rgba(255, 255, 255, 0.3)',
			borderRadius: '3px'
		});
		dragHandle.appendChild(handleBar);
		dragHandle.addEventListener("click", () => this.hideFullPlayer());

		// Header: artwork + title + actions
		const header = document.createElement("div");
		(header as HTMLElement).setCssStyles({
			display: 'flex',
			alignItems: 'center',
			gap: '16px',
			padding: '8px 0 20px'
		});

		const artwork = document.createElement("div");
		artwork.id = "vectrola-fp-artwork";
		artwork.className = "vectrola-fp-artwork";  // For pulse animation
		(artwork as HTMLElement).setCssStyles({
			width: '80px',
			height: '80px',
			minWidth: '80px',
			borderRadius: '8px',
			overflow: 'visible',  // Allow pulse border to show outside
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			background: 'linear-gradient(135deg, #2d3436 0%, #636e72 100%)',
			position: 'relative'  // For ::after pseudo-element
		});
		// Add is-playing class if currently playing
		if (player.isPlaying) {
			artwork.classList.add('is-playing');
		}
		if (player.currentTrack?.artwork_url) {
			const img = document.createElement("img");
			img.src = player.currentTrack.artwork_url;
			(img as HTMLElement).setCssStyles({
				width: '100%',
				height: '100%',
				objectFit: 'cover',
				borderRadius: '8px'
			});
			artwork.appendChild(img);
		} else {
			setIconContent(artwork, 'music');
			const svg = artwork.querySelector('svg');
			if (svg) {
				svg.style.width = '32px';
				svg.style.height = '32px';
				svg.style.color = 'rgba(255,255,255,0.6)';
			}
		}

		const headerInfo = document.createElement("div");
		(headerInfo as HTMLElement).setCssStyles({
			flex: '1',
			minWidth: '0',
			overflow: 'hidden'
		});

		const titleEl = document.createElement("div");
		titleEl.id = "vectrola-fp-title";
		titleEl.textContent = player.currentTrack?.title || "No track";
		(titleEl as HTMLElement).setCssStyles({
			fontSize: '18px',
			fontWeight: '600',
			color: 'white',
			whiteSpace: 'nowrap',
			overflow: 'hidden',
			textOverflow: 'ellipsis'
		});

		const artistEl = document.createElement("div");
		artistEl.id = "vectrola-fp-artist";
		artistEl.textContent = player.currentTrack?.artist || "";
		(artistEl as HTMLElement).setCssStyles({
			fontSize: '14px',
			color: 'rgba(255, 255, 255, 0.6)',
			whiteSpace: 'nowrap',
			overflow: 'hidden',
			textOverflow: 'ellipsis'
		});

		headerInfo.append(titleEl, artistEl);

		const headerActions = document.createElement("div");
		(headerActions as HTMLElement).setCssStyles({
			display: 'flex',
			gap: '8px'
		});

		const createHeaderBtn = (iconName: keyof typeof ICONS) => {
			const btn = document.createElement("button");
			(btn as HTMLElement).setCssStyles({
				width: '36px',
				height: '36px',
				border: 'none',
				background: 'transparent',
				color: 'rgba(255, 255, 255, 0.8)',
				borderRadius: '50%',
				cursor: 'pointer',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				padding: '0'
			});
			setIconContent(btn, iconName);
			const svg = btn.querySelector('svg');
			if (svg) {
				svg.style.width = '22px';
				svg.style.height = '22px';
			}
			return btn;
		};

		const starBtn = createHeaderBtn('star');
		const moreBtn = createHeaderBtn('more');
		moreBtn.addEventListener("click", () => {
			if (player.currentTrack?.link) {
				this.hideFullPlayer();
				this.app.workspace.openLinkText(player.currentTrack.link, "", false);
			}
		});

		headerActions.append(starBtn, moreBtn);
		header.append(artwork, headerInfo, headerActions);

		// Mode toggles: shuffle, repeat, infinity
		const modeToggles = document.createElement("div");
		(modeToggles as HTMLElement).setCssStyles({
			display: 'flex',
			gap: '8px',
			padding: '8px 0 20px'
		});

		const createModeBtn = (iconName: keyof typeof ICONS, isActive: boolean) => {
			const btn = document.createElement("button");
			(btn as HTMLElement).setCssStyles({
				flex: '1',
				height: '44px',
				border: 'none',
				background: isActive ? 'rgba(76, 217, 100, 0.2)' : 'rgba(255, 255, 255, 0.1)',
				color: isActive ? '#4CD964' : 'rgba(255, 255, 255, 0.6)',
				borderRadius: '8px',
				cursor: 'pointer',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				padding: '0'
			});
			setIconContent(btn, iconName);
			const svg = btn.querySelector('svg');
			if (svg) {
				svg.style.width = '20px';
				svg.style.height = '20px';
			}
			return btn;
		};

		const shuffleBtn = createModeBtn('shuffle', player.shuffleMode);
		shuffleBtn.addEventListener("click", () => {
			this.toggleShuffle();
			(shuffleBtn as HTMLElement).setCssStyles({
				background: player.shuffleMode ? 'rgba(76, 217, 100, 0.2)' : 'rgba(255, 255, 255, 0.1)',
				color: player.shuffleMode ? '#4CD964' : 'rgba(255, 255, 255, 0.6)'
			});
		});

		const repeatBtn = createModeBtn(player.repeatMode === 'one' ? 'repeatOne' : 'repeat', player.repeatMode !== 'off');
		repeatBtn.addEventListener("click", () => {
			this.toggleRepeat();
			setIconContent(repeatBtn, player.repeatMode === 'one' ? 'repeatOne' : 'repeat');
			const svg = repeatBtn.querySelector('svg');
			if (svg) {
				svg.style.width = '20px';
				svg.style.height = '20px';
			}
			(repeatBtn as HTMLElement).setCssStyles({
				background: player.repeatMode !== 'off' ? 'rgba(76, 217, 100, 0.2)' : 'rgba(255, 255, 255, 0.1)',
				color: player.repeatMode !== 'off' ? '#4CD964' : 'rgba(255, 255, 255, 0.6)'
			});
		});

		const infinityBtn = createModeBtn('infinity', false);

		modeToggles.append(shuffleBtn, repeatBtn, infinityBtn);

		// Queue section
		const queueSection = document.createElement("div");
		(queueSection as HTMLElement).setCssStyles({
			flex: '1',
			minHeight: '0',
			display: 'flex',
			flexDirection: 'column'
		});

		const queueHeader = document.createElement("div");
		(queueHeader as HTMLElement).setCssStyles({
			padding: '8px 0'
		});

		const queueTitle = document.createElement("div");
		queueTitle.textContent = "Continue Playing";
		(queueTitle as HTMLElement).setCssStyles({
			fontSize: '16px',
			fontWeight: '600',
			color: 'white'
		});

		const queueSubtitle = document.createElement("div");
		queueSubtitle.textContent = `From ${player.playlistSource || "Playlist"}`;
		(queueSubtitle as HTMLElement).setCssStyles({
			fontSize: '13px',
			color: 'rgba(255, 255, 255, 0.5)'
		});

		queueHeader.append(queueTitle, queueSubtitle);

		const queueList = document.createElement("div");
		queueList.className = "vectrola-queue-list";  // Add class for rebuildQueueList to find
		(queueList as HTMLElement).setCssStyles({
			flex: '1',
			overflowY: 'auto',
			minHeight: '0',  // Critical for flex scroll
			margin: '0 -20px',
			padding: '0 20px'
		});
		// Enable momentum scrolling on iOS
		queueList.style.setProperty('-webkit-overflow-scrolling', 'touch');

		// Helper to create queue item
		const createQueueItem = (track: TrackInfo, trackIdx: number, isCurrent: boolean, isPrevious: boolean) => {
			const item = document.createElement("div");
			(item as HTMLElement).setCssStyles({
				display: 'flex',
				alignItems: 'center',
				gap: '12px',
				padding: '10px 0',
				cursor: 'pointer'
			});

			const itemArt = document.createElement("div");
			(itemArt as HTMLElement).setCssStyles({
				width: '48px',
				height: '48px',
				minWidth: '48px',
				borderRadius: '6px',
				overflow: 'hidden',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				background: 'linear-gradient(135deg, #2d3436 0%, #636e72 100%)'
			});
			if (track.artwork_url) {
				const img = document.createElement("img");
				img.src = track.artwork_url;
				(img as HTMLElement).setCssStyles({
					width: '100%',
					height: '100%',
					objectFit: 'cover'
				});
				itemArt.appendChild(img);
			} else {
				setIconContent(itemArt, 'music');
				const svg = itemArt.querySelector('svg');
				if (svg) {
					svg.style.width = '20px';
					svg.style.height = '20px';
					svg.style.color = 'rgba(255,255,255,0.5)';
				}
			}

			// Track info with title and artist on separate lines for current
			const itemInfo = document.createElement("div");
			(itemInfo as HTMLElement).setCssStyles({
				flex: '1',
				minWidth: '0',
				overflow: 'hidden'
			});

			if (isCurrent) {
				// Current track: show "Now Playing" indicator + title + artist
				const nowPlaying = document.createElement("div");
				nowPlaying.textContent = "▶ Now Playing";
				(nowPlaying as HTMLElement).setCssStyles({
					fontSize: '11px',
					fontWeight: '600',
					color: '#E53935',
					marginBottom: '2px',
					textTransform: 'uppercase',
					letterSpacing: '0.5px'
				});

				const titleEl = document.createElement("div");
				titleEl.textContent = track.title;
				(titleEl as HTMLElement).setCssStyles({
					fontSize: '15px',
					fontWeight: '600',
					color: '#E53935',
					whiteSpace: 'nowrap',
					overflow: 'hidden',
					textOverflow: 'ellipsis'
				});

				const artistEl = document.createElement("div");
				artistEl.textContent = track.artist;
				(artistEl as HTMLElement).setCssStyles({
					fontSize: '13px',
					color: 'rgba(255, 255, 255, 0.6)',
					whiteSpace: 'nowrap',
					overflow: 'hidden',
					textOverflow: 'ellipsis'
				});

				itemInfo.append(nowPlaying, titleEl, artistEl);
			} else {
				// Other tracks: single line
				const textEl = document.createElement("div");
				textEl.textContent = `${track.title} - ${track.artist}`;
				(textEl as HTMLElement).setCssStyles({
					fontSize: '15px',
					color: 'rgba(255, 255, 255, 0.9)',
					whiteSpace: 'nowrap',
					overflow: 'hidden',
					textOverflow: 'ellipsis'
				});
				itemInfo.appendChild(textEl);
			}

			const dragIcon = document.createElement("div");
			(dragIcon as HTMLElement).setCssStyles({
				width: '24px',
				height: '24px',
				color: 'rgba(255, 255, 255, 0.3)',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center'
			});
			setIconContent(dragIcon, 'queue');
			const dragSvg = dragIcon.querySelector('svg');
			if (dragSvg) {
				dragSvg.style.width = '18px';
				dragSvg.style.height = '18px';
			}

			item.append(itemArt, itemInfo, dragIcon);

			// Click to play a different track
			item.addEventListener("click", () => {
				// Optimistic UI update - set track info immediately
				player.currentIndex = trackIdx;
				player.currentTrack = track;

				// Update full player header immediately (before audio loads)
				this.updateFullPlayerUI();

				// Rebuild queue to show new state
				this.rebuildQueueList(queueList);

				// Then load and play audio in background
				this.playTrack(trackIdx);
			});

			return item;
		};

		// Build queue: ALL tracks EXCEPT current (current is shown in header)
		player.playlist.forEach((track, idx) => {
			if (idx === player.currentIndex) return; // Skip current track - it's in the header
			const isPrevious = idx < player.currentIndex;
			queueList.appendChild(createQueueItem(track, idx, false, isPrevious));
		});

		// Auto-scroll to show tracks near current position
		setTimeout(() => {
			// Find the first "next" track (right after current) and scroll to it
			const nextIdx = player.currentIndex + 1;
			if (nextIdx < player.playlist.length) {
				// Account for skipped current track in DOM children
				const domIdx = nextIdx > player.currentIndex ? nextIdx - 1 : nextIdx;
				const nextItem = queueList.children[Math.min(domIdx, queueList.children.length - 1)] as HTMLElement;
				nextItem?.scrollIntoView({ block: 'start', behavior: 'auto' });
			}
		}, 50);

		queueSection.append(queueHeader, queueList);

		// Progress section
		const progressSection = document.createElement("div");
		(progressSection as HTMLElement).setCssStyles({
			padding: '16px 0'
		});

		const progressBar = document.createElement("div");
		(progressBar as HTMLElement).setCssStyles({
			height: '4px',
			background: 'rgba(255, 255, 255, 0.2)',
			borderRadius: '2px',
			cursor: 'pointer',
			overflow: 'hidden'
		});

		const progressFill = document.createElement("div");
		progressFill.id = "vectrola-fp-progress-fill";
		const pct = player.audio.duration ? (player.audio.currentTime / player.audio.duration) * 100 : 0;
		(progressFill as HTMLElement).setCssStyles({
			height: '100%',
			background: 'rgba(255, 255, 255, 0.9)',
			borderRadius: '2px',
			width: `${pct}%`,
			transition: 'width 0.1s linear'
		});
		progressBar.appendChild(progressFill);

		progressBar.addEventListener("click", (e) => {
			if (player.audio.duration) {
				const rect = progressBar.getBoundingClientRect();
				const pos = (e.clientX - rect.left) / rect.width;
				player.audio.currentTime = pos * player.audio.duration;
			}
		});

		const timeRow = document.createElement("div");
		(timeRow as HTMLElement).setCssStyles({
			display: 'flex',
			justifyContent: 'space-between',
			paddingTop: '8px',
			fontSize: '12px',
			color: 'rgba(255, 255, 255, 0.5)',
			fontVariantNumeric: 'tabular-nums'
		});

		const currentTimeEl = document.createElement("span");
		currentTimeEl.id = "vectrola-fp-current-time";
		currentTimeEl.textContent = this.formatTime(player.audio.currentTime);

		const remainingTimeEl = document.createElement("span");
		remainingTimeEl.id = "vectrola-fp-remaining-time";
		const remaining = player.audio.duration ? player.audio.duration - player.audio.currentTime : 0;
		remainingTimeEl.textContent = `-${this.formatTime(remaining)}`;

		timeRow.append(currentTimeEl, remainingTimeEl);
		progressSection.append(progressBar, timeRow);

		// Main controls: prev, play, next
		const mainControls = document.createElement("div");
		(mainControls as HTMLElement).setCssStyles({
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			gap: '32px',
			padding: '16px 0'
		});

		const createControlBtn = (iconName: keyof typeof ICONS, size: number, iconSize: number) => {
			const btn = document.createElement("button");
			(btn as HTMLElement).setCssStyles({
				width: `${size}px`,
				height: `${size}px`,
				border: 'none',
				background: 'transparent',
				color: 'white',
				borderRadius: '50%',
				cursor: 'pointer',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				padding: '0'
			});
			setIconContent(btn, iconName);
			const svg = btn.querySelector('svg');
			if (svg) {
				svg.style.width = `${iconSize}px`;
				svg.style.height = `${iconSize}px`;
			}
			return btn;
		};

		const prevBtn = createControlBtn('previous', 56, 36);
		prevBtn.addEventListener("click", () => this.prevTrack());

		const playPauseBtn = createControlBtn(player.isPlaying ? 'pause' : 'play', 72, 44);
		playPauseBtn.id = "vectrola-fp-playpause-btn";
		playPauseBtn.addEventListener("click", () => {
			this.togglePlayPause();
			setIconContent(playPauseBtn, player.isPlaying ? 'pause' : 'play');
			const svg = playPauseBtn.querySelector('svg');
			if (svg) {
				svg.style.width = '44px';
				svg.style.height = '44px';
			}
		});

		const nextBtn = createControlBtn('next', 56, 36);
		nextBtn.addEventListener("click", () => this.nextTrack());

		mainControls.append(prevBtn, playPauseBtn, nextBtn);

		// Volume section
		const volumeSection = document.createElement("div");
		(volumeSection as HTMLElement).setCssStyles({
			display: 'flex',
			alignItems: 'center',
			gap: '12px',
			padding: '8px 0 16px'
		});

		const volLow = document.createElement("span");
		(volLow as HTMLElement).setCssStyles({
			color: 'rgba(255, 255, 255, 0.4)',
			width: '24px',
			height: '24px',
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center'
		});
		setIconContent(volLow, 'volumeMute');
		const volLowSvg = volLow.querySelector('svg');
		if (volLowSvg) {
			volLowSvg.style.width = '18px';
			volLowSvg.style.height = '18px';
		}

		const volSlider = document.createElement("input");
		volSlider.type = "range";
		volSlider.min = "0";
		volSlider.max = "100";
		volSlider.value = String(Math.round((player.volume ?? 1) * 100));
		(volSlider as HTMLElement).setCssStyles({
			flex: '1',
			height: '4px',
			background: 'rgba(255, 255, 255, 0.2)',
			borderRadius: '2px',
			cursor: 'pointer'
		});
		volSlider.style.setProperty('-webkit-appearance', 'none');
		volSlider.style.setProperty('appearance', 'none');
		volSlider.addEventListener("input", (e) => {
			const value = parseInt((e.target as HTMLInputElement).value);
			player.audio.volume = value / 100;
			player.volume = value / 100;
		});

		const volHigh = document.createElement("span");
		(volHigh as HTMLElement).setCssStyles({
			color: 'rgba(255, 255, 255, 0.4)',
			width: '24px',
			height: '24px',
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center'
		});
		setIconContent(volHigh, 'volume');
		const volHighSvg = volHigh.querySelector('svg');
		if (volHighSvg) {
			volHighSvg.style.width = '18px';
			volHighSvg.style.height = '18px';
		}

		volumeSection.append(volLow, volSlider, volHigh);

		// Assemble full player
		fullPlayer.append(
			dragHandle,
			header,
			modeToggles,
			queueSection,
			progressSection,
			mainControls,
			volumeSection
		);

		document.body.append(backdrop, fullPlayer);

		// Swipe-down to dismiss gesture
		let gestureStartY = 0;
		let currentTranslateY = 0;
		let gestureStartTime = 0;
		let isGesturing = false;

		fullPlayer.addEventListener('touchstart', (e) => {
			const target = e.target as HTMLElement;
			const touchY = e.touches[0].clientY;
			const rect = fullPlayer.getBoundingClientRect();

			// Check if touch is in the drag handle area (top 60px)
			const isInDragHandle = touchY - rect.top < 60;

			// Check if touch originated inside the queue list (allow normal scrolling there)
			const isInQueueList = target.closest('.vectrola-queue-list') !== null;

			// Only start dismiss gesture if:
			// 1. Touch is in the drag handle area, OR
			// 2. Touch is NOT in queue list AND player is scrolled to top
			if (isInDragHandle || (!isInQueueList && fullPlayer.scrollTop <= 0)) {
				gestureStartY = e.touches[0].clientY;
				gestureStartTime = Date.now();
				currentTranslateY = 0;
				isGesturing = true;
			}
		}, { passive: true });

		fullPlayer.addEventListener('touchmove', (e) => {
			if (!isGesturing) return;

			const deltaY = e.touches[0].clientY - gestureStartY;

			if (deltaY > 0) {
				// Swiping down - follow finger
				currentTranslateY = deltaY;
				fullPlayer.style.transition = 'none';
				fullPlayer.style.transform = `translateY(${deltaY}px)`;
				// Fade backdrop proportionally
				const opacity = Math.max(0, 1 - (deltaY / 400));
				backdrop.style.transition = 'none';
				backdrop.style.opacity = String(opacity);
				// Prevent scroll while gesturing
				if (deltaY > 10) e.preventDefault();
			} else if (deltaY < 0) {
				// Swiping up - rubber band effect (reduced movement)
				currentTranslateY = deltaY * 0.15;
				fullPlayer.style.transition = 'none';
				fullPlayer.style.transform = `translateY(${deltaY * 0.15}px)`;
			}
		}, { passive: false });

		fullPlayer.addEventListener('touchend', () => {
			if (!isGesturing) return;
			isGesturing = false;

			const velocity = currentTranslateY / Math.max(1, Date.now() - gestureStartTime);

			fullPlayer.style.transition = 'transform 0.3s ease';
			backdrop.style.transition = 'opacity 0.3s ease';

			// Dismiss if dragged far enough OR fast enough
			if (currentTranslateY > 150 || velocity > 0.5) {
				this.hideFullPlayer();
			} else {
				// Snap back to open position
				fullPlayer.style.transform = 'translateY(0)';
				backdrop.style.opacity = '1';
			}
		});

		fullPlayer.addEventListener('touchcancel', () => {
			if (!isGesturing) return;
			isGesturing = false;
			fullPlayer.style.transition = 'transform 0.3s ease';
			backdrop.style.transition = 'opacity 0.3s ease';
			fullPlayer.style.transform = 'translateY(0)';
			backdrop.style.opacity = '1';
		});

		// Animate in
		requestAnimationFrame(() => {
			(backdrop as HTMLElement).setCssStyles({ opacity: '1' });
			(fullPlayer as HTMLElement).setCssStyles({ transform: 'translateY(0)' });
		});

		// Update progress in full player
		this.setupFullPlayerUpdates();
	}

	private hideFullPlayer() {
		const backdrop = document.getElementById("vectrola-full-player-backdrop");
		const fullPlayer = document.getElementById("vectrola-full-player");

		if (backdrop) {
			(backdrop as HTMLElement).setCssStyles({ opacity: '0' });
		}
		if (fullPlayer) {
			(fullPlayer as HTMLElement).setCssStyles({ transform: 'translateY(100%)' });
		}

		setTimeout(() => {
			backdrop?.remove();
			fullPlayer?.remove();
		}, 300);
	}

	// Rebuild queue list after track change (without closing modal)
	private rebuildQueueList(queueList: HTMLElement) {
		const player = window.vectrolaPlayer;
		if (!player) return;

		// Clear existing items
		queueList.replaceChildren();

		// Helper to create queue item (same as in showFullPlayer)
		const createQueueItem = (track: TrackInfo, trackIdx: number, isCurrent: boolean, isPrevious: boolean) => {
			const item = document.createElement("div");
			(item as HTMLElement).setCssStyles({
				display: 'flex',
				alignItems: 'center',
				gap: '12px',
				padding: '10px 0',
				cursor: 'pointer'
			});

			const itemArt = document.createElement("div");
			(itemArt as HTMLElement).setCssStyles({
				width: '48px',
				height: '48px',
				minWidth: '48px',
				borderRadius: '6px',
				overflow: 'hidden',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				background: 'linear-gradient(135deg, #2d3436 0%, #636e72 100%)'
			});
			if (track.artwork_url) {
				const img = document.createElement("img");
				img.src = track.artwork_url;
				(img as HTMLElement).setCssStyles({
					width: '100%',
					height: '100%',
					objectFit: 'cover'
				});
				itemArt.appendChild(img);
			} else {
				setIconContent(itemArt, 'music');
				const svg = itemArt.querySelector('svg');
				if (svg) {
					svg.style.width = '20px';
					svg.style.height = '20px';
					svg.style.color = 'rgba(255,255,255,0.5)';
				}
			}

			const itemInfo = document.createElement("div");
			(itemInfo as HTMLElement).setCssStyles({
				flex: '1',
				minWidth: '0',
				overflow: 'hidden'
			});

			if (isCurrent) {
				const nowPlaying = document.createElement("div");
				nowPlaying.textContent = "▶ Now Playing";
				(nowPlaying as HTMLElement).setCssStyles({
					fontSize: '11px',
					fontWeight: '600',
					color: '#E53935',
					marginBottom: '2px',
					textTransform: 'uppercase',
					letterSpacing: '0.5px'
				});

				const titleEl = document.createElement("div");
				titleEl.textContent = track.title;
				(titleEl as HTMLElement).setCssStyles({
					fontSize: '15px',
					fontWeight: '600',
					color: '#E53935',
					whiteSpace: 'nowrap',
					overflow: 'hidden',
					textOverflow: 'ellipsis'
				});

				const artistEl = document.createElement("div");
				artistEl.textContent = track.artist;
				(artistEl as HTMLElement).setCssStyles({
					fontSize: '13px',
					color: 'rgba(255, 255, 255, 0.6)',
					whiteSpace: 'nowrap',
					overflow: 'hidden',
					textOverflow: 'ellipsis'
				});

				itemInfo.append(nowPlaying, titleEl, artistEl);
			} else {
				const textEl = document.createElement("div");
				textEl.textContent = `${track.title} - ${track.artist}`;
				(textEl as HTMLElement).setCssStyles({
					fontSize: '15px',
					color: 'rgba(255, 255, 255, 0.9)',
					whiteSpace: 'nowrap',
					overflow: 'hidden',
					textOverflow: 'ellipsis'
				});
				itemInfo.appendChild(textEl);
			}

			const dragIcon = document.createElement("div");
			(dragIcon as HTMLElement).setCssStyles({
				width: '24px',
				height: '24px',
				color: 'rgba(255, 255, 255, 0.3)',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center'
			});
			setIconContent(dragIcon, 'queue');
			const dragSvg = dragIcon.querySelector('svg');
			if (dragSvg) {
				dragSvg.style.width = '18px';
				dragSvg.style.height = '18px';
			}

			item.append(itemArt, itemInfo, dragIcon);

			item.addEventListener("click", () => {
				// Optimistic UI update - set track info immediately
				player.currentIndex = trackIdx;
				player.currentTrack = track;

				// Update full player header immediately
				this.updateFullPlayerUI();

				// Rebuild queue to show new state
				this.rebuildQueueList(queueList);

				// Then load and play audio in background
				this.playTrack(trackIdx);
			});

			return item;
		};

		// Build queue: ALL tracks EXCEPT current (current is shown in header)
		player.playlist.forEach((track, idx) => {
			if (idx === player.currentIndex) return; // Skip current track
			const isPrevious = idx < player.currentIndex;
			queueList.appendChild(createQueueItem(track, idx, false, isPrevious));
		});

		// Auto-scroll to show tracks near current position
		setTimeout(() => {
			const nextIdx = player.currentIndex + 1;
			if (nextIdx < player.playlist.length && queueList.children.length > 0) {
				// First child after current is at index 0 if current was skipped
				const firstNextItem = queueList.children[0] as HTMLElement;
				firstNextItem?.scrollIntoView({ block: 'start', behavior: 'auto' });
			}
		}, 50);
	}

	private updateFullPlayerUI() {
		const player = window.vectrolaPlayer;
		if (!player) return;

		const titleEl = document.getElementById("vectrola-fp-title");
		const artistEl = document.getElementById("vectrola-fp-artist");
		const artwork = document.getElementById("vectrola-fp-artwork");

		if (titleEl) titleEl.textContent = player.currentTrack?.title || "No track";
		if (artistEl) artistEl.textContent = player.currentTrack?.artist || "";

		if (artwork) {
			artwork.replaceChildren();
			if (player.currentTrack?.artwork_url) {
				const img = document.createElement("img");
				img.src = player.currentTrack.artwork_url;
				(img as HTMLElement).setCssStyles({
					width: '100%',
					height: '100%',
					objectFit: 'cover',
					borderRadius: '8px'
				});
				artwork.appendChild(img);
			} else {
				setIconContent(artwork as HTMLElement, 'music');
				const svg = artwork.querySelector('svg');
				if (svg) {
					svg.style.width = '32px';
					svg.style.height = '32px';
					svg.style.color = 'rgba(255,255,255,0.6)';
				}
			}
			// Update pulse animation based on playing state
			if (player.isPlaying) {
				artwork.classList.add('is-playing');
			} else {
				artwork.classList.remove('is-playing');
			}
		}
	}

	private setupFullPlayerUpdates() {
		const player = window.vectrolaPlayer;
		if (!player) return;

		const updateFn = () => {
			const progressFill = document.getElementById("vectrola-fp-progress-fill");
			const currentTimeEl = document.getElementById("vectrola-fp-current-time");
			const remainingTimeEl = document.getElementById("vectrola-fp-remaining-time");
			const playPauseBtn = document.getElementById("vectrola-fp-playpause-btn");

			if (progressFill && player.audio.duration) {
				progressFill.style.width = `${(player.audio.currentTime / player.audio.duration) * 100}%`;
			}
			if (currentTimeEl) {
				currentTimeEl.textContent = this.formatTime(player.audio.currentTime);
			}
			if (remainingTimeEl && player.audio.duration) {
				const remaining = player.audio.duration - player.audio.currentTime;
				remainingTimeEl.textContent = `-${this.formatTime(remaining)}`;
			}
			if (playPauseBtn) {
				setIconContent(playPauseBtn, player.isPlaying ? "pause" : "play");
				const svg = playPauseBtn.querySelector('svg');
				if (svg) {
					svg.style.width = '36px';
					svg.style.height = '36px';
				}
			}

			// Update header artwork pulse based on playing state
			const artwork = document.getElementById("vectrola-fp-artwork");
			if (artwork) {
				if (player.isPlaying) {
					artwork.classList.add('is-playing');
				} else {
					artwork.classList.remove('is-playing');
				}
			}

			// Continue updating if full player is visible
			if (document.getElementById("vectrola-full-player")) {
				requestAnimationFrame(updateFn);
			}
		};
		requestAnimationFrame(updateFn);
	}
}
