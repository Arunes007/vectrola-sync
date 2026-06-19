import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	requestUrl,
	TFile,
	Events,
	Platform,
} from "obsidian";

import { ICONS, createIcon, setIconContent } from "./icons";

// =============================================================================
// Constants
// =============================================================================

const GOOGLE_CLIENT_ID = "212647824656-9h9gchm0msibletsog338miabe9qtbe1.apps.googleusercontent.com";
const OAUTH_SERVER = "https://vectrola-oauth.up.railway.app";
const REDIRECT_URI = `${OAUTH_SERVER}/callback`;
const SCOPES = "https://www.googleapis.com/auth/drive.file";

// =============================================================================
// Types
// =============================================================================

interface VectrolaSyncSettings {
	accessToken: string;
	refreshToken: string;
	tokenExpiry: number;
	userEmail: string;
	userId: string; // Vectrola user ID (e.g., "arunes007")
	driveFolderPath: string;
	autoSyncOnOpen: boolean;
	syncIntervalMinutes: number;
	lastSyncTime: number;
	// Sync cache: maps relative path to md5 hash
	syncCache: Record<string, string>;
	// Google Picker selected folder
	selectedFolderId: string;
	selectedFolderName: string;
}

interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime: string;
	md5Checksum?: string;
	parents?: string[];
}

// Track info for audio player
interface TrackInfo {
	id: string;
	title: string;
	artist: string;
	album?: string;
	duration?: string;
	artwork_url?: string;
	sources: {
		local: Record<string, string>;  // hostname -> path
		cloud: Record<string, { file_id: string; path: string }>;
	};
	track_id?: string;
	link: string;
	mood?: string;
}

// Global player state
interface VectrolaPlayerState {
	audio: HTMLAudioElement;
	currentTrack: TrackInfo | null;
	currentIndex: number;
	isPlaying: boolean;
	shuffleMode: boolean;
	repeatMode: 'off' | 'all' | 'one';
	shuffleHistory: number[];
	playlist: TrackInfo[];
	playlistSource: string | null;
	ui: Record<string, HTMLElement> | null;
	overlayVisible: boolean;
	volume: number;
}

// Extend Window interface for global player
declare global {
	interface Window {
		vectrolaPlayer?: VectrolaPlayerState;
		vectrolaHighlightUpdaters?: Set<() => void>;
	}
}

const DEFAULT_SETTINGS: VectrolaSyncSettings = {
	accessToken: "",
	refreshToken: "",
	tokenExpiry: 0,
	userEmail: "",
	userId: "", // Vectrola user ID
	driveFolderPath: "/Vectrola/wiki",
	autoSyncOnOpen: true,
	syncIntervalMinutes: 1440,
	lastSyncTime: 0,
	syncCache: {},
	selectedFolderId: "",
	selectedFolderName: "",
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

	// Pending auth state for CSRF protection
	private pendingAuthState: string | null = null;

	// Event emitter for auth state changes
	public events: Events = new Events();

	async onload() {
		await this.loadSettings();

		// Register OAuth callback handler for obsidian://vectrola-auth
		this.registerObsidianProtocolHandler("vectrola-auth", (params) => {
			this.handleOAuthCallback(params);
		});

		// Register Picker callback handler for obsidian://vectrola-picker
		this.registerObsidianProtocolHandler("vectrola-picker", (params) => {
			this.handlePickerCallback(params);
		});

		// Register vectrola code block processor for audio player
		this.registerMarkdownCodeBlockProcessor("vectrola", (source, el, ctx) => {
			this.renderVectrolaPlayer(source, el);
		});

		// Expose API for audio player
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
		return !!(this.settings.accessToken && this.settings.refreshToken && this.settings.selectedFolderId);
	}

	// Has tokens but no folder selected (needs to complete picker)
	hasTokensOnly(): boolean {
		return !!(this.settings.accessToken && this.settings.refreshToken) && !this.settings.selectedFolderId;
	}

	// =========================================================================
	// Vectrola Audio Player Renderer
	// =========================================================================

	private renderVectrolaPlayer(source: string, container: HTMLElement) {
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
				trackListEl.querySelectorAll(".vectrola-track-row").forEach((row, i) => {
					const track = playlist[i];
					const isCurrentTrack = player.currentTrack && player.currentTrack.track_id === track.track_id;
					row.classList.toggle("is-playing", !!isCurrentTrack);
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

	private setupAudioEventListeners() {
		const player = window.vectrolaPlayer;
		if (!player) return;

		player.audio.addEventListener("timeupdate", () => {
			const pf = document.getElementById("vectrola-progress-fill");
			const ct = document.getElementById("vectrola-current-time");
			if (player.audio.duration && pf && ct) {
				(pf as HTMLElement).setCssStyles({ width: (player.audio.currentTime / player.audio.duration) * 100 + "%" });
				ct.textContent = this.formatTime(player.audio.currentTime);
			}
			// Update Media Session position state for lock screen progress bar
			if ('mediaSession' in navigator && player.audio.duration) {
				navigator.mediaSession.setPositionState({
					duration: player.audio.duration,
					playbackRate: player.audio.playbackRate,
					position: player.audio.currentTime
				});
			}
		});

		player.audio.addEventListener("loadedmetadata", () => {
			const tt = document.getElementById("vectrola-total-time");
			if (tt) tt.textContent = this.formatTime(player.audio.duration);
		});

		player.audio.addEventListener("ended", () => this.nextTrack());

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
			navigator.mediaSession.setActionHandler('play', () => {
				if (player.audio.paused) this.togglePlayPause();
			});
			navigator.mediaSession.setActionHandler('pause', () => {
				if (!player.audio.paused) this.togglePlayPause();
			});
			navigator.mediaSession.setActionHandler('nexttrack', () => {
				this.nextTrack();
			});
			navigator.mediaSession.setActionHandler('previoustrack', () => {
				this.prevTrack();
			});
			navigator.mediaSession.setActionHandler('seekto', (details) => {
				if (details.seekTime !== undefined && details.seekTime !== null) {
					player.audio.currentTime = details.seekTime;
				}
			});
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

		const track = player.playlist[index];
		const os = require("os");
		const hostname = os.hostname();

		try {
			// Clean up previous blob URL if any
			if (player.audio.src && player.audio.src.startsWith("blob:")) {
				URL.revokeObjectURL(player.audio.src);
			}

			// Resolve best playback source from sources schema
			const sources = track.sources || { local: {}, cloud: {} };
			let audioLoaded = false;

			// Priority 1: Local file on current device
			if (sources.local?.[hostname]) {
				const localPath = sources.local[hostname];
				try {
					const fs = require("fs");
					if (fs.existsSync(localPath)) {
						const buffer = fs.readFileSync(localPath);
						const blob = new Blob([buffer], { type: "audio/mpeg" });
						player.audio.src = URL.createObjectURL(blob);
						audioLoaded = true;
						console.log("Playing from local (current device):", localPath);
					}
				} catch (e) {
					console.warn("Local file not accessible:", e);
				}
			}

			// Priority 2: Local file on any device (might work if path is accessible)
			if (!audioLoaded && sources.local) {
				for (const [device, path] of Object.entries(sources.local)) {
					if (device === hostname) continue; // Already tried
					try {
						const fs = require("fs");
						if (fs.existsSync(path as string)) {
							const buffer = fs.readFileSync(path as string);
							const blob = new Blob([buffer], { type: "audio/mpeg" });
							player.audio.src = URL.createObjectURL(blob);
							audioLoaded = true;
							console.log(`Playing from local (${device}):`, path);
							break;
						}
					} catch (e) {
						// Path from another device, expected to fail
					}
				}
			}

			// Priority 3: Google Drive
			if (!audioLoaded && sources.cloud?.gdrive?.file_id) {
				const gdriveId = sources.cloud.gdrive.file_id;
				console.log("Trying GDrive playback:", gdriveId);
				try {
					if (this.isAuthenticated()) {
						const arrayBuffer = await this.fetchDriveFile(gdriveId);
						const blob = new Blob([arrayBuffer], { type: "audio/mpeg" });
						player.audio.src = URL.createObjectURL(blob);
						audioLoaded = true;
						console.log("Playing from GDrive (plugin auth):", gdriveId);
					} else {
						// Fallback: Try CLI token
						const fs = require("fs");
						const path = require("path");
						const tokenPath = path.join(os.homedir(), ".config", "vectrola", "gdrive_token.json");
						if (fs.existsSync(tokenPath)) {
							const tokenData = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
							const accessToken = tokenData.token;

							const response = await fetch(
								`https://www.googleapis.com/drive/v3/files/${gdriveId}?alt=media`,
								{ headers: { Authorization: `Bearer ${accessToken}` } }
							);

							if (response.ok) {
								const arrayBuffer = await response.arrayBuffer();
								const blob = new Blob([arrayBuffer], { type: "audio/mpeg" });
								player.audio.src = URL.createObjectURL(blob);
								audioLoaded = true;
								console.log("Playing from GDrive (CLI token):", gdriveId);
							}
						}
					}
				} catch (gdriveError) {
					console.warn("GDrive playback failed:", gdriveError);
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
				} else if (hasCloudSources && !this.isAuthenticated()) {
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
				navigator.mediaSession.metadata = new MediaMetadata({
					title: track.title,
					artist: track.artist,
					album: track.album || '',
					artwork: track.artwork_url ? [
						{ src: track.artwork_url, sizes: '512x512', type: 'image/jpeg' }
					] : []
				});
				navigator.mediaSession.playbackState = 'playing';
			}

			// Persist last played track to localStorage
			localStorage.setItem('vectrola-last-track', JSON.stringify({
				track: track,
				index: index,
				playlist: player.playlist,
				playlistSource: player.playlistSource,
				position: 0
			}));

			await player.audio.play();
			player.isPlaying = true;

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
			window.vectrolaHighlightUpdaters?.forEach(fn => fn());

			// Add audio-playing class to current track row for equalizer animation
			document.querySelectorAll(".vectrola-track-row.is-playing").forEach(row => {
				row.classList.add("audio-playing");
			});

			if (player.shuffleMode && !player.shuffleHistory.includes(index)) {
				player.shuffleHistory.push(index);
			}
		} catch (e) {
			console.error("Playback failed:", e);
			new Notice(`❌ Playback failed: ${(e as Error).message}`);
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
			if (ppBtn) setIconContent(ppBtn, 'play');
			// Update Media Session playback state
			if ('mediaSession' in navigator) {
				navigator.mediaSession.playbackState = 'paused';
			}
			// Stop marquee animation
			document.querySelector(".vectrola-track-artist-container")?.classList.remove("is-playing");
			document.getElementById("vectrola-thumbnail")?.classList.remove("is-playing");
			// Stop equalizer animation on track rows
			document.querySelectorAll(".vectrola-track-row.is-playing").forEach(row => {
				row.classList.remove("audio-playing");
			});
		} else {
			player.audio.play().catch(e => console.error("Playback failed:", e));
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
			const randomIndex = unplayed[Math.floor(Math.random() * unplayed.length)];
			this.playTrack(randomIndex);
		} else {
			const nextIndex = (player.currentIndex + 1) % player.playlist.length;
			if (nextIndex === 0 && player.repeatMode === 'off') {
				// End of playlist, don't wrap around
				return;
			}
			this.playTrack(nextIndex);
		}
	}

	private prevTrack() {
		const player = window.vectrolaPlayer;
		if (!player || !player.playlist.length) return;

		if (player.shuffleMode && player.shuffleHistory.length > 1) {
			player.shuffleHistory.pop();
			this.playTrack(player.shuffleHistory[player.shuffleHistory.length - 1]);
		} else {
			this.playTrack(player.currentIndex <= 0 ? player.playlist.length - 1 : player.currentIndex - 1);
		}
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
			img.onerror = () => {
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

		// Create player bar with CSS classes
		playerBar = document.createElement("div");
		playerBar.id = "vectrola-global-player";
		playerBar.className = "vectrola-player-bar";

		// Set dynamic position (bottom, left, width)
		const pos = this.calculatePlayerPosition();
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

		// Click to seek
		progressContainer.addEventListener("click", (e) => {
			if (player.audio.duration) {
				const rect = progressContainer.getBoundingClientRect();
				const pos = (e.clientX - rect.left) / rect.width;
				player.audio.currentTime = pos * player.audio.duration;
			}
		});

		// Content row
		const content = document.createElement("div");
		content.className = "vectrola-content";

		// Controls (LEFT side - Apple Music style)
		const controls = this.createControls();

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

		// Artist with marquee container
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

		// Volume (desktop only)
		const volume = this.createVolumeControl();

		// Assemble content: controls -> thumbnail -> info -> time -> volume
		content.append(controls, thumbnail, trackInfo, timeDisplay);
		if (!Platform.isMobile) {
			content.appendChild(volume);
		}

		// Assemble player bar
		playerBar.append(progressContainer, content);
		document.body.appendChild(playerBar);

		// Store UI references
		player.ui = {
			playerBar,
			progressFill,
			trackTitle,
			trackArtist,
			thumbnail,
			currentTime,
			totalTime,
		};

		// =========================================
		// Draggable player bar
		// =========================================
		let isDragging = false;
		let dragOffset = { x: 0, y: 0 };
		const bar = playerBar; // Capture non-null reference

		// Non-interactive elements that allow dragging
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

			// Constrain to viewport
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

		// Touch support for mobile
		bar.addEventListener('touchstart', (e) => {
			if (!canDrag(e.target as HTMLElement)) return;

			isDragging = true;
			const touch = e.touches[0];
			const rect = bar.getBoundingClientRect();
			dragOffset.x = touch.clientX - rect.left;
			dragOffset.y = touch.clientY - rect.top;
			bar.classList.add('is-dragging');
		}, { passive: true });

		document.addEventListener('touchmove', (e) => {
			if (!isDragging) return;

			const touch = e.touches[0];
			const x = touch.clientX - dragOffset.x;
			const y = touch.clientY - dragOffset.y;

			const maxX = window.innerWidth - bar.offsetWidth;
			const maxY = window.innerHeight - bar.offsetHeight;

			(bar as HTMLElement).setCssStyles({
				left: `${Math.max(0, Math.min(x, maxX))}px`,
				top: `${Math.max(0, Math.min(y, maxY))}px`,
				bottom: 'auto'
			});
		}, { passive: true });

		document.addEventListener('touchend', () => {
			if (isDragging) {
				isDragging = false;
				bar.classList.remove('is-dragging');
			}
		});

		// Double-click to reset position
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

		// Update position on resize
		const updatePosition = () => {
			const barEl = document.getElementById("vectrola-global-player");
			if (barEl) {
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

		// If already playing, add animation classes
		if (player.isPlaying) {
			thumbnail.classList.add("is-playing");
			artistContainer.classList.add("is-playing");
		}
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
		this.pendingAuthState = state;

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
			this.pendingAuthState = null;
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

		new Notice("🔐 Complete sign-in in your browser...");
		// Tokens will be received via obsidian://vectrola-auth protocol handler
	}

	// Handle OAuth callback from obsidian://vectrola-auth
	private async handleOAuthCallback(params: Record<string, string>) {
		const { access_token, refresh_token, expires_in, state, error } = params;

		// Verify state to prevent CSRF
		if (state !== this.pendingAuthState) {
			console.error("OAuth state mismatch:", { expected: this.pendingAuthState, received: state });
			new Notice("❌ Authentication failed: Invalid session. Please try again.");
			return;
		}

		// Don't clear pendingAuthState yet - we'll use it for picker too

		if (error || !access_token) {
			this.pendingAuthState = null;
			new Notice(`❌ Authentication failed: ${error || "No token received"}`);
			return;
		}

		// Store tokens
		this.settings.accessToken = access_token;
		if (refresh_token) {
			this.settings.refreshToken = refresh_token;
		}
		this.settings.tokenExpiry = Date.now() + (parseInt(expires_in) * 1000);

		// Try to get user email for login_hint
		try {
			const userInfo = await this.getUserInfo(access_token);
			if (userInfo.email) {
				this.settings.userEmail = userInfo.email;
			}
		} catch {
			// Not critical, ignore
		}

		await this.saveSettings();

		// If no folder selected yet, open picker
		if (!this.settings.selectedFolderId) {
			new Notice("🔐 Signed in! Now select your wiki folder...");
			this.openFolderPicker();
		} else {
			// Already have folder, complete auth
			this.pendingAuthState = null;
			this.setupSyncInterval();
			this.events.trigger("auth-state-changed");
			new Notice("✅ Successfully connected to Google Drive!");
		}
	}

	// Handle Picker callback from obsidian://vectrola-picker
	private async handlePickerCallback(params: Record<string, string>) {
		const { folder_id, folder_name, state, error } = params;

		// Verify state
		if (state && state !== this.pendingAuthState) {
			console.error("Picker state mismatch:", { expected: this.pendingAuthState, received: state });
			new Notice("❌ Folder selection failed: Invalid session. Please try again.");
			return;
		}

		this.pendingAuthState = null;

		if (error || !folder_id) {
			new Notice(`❌ Folder selection failed: ${error || "No folder selected"}`);
			return;
		}

		// Store selected folder
		this.settings.selectedFolderId = folder_id;
		this.settings.selectedFolderName = folder_name || "Selected Folder";
		await this.saveSettings();

		this.setupSyncInterval();
		this.events.trigger("auth-state-changed");

		new Notice(`✅ Connected to folder: ${this.settings.selectedFolderName}`);
	}

	// Get user's GDrive file IDs from Qdrant (for picker pre-selection)
	async getGdriveFileIds(): Promise<string[]> {
		if (!this.settings.userId) {
			return [];
		}
		try {
			const response = await requestUrl({
				url: `${OAUTH_SERVER}/user-files?user_id=${encodeURIComponent(this.settings.userId)}`,
				method: "GET",
				headers: {
					Authorization: `Bearer ${this.settings.accessToken}`,
				},
			});
			return response.json.file_ids || [];
		} catch (e) {
			console.warn("Could not fetch GDrive file IDs:", e);
			return [];
		}
	}

	// Open Google Picker to select folder
	async openFolderPicker() {
		// Generate a new state if not already pending (for standalone picker calls)
		if (!this.pendingAuthState) {
			this.pendingAuthState = generateRandomState();
		}

		// Get user's GDrive file IDs for pre-selection (grants access via drive.file scope)
		let fileIds: string[] = [];
		try {
			fileIds = await this.getGdriveFileIds();
			if (fileIds.length > 0) {
				console.log(`Fetched ${fileIds.length} GDrive file IDs for picker`);
			}
		} catch (e) {
			console.warn("Could not fetch file IDs:", e);
		}

		let pickerUrl = `${OAUTH_SERVER}/picker?` +
			`access_token=${encodeURIComponent(this.settings.accessToken)}` +
			`&state=${encodeURIComponent(this.pendingAuthState)}`;

		if (fileIds.length > 0) {
			pickerUrl += `&file_ids=${encodeURIComponent(fileIds.join(','))}`;
		}

		// Open as popup window (fixes third-party cookie issues)
		const width = 800;
		const height = 600;
		const left = Math.round((screen.width - width) / 2);
		const top = Math.round((screen.height - height) / 2);

		window.open(
			pickerUrl,
			'vectrola-picker',
			`width=${width},height=${height},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no`
		);
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
		this.settings.selectedFolderId = "";
		this.settings.selectedFolderName = "";
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
		const container = noticeEl.createDiv({ cls: "vectrola-sync-progress-container" });

		const headerRow = container.createDiv({ cls: "vectrola-sync-progress-header" });
		const label = headerRow.createDiv({ cls: "vectrola-sync-progress-label", text: "🔄 Syncing..." });
		const cancelBtn = headerRow.createEl("button", { cls: "vectrola-cancel-btn", text: "✕" });

		const progressBar = container.createDiv({ cls: "vectrola-sync-progress-bar" });
		const progressFill = progressBar.createDiv({ cls: "vectrola-sync-progress-fill" });
		const progressText = container.createDiv({ cls: "vectrola-sync-progress-text", text: "0/0" });

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
		(progressFill as HTMLElement).setCssStyles({ width: `${pct}%` });
		progressText.textContent = `${current}/${total}`;
	}

	async syncFromDrive() {
		if (!this.isAuthenticated()) {
			new Notice("Please sign in with Google Drive first.");
			return;
		}

		// Check if folder is selected (required with drive.file scope)
		if (!this.settings.selectedFolderId) {
			new Notice("Please select a folder first.");
			this.openFolderPicker();
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
			// Use selected folder ID directly (from Google Picker)
			const folderId = this.settings.selectedFolderId;

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

		// Check if folder is selected (required with drive.file scope)
		if (!this.settings.selectedFolderId) {
			new Notice("Please select a folder first.");
			this.openFolderPicker();
			return;
		}

		new Notice("Pushing to Google Drive...");

		try {
			// Use selected folder ID directly
			const folderId = this.settings.selectedFolderId;

			// Get all markdown files in vault
			const files = this.app.vault.getMarkdownFiles();
			let uploaded = 0;

			for (const file of files) {
				const content = await this.app.vault.read(file);

				// Find parent folder in Drive (relative to selected folder)
				const parentPath = file.parent?.path || "";
				let parentFolderId = folderId;

				if (parentPath) {
					// Create nested folders within the selected folder
					parentFolderId = await this.findOrCreateFolderInParent(folderId, parentPath);
				}

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

	// Helper to create nested folders within a parent folder
	async findOrCreateFolderInParent(parentFolderId: string, relativePath: string): Promise<string> {
		const parts = relativePath.split("/").filter((p) => p);
		let currentParentId = parentFolderId;

		for (const part of parts) {
			// Search for existing folder
			const query = `name='${part}' and '${currentParentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
			const searchResult = await this.driveRequest(
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

				const created = await this.driveRequest(
					"files?fields=id",
					"POST",
					JSON.stringify(metadata),
					"application/json"
				);
				currentParentId = created.id;
			}
		}

		return currentParentId;
	}
}

// =============================================================================
// Settings Tab
// =============================================================================

class VectrolaSyncSettingTab extends PluginSettingTab {
	plugin: VectrolaSyncPlugin;
	private authStateHandler: () => void;

	constructor(app: App, plugin: VectrolaSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;

		// Listen for auth state changes to refresh the UI
		this.authStateHandler = () => this.display();
		this.plugin.events.on("auth-state-changed", this.authStateHandler);
	}

	hide(): void {
		// Cleanup event listener when settings tab is closed
		this.plugin.events.off("auth-state-changed", this.authStateHandler);
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
		} else if (this.plugin.hasTokensOnly()) {
			// Partially authenticated - has tokens but no folder selected
			const statusBox = containerEl.createEl("div", { cls: "vectrola-status-box" });
			const statusContainer = statusBox.createEl("div", { cls: "vectrola-status-container" });
			statusContainer.createEl("span", { cls: "vectrola-status-icon", text: "⚠️" });
			const statusText = statusContainer.createEl("div", { cls: "vectrola-status-text" });
			statusText.createEl("div", { cls: "vectrola-status-title", text: "Setup incomplete" });
			statusText.createEl("div", { cls: "vectrola-status-subtitle", text: "Please select a folder to complete setup" });

			new Setting(containerEl)
				.setName("Select folder")
				.setDesc("Choose the Google Drive folder to sync with")
				.addButton((btn) =>
					btn
						.setButtonText("Select Folder")
						.setCta()
						.onClick(() => {
							this.plugin.openFolderPicker();
						})
				);

			new Setting(containerEl)
				.setName("Sign out")
				.setDesc("Start over with a different account")
				.addButton((btn) =>
					btn
						.setButtonText("Sign Out")
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

		// Vectrola User ID
		new Setting(containerEl)
			.setName("Vectrola User ID")
			.setDesc("Your Vectrola username (from 'vectrola whoami')")
			.addText((text) =>
				text
					.setPlaceholder("e.g., arunes007")
					.setValue(this.plugin.settings.userId)
					.onChange(async (value) => {
						this.plugin.settings.userId = value;
						await this.plugin.saveSettings();
					})
			);

		// Show selected folder (from Picker)
		if (this.plugin.settings.selectedFolderId) {
			new Setting(containerEl)
				.setName("Selected folder")
				.setDesc(`Syncing with: ${this.plugin.settings.selectedFolderName}`)
				.addButton((btn) =>
					btn
						.setButtonText("Change Folder")
						.onClick(() => {
							this.plugin.openFolderPicker();
						})
				);
		} else if (this.plugin.isAuthenticated()) {
			new Setting(containerEl)
				.setName("Select folder")
				.setDesc("Choose the Google Drive folder to sync with")
				.addButton((btn) =>
					btn
						.setButtonText("Select Folder")
						.setCta()
						.onClick(() => {
							this.plugin.openFolderPicker();
						})
				);
		}

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
