/**
 * Types, constants, and defaults for Vectrola Sync
 */

// =============================================================================
// Constants
// =============================================================================

export const GOOGLE_CLIENT_ID = "212647824656-9h9gchm0msibletsog338miabe9qtbe1.apps.googleusercontent.com";
export const OAUTH_SERVER = "https://vectrola-oauth.up.railway.app";
export const REDIRECT_URI = `${OAUTH_SERVER}/callback`;
export const SCOPES = "https://www.googleapis.com/auth/drive.file";

// =============================================================================
// Interfaces
// =============================================================================

export interface VectrolaSyncSettings {
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
	// Vectrola folder IDs (auto-discovered from CLI-created folders)
	wikiFolderId: string;
	audioFolderId: string;
	// Audio cache settings
	audioCacheEnabled: boolean;
	audioCacheMaxSizeMB: number;
	audioCachePreloadAhead: number;
	audioCachePreloadBehind: number;
}

export interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime: string;
	md5Checksum?: string;
	parents?: string[];
}

// Track info for audio player
export interface TrackInfo {
	id: string;
	title: string;
	artist: string;
	album?: string;
	duration?: string;
	artwork_url?: string;
	sources: {
		local: Record<string, { file_path: string; checksum: string }>;  // hostname -> {file_path, checksum}
		cloud: Record<string, { file_id: string; path: string }>;
	};
	track_id?: string;
	link: string;
	mood?: string;
}

// Cancellation token for soft-abort pattern
// Used because Obsidian's requestUrl doesn't support AbortSignal
// Each download gets a unique token reference to avoid race conditions
export interface CancellationToken {
	isCancelled: boolean;
}

// Global player state
export interface VectrolaPlayerState {
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
	endingHandled?: boolean;
}

// Public API interface for DataviewJS
export interface VectrolaSyncAPI {
	fetchDriveFile: (fileId: string) => Promise<ArrayBuffer>;
	isAuthenticated: () => boolean;
}

// =============================================================================
// Window Augmentation
// =============================================================================

declare global {
	interface Window {
		vectrolaPlayer?: VectrolaPlayerState;
		vectrolaHighlightUpdaters?: Set<() => void>;
	}
}

// =============================================================================
// Defaults
// =============================================================================

export const DEFAULT_SETTINGS: VectrolaSyncSettings = {
	accessToken: "",
	refreshToken: "",
	tokenExpiry: 0,
	userEmail: "",
	driveFolderPath: "/Vectrola/wiki",
	autoSyncOnOpen: true,
	syncIntervalMinutes: 1440,
	lastSyncTime: 0,
	syncCache: {},
	wikiFolderId: "",
	audioFolderId: "",
	// Audio cache defaults
	audioCacheEnabled: true,
	audioCacheMaxSizeMB: 100,
	audioCachePreloadAhead: 2,
	audioCachePreloadBehind: 1,
};
