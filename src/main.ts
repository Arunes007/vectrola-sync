import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	requestUrl,
	TFile,
	Events,
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

// Track info for audio player
interface TrackInfo {
	id: string;
	title: string;
	artist: string;
	path: string;
	gdrive_id?: string;
	track_id?: string;
	link: string;
}

// Global player state
interface VectrolaPlayerState {
	audio: HTMLAudioElement;
	currentTrack: TrackInfo | null;
	currentIndex: number;
	isPlaying: boolean;
	shuffleMode: boolean;
	shuffleHistory: number[];
	playlist: TrackInfo[];
	playlistSource: string | null;
	ui: Record<string, HTMLElement> | null;
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
		return !!(this.settings.accessToken && this.settings.refreshToken);
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
					shuffleHistory: [],
					playlist: [],
					playlistSource: null,
					ui: null,
				};
				window.vectrolaPlayer.audio.preload = "none";

				// Set up audio event listeners (only once)
				this.setupAudioEventListeners();
			}

			const player = window.vectrolaPlayer;

			// Track count
			const trackCount = container.createEl("p", { text: `${playlist.length} Tracks` });
			trackCount.style.cssText = "font-weight: bold; margin-bottom: 16px; color: var(--text-muted);";

			// Build track list
			const trackListEl = container.createEl("div");
			trackListEl.style.cssText = "margin: 16px 0;";

			// Update track highlight for this page's list
			const updateLocalHighlight = () => {
				trackListEl.querySelectorAll("div[data-index]").forEach((row, i) => {
					const track = playlist[i];
					const isCurrentTrack = player.currentTrack && player.currentTrack.path === track.path;
					row.classList.toggle("playing", !!isCurrentTrack);
					(row as HTMLElement).style.background = isCurrentTrack ? "var(--interactive-accent)" : "var(--background-secondary)";
					(row as HTMLElement).style.color = isCurrentTrack ? "var(--text-on-accent)" : "";
				});
			};

			// Local wrapper for playTrack that sets this page's playlist
			const playTrack = (index: number) => {
				player.playlist = playlist;
				player.playlistSource = pageTitle;
				this.playTrack(index);
			};

			// Render each track row
			playlist.forEach((track, i) => {
				const row = trackListEl.createEl("div");
				row.style.cssText = "display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; margin: 6px 0; border-radius: 8px; background: var(--background-secondary); cursor: pointer; transition: background 0.2s;";
				row.dataset.index = String(i);

				// Hover effect
				row.onmouseenter = () => { if (!row.classList.contains("playing")) row.style.background = "var(--background-modifier-hover)"; };
				row.onmouseleave = () => { if (!row.classList.contains("playing")) row.style.background = "var(--background-secondary)"; };

				const info = row.createEl("div");
				info.style.cssText = "flex: 1; min-width: 0;";

				const titleEl = info.createEl("div", { text: track.title });
				titleEl.style.cssText = "font-weight: 500;";

				// Source indicator (GDrive cloud icon or local icon)
				const sourceIndicator = track.gdrive_id ? "☁️" : (track.path ? "💾" : "❌");
				const artistEl = info.createEl("div", { text: `${track.artist} ${sourceIndicator}` });
				artistEl.style.cssText = "font-size: 0.85em; color: var(--text-muted);";

				const btnContainer = row.createEl("div");
				btnContainer.style.cssText = "display: flex; gap: 4px;";

				const infoBtn = btnContainer.createEl("button", { text: "ℹ️" });
				infoBtn.style.cssText = "background: none; border: none; font-size: 1.1em; cursor: pointer; padding: 6px 8px; border-radius: 6px;";
				infoBtn.title = "Track details";
				infoBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					this.app.workspace.openLinkText(track.link, "", false);
				});

				const playBtn = btnContainer.createEl("button", { text: "🎵" });
				playBtn.style.cssText = "background: none; border: none; font-size: 1.3em; cursor: pointer; padding: 6px 10px; border-radius: 6px;";

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

			// Cleanup when page unloads
			const observer = new MutationObserver(() => {
				if (!document.contains(trackListEl)) {
					window.vectrolaHighlightUpdaters?.delete(updateLocalHighlight);
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
				pf.style.width = (player.audio.currentTime / player.audio.duration) * 100 + "%";
				ct.textContent = this.formatTime(player.audio.currentTime);
			}
		});

		player.audio.addEventListener("loadedmetadata", () => {
			const tt = document.getElementById("vectrola-total-time");
			if (tt) tt.textContent = this.formatTime(player.audio.duration);
		});

		player.audio.addEventListener("ended", () => this.nextTrack());
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

		try {
			// Clean up previous blob URL if any
			if (player.audio.src && player.audio.src.startsWith("blob:")) {
				URL.revokeObjectURL(player.audio.src);
			}

			// Try GDrive first, then fall back to local file
			if (track.gdrive_id) {
				console.log("Playing from GDrive:", track.gdrive_id);
				try {
					if (this.isAuthenticated()) {
						const arrayBuffer = await this.fetchDriveFile(track.gdrive_id);
						const blob = new Blob([arrayBuffer], { type: "audio/mpeg" });
						const blobUrl = URL.createObjectURL(blob);
						player.audio.src = blobUrl;
						console.log("Playing via plugin API");
					} else {
						// Fallback: Try CLI token
						const fs = require("fs");
						const path = require("path");
						const os = require("os");

						const tokenPath = path.join(os.homedir(), ".config", "vectrola", "gdrive_token.json");
						const tokenData = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
						const accessToken = tokenData.token;

						const response = await fetch(
							`https://www.googleapis.com/drive/v3/files/${track.gdrive_id}?alt=media`,
							{ headers: { Authorization: `Bearer ${accessToken}` } }
						);

						if (!response.ok) {
							throw new Error(`GDrive fetch failed: ${response.status}`);
						}

						const arrayBuffer = await response.arrayBuffer();
						const blob = new Blob([arrayBuffer], { type: "audio/mpeg" });
						player.audio.src = URL.createObjectURL(blob);
						console.log("Playing via CLI token");
					}
				} catch (gdriveError) {
					console.error("GDrive playback failed, trying local:", gdriveError);
					if (track.path) {
						const fs = require("fs");
						const buffer = fs.readFileSync(track.path);
						const blob = new Blob([buffer], { type: "audio/mpeg" });
						player.audio.src = URL.createObjectURL(blob);
					} else {
						throw gdriveError;
					}
				}
			} else if (track.path) {
				console.log("Playing from local:", track.path);
				try {
					const fs = require("fs");
					const buffer = fs.readFileSync(track.path);
					const blob = new Blob([buffer], { type: "audio/mpeg" });
					const blobUrl = URL.createObjectURL(blob);
					player.audio.src = blobUrl;
				} catch (e) {
					console.error("Local file not found:", track.path, e);
					if (index + 1 < player.playlist.length) {
						this.playTrack(index + 1);
					}
					return;
				}
			} else {
				console.warn("No playback source for track:", track.title);
				return;
			}

			player.currentIndex = index;
			player.currentTrack = track;
			await player.audio.play();
			player.isPlaying = true;

			// Update UI
			const titleEl = document.getElementById("vectrola-track-title");
			const artistEl = document.getElementById("vectrola-track-artist");
			const ppBtn = document.getElementById("vectrola-playpause-btn");
			if (titleEl) titleEl.textContent = track.title;
			if (artistEl) artistEl.textContent = track.artist;
			if (ppBtn) ppBtn.textContent = "⏸";

			// Update all registered highlight updaters
			window.vectrolaHighlightUpdaters?.forEach(fn => fn());

			if (player.shuffleMode && !player.shuffleHistory.includes(index)) {
				player.shuffleHistory.push(index);
			}
		} catch (e) {
			console.error("Playback failed:", e);
		}
	}

	private togglePlayPause() {
		const player = window.vectrolaPlayer;
		if (!player) return;

		if (player.currentIndex === -1) {
			if (player.playlist.length > 0) {
				this.playTrack(0);
			}
			return;
		}

		const ppBtn = document.getElementById("vectrola-playpause-btn");
		if (player.isPlaying) {
			player.audio.pause();
			player.isPlaying = false;
			if (ppBtn) ppBtn.textContent = "▶";
		} else {
			player.audio.play().catch(e => console.error("Playback failed:", e));
			player.isPlaying = true;
			if (ppBtn) ppBtn.textContent = "⏸";
		}
	}

	private nextTrack() {
		const player = window.vectrolaPlayer;
		if (!player || !player.playlist.length) return;

		if (player.shuffleMode) {
			const unplayed = player.playlist.map((_, i) => i).filter(i => !player.shuffleHistory.includes(i));
			if (unplayed.length === 0) {
				player.shuffleHistory = [];
				this.nextTrack();
				return;
			}
			const randomIndex = unplayed[Math.floor(Math.random() * unplayed.length)];
			this.playTrack(randomIndex);
		} else {
			this.playTrack((player.currentIndex + 1) % player.playlist.length);
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
		if (sBtn) sBtn.style.color = player.shuffleMode ? "var(--interactive-accent)" : "";
		if (!player.shuffleMode) {
			player.shuffleHistory = [];
		} else if (player.currentIndex >= 0) {
			player.shuffleHistory = [player.currentIndex];
		}
	}

	private ensurePlayerBar() {
		const player = window.vectrolaPlayer;
		if (!player) return;

		let playerBar = document.getElementById("vectrola-global-player");
		if (playerBar) return; // Already exists

		// Create player bar
		playerBar = document.createElement("div");
		playerBar.id = "vectrola-global-player";
		playerBar.style.cssText = "position: fixed; bottom: 0; left: 0; right: 0; background: var(--background-secondary); border-top: 1px solid var(--background-modifier-border); padding: 12px 20px; display: flex; align-items: center; gap: 16px; z-index: 1000; box-shadow: 0 -2px 10px rgba(0,0,0,0.1);";

		// Track display
		const trackDisplay = document.createElement("div");
		trackDisplay.style.cssText = "flex: 1; min-width: 0;";

		const trackTitleEl = document.createElement("div");
		trackTitleEl.id = "vectrola-track-title";
		trackTitleEl.style.cssText = "font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";
		trackTitleEl.textContent = player.currentTrack ? player.currentTrack.title : "Select a track to play";

		const trackArtistEl = document.createElement("div");
		trackArtistEl.id = "vectrola-track-artist";
		trackArtistEl.style.cssText = "font-size: 0.85em; color: var(--text-muted);";
		trackArtistEl.textContent = player.currentTrack ? player.currentTrack.artist : "";

		trackDisplay.appendChild(trackTitleEl);
		trackDisplay.appendChild(trackArtistEl);

		// Controls
		const controls = document.createElement("div");
		controls.style.cssText = "display: flex; gap: 8px;";

		const btnStyle = "background: none; border: none; font-size: 1.5em; cursor: pointer; padding: 8px; border-radius: 50%; width: 44px; height: 44px; display: flex; align-items: center; justify-content: center;";

		const shuffleBtn = document.createElement("button");
		shuffleBtn.id = "vectrola-shuffle-btn";
		shuffleBtn.style.cssText = btnStyle;
		shuffleBtn.textContent = "🔀";
		shuffleBtn.title = "Shuffle";
		if (player.shuffleMode) shuffleBtn.style.color = "var(--interactive-accent)";

		const prevBtn = document.createElement("button");
		prevBtn.style.cssText = btnStyle;
		prevBtn.textContent = "⏮";
		prevBtn.title = "Previous";

		const playPauseBtn = document.createElement("button");
		playPauseBtn.id = "vectrola-playpause-btn";
		playPauseBtn.style.cssText = btnStyle;
		playPauseBtn.textContent = player.isPlaying ? "⏸" : "▶";
		playPauseBtn.title = "Play";

		const nextBtn = document.createElement("button");
		nextBtn.style.cssText = btnStyle;
		nextBtn.textContent = "⏭";
		nextBtn.title = "Next";

		controls.appendChild(shuffleBtn);
		controls.appendChild(prevBtn);
		controls.appendChild(playPauseBtn);
		controls.appendChild(nextBtn);

		// Progress container
		const progressContainer = document.createElement("div");
		progressContainer.style.cssText = "flex: 2; display: flex; align-items: center; gap: 8px;";

		const currentTimeEl = document.createElement("span");
		currentTimeEl.id = "vectrola-current-time";
		currentTimeEl.style.cssText = "font-size: 0.8em; color: var(--text-muted); min-width: 40px;";
		currentTimeEl.textContent = "0:00";

		const progressBarContainer = document.createElement("div");
		progressBarContainer.id = "vectrola-progress-bar";
		progressBarContainer.style.cssText = "flex: 1; height: 6px; background: var(--background-modifier-border); border-radius: 3px; cursor: pointer; position: relative;";

		const progressFill = document.createElement("div");
		progressFill.id = "vectrola-progress-fill";
		progressFill.style.cssText = "height: 100%; background: var(--interactive-accent); border-radius: 3px; width: 0%; transition: width 0.1s linear;";
		progressBarContainer.appendChild(progressFill);

		const totalTimeEl = document.createElement("span");
		totalTimeEl.id = "vectrola-total-time";
		totalTimeEl.style.cssText = "font-size: 0.8em; color: var(--text-muted); min-width: 40px;";
		totalTimeEl.textContent = "0:00";

		progressContainer.appendChild(currentTimeEl);
		progressContainer.appendChild(progressBarContainer);
		progressContainer.appendChild(totalTimeEl);

		// Assemble player bar
		playerBar.appendChild(trackDisplay);
		playerBar.appendChild(controls);
		playerBar.appendChild(progressContainer);

		// Append to body
		document.body.appendChild(playerBar);

		// Event listeners for controls
		playPauseBtn.addEventListener("click", () => this.togglePlayPause());
		nextBtn.addEventListener("click", () => this.nextTrack());
		prevBtn.addEventListener("click", () => this.prevTrack());
		shuffleBtn.addEventListener("click", () => this.toggleShuffle());

		progressBarContainer.addEventListener("click", (e) => {
			if (player.audio.duration) {
				const rect = progressBarContainer.getBoundingClientRect();
				const pos = (e.clientX - rect.left) / rect.width;
				player.audio.currentTime = pos * player.audio.duration;
			}
		});

		player.ui = { playerBar, trackTitleEl, trackArtistEl, playPauseBtn, shuffleBtn, progressFill, currentTimeEl, totalTimeEl };
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

		this.pendingAuthState = null;

		if (error || !access_token) {
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
		this.setupSyncInterval();

		// Emit auth state change event
		this.events.trigger("auth-state-changed");

		new Notice("✅ Successfully connected to Google Drive!");
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
