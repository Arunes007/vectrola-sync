/**
 * Audio Player Controller for Vectrola Sync
 * Handles playback, shuffle, repeat, and track navigation
 */

import { App, Notice, Platform, TFile } from "obsidian";
import { TrackInfo, VectrolaPlayerState } from "./types";
import { setIconContent } from "./icons";

// =============================================================================
// Player Controller Interface
// =============================================================================

export interface PlayerController {
	initPlayer: () => void;
	setupAudioEventListeners: () => void;
	playTrack: (index: number) => Promise<void>;
	togglePlayPause: () => void;
	nextTrack: () => void;
	prevTrack: () => void;
	toggleShuffle: () => void;
	toggleRepeat: () => void;
	formatTime: (seconds: number) => string;
	flashButton: (btn: HTMLElement) => void;
	updateThumbnail: (track: TrackInfo | null) => void;
	getMoodGradient: (mood?: string) => string;
}

// =============================================================================
// Player Controller Dependencies
// =============================================================================

export interface PlayerControllerDeps {
	app: App;
	fetchDriveFile: (fileId: string) => Promise<ArrayBuffer>;
	isAuthenticated: () => boolean;
	updateOverlayContent?: () => void;
}

// =============================================================================
// Player Controller Factory
// =============================================================================

export function createPlayerController(deps: PlayerControllerDeps): PlayerController {

	const initPlayer = () => {
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
				} catch (e) {
					console.warn('Failed to restore last track:', e);
				}
			}

			setupAudioEventListeners();
		}
	};

	const formatTime = (seconds: number): string => {
		if (isNaN(seconds)) return "0:00";
		const mins = Math.floor(seconds / 60);
		const secs = Math.floor(seconds % 60);
		return `${mins}:${secs.toString().padStart(2, "0")}`;
	};

	const setupAudioEventListeners = () => {
		const player = window.vectrolaPlayer;
		if (!player) return;

		player.audio.addEventListener("timeupdate", () => {
			const pf = document.getElementById("vectrola-progress-fill");
			const ct = document.getElementById("vectrola-current-time");
			if (player.audio.duration && pf && ct) {
				(pf as HTMLElement).setCssStyles({ width: (player.audio.currentTime / player.audio.duration) * 100 + "%" });
				ct.textContent = formatTime(player.audio.currentTime);
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
			if (tt) tt.textContent = formatTime(player.audio.duration);
		});

		player.audio.addEventListener("ended", () => nextTrack());

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
				if (player.audio.paused) togglePlayPause();
			});
			navigator.mediaSession.setActionHandler('pause', () => {
				if (!player.audio.paused) togglePlayPause();
			});
			navigator.mediaSession.setActionHandler('nexttrack', () => {
				nextTrack();
			});
			navigator.mediaSession.setActionHandler('previoustrack', () => {
				prevTrack();
			});
			navigator.mediaSession.setActionHandler('seekto', (details) => {
				if (details.seekTime !== undefined && details.seekTime !== null) {
					player.audio.currentTime = details.seekTime;
				}
			});
		}
	};

	const playTrack = async (index: number) => {
		const player = window.vectrolaPlayer;
		if (!player || index < 0 || index >= player.playlist.length) return;

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
				const file = deps.app.vault.getAbstractFileByPath(vaultPath);
				if (file instanceof TFile) {
					try {
						const buffer = await deps.app.vault.readBinary(file);
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
		if (!audioLoaded && sources.cloud?.gdrive?.file_id && deps.isAuthenticated()) {
			const gdriveId = sources.cloud.gdrive.file_id;
			try {
				const arrayBuffer = await deps.fetchDriveFile(gdriveId);
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
				const devices = Object.keys(sources.local).join(", ");
				message += `File exists on: ${devices}\n`;
				message += `Re-ingest on this device: vectrola ingest <path>`;
			} else if (hasCloudSources && !deps.isAuthenticated()) {
				message += `Available on Google Drive.\n`;
				message += `Sign in to Vectrola Sync to play.`;
			} else if (!hasLocalSources && !hasCloudSources) {
				message += `No file path found.\n`;
				message += `Run: vectrola ingest <path-to-file>`;
			} else {
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
			link.addEventListener("click", (e) => {
				e.preventDefault();
				if (track.link) {
					deps.app.workspace.openLinkText(track.link, "", false);
				}
			});
			titleEl.appendChild(link);
		}
		if (artistEl) artistEl.textContent = track.artist;
		if (ppBtn) setIconContent(ppBtn, 'pause');

		// Update thumbnail
		updateThumbnail(track);

		// Add playing animations
		thumbnail?.classList.add("is-playing");
		artistContainer?.classList.add("is-playing");

		// Update overlay if visible
		if (player.overlayVisible && deps.updateOverlayContent) {
			deps.updateOverlayContent();
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
	};

	const togglePlayPause = () => {
		const player = window.vectrolaPlayer;
		if (!player) return;

		// If no track selected, play first track
		if (player.currentIndex === -1) {
			if (player.playlist.length > 0) {
				playTrack(0);
			}
			return;
		}

		// If audio source not loaded (restored from localStorage), re-initialize track
		if (!player.audio.src && player.currentIndex >= 0 && player.playlist.length > 0) {
			playTrack(player.currentIndex);
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
			// Stop marquee animation
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
					playTrack(player.currentIndex);
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
					playTrack(player.currentIndex);
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
	};

	const nextTrack = () => {
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
					nextTrack();
				}
				// If repeat is off and all played, stop
				return;
			}
			const randomIndex = unplayed[Math.floor(Math.random() * unplayed.length)];
			playTrack(randomIndex);
		} else {
			const nextIndex = (player.currentIndex + 1) % player.playlist.length;
			if (nextIndex === 0 && player.repeatMode === 'off') {
				// End of playlist, don't wrap around
				return;
			}
			playTrack(nextIndex);
		}
	};

	const prevTrack = () => {
		const player = window.vectrolaPlayer;
		if (!player || !player.playlist.length) return;

		if (player.shuffleMode && player.shuffleHistory.length > 1) {
			player.shuffleHistory.pop();
			playTrack(player.shuffleHistory[player.shuffleHistory.length - 1]);
		} else {
			playTrack(player.currentIndex <= 0 ? player.playlist.length - 1 : player.currentIndex - 1);
		}
	};

	const toggleShuffle = () => {
		const player = window.vectrolaPlayer;
		if (!player) return;

		player.shuffleMode = !player.shuffleMode;
		const sBtn = document.getElementById("vectrola-shuffle-btn");
		if (sBtn) {
			sBtn.classList.toggle("is-active", player.shuffleMode);
			flashButton(sBtn);
		}
		if (!player.shuffleMode) {
			player.shuffleHistory = [];
		} else if (player.currentIndex >= 0) {
			player.shuffleHistory = [player.currentIndex];
		}
	};

	const toggleRepeat = () => {
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
			flashButton(rBtn);
		}
	};

	const flashButton = (btn: HTMLElement) => {
		btn.classList.add("is-clicked");
		setTimeout(() => btn.classList.remove("is-clicked"), 300);
	};

	const getMoodGradient = (mood?: string): string => {
		const moodLower = (mood || "").toLowerCase();
		if (moodLower.includes("melanchol") || moodLower.includes("sad")) {
			return "vectrola-mood-melancholic";
		} else if (moodLower.includes("romantic") || moodLower.includes("love")) {
			return "vectrola-mood-romantic";
		} else if (moodLower.includes("energetic") || moodLower.includes("upbeat") || moodLower.includes("party")) {
			return "vectrola-mood-energetic";
		} else if (moodLower.includes("calm") || moodLower.includes("peaceful") || moodLower.includes("relax")) {
			return "vectrola-mood-calm";
		} else if (moodLower.includes("dark") || moodLower.includes("intense")) {
			return "vectrola-mood-dark";
		}
		return "vectrola-mood-default";
	};

	const updateThumbnail = (track: TrackInfo | null) => {
		const thumbnail = document.getElementById("vectrola-thumbnail");
		if (!thumbnail) return;

		thumbnail.replaceChildren();
		thumbnail.className = "vectrola-thumbnail";

		if (track?.artwork_url) {
			const img = document.createElement("img");
			img.src = track.artwork_url;
			img.alt = track.title;
			thumbnail.appendChild(img);
		} else {
			thumbnail.classList.add(getMoodGradient(track?.mood));
			setIconContent(thumbnail, 'music');
		}

		if (window.vectrolaPlayer?.isPlaying) {
			thumbnail.classList.add("is-playing");
		}
	};

	return {
		initPlayer,
		setupAudioEventListeners,
		playTrack,
		togglePlayPause,
		nextTrack,
		prevTrack,
		toggleShuffle,
		toggleRepeat,
		formatTime,
		flashButton,
		updateThumbnail,
		getMoodGradient,
	};
}
