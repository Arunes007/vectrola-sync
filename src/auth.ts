/**
 * OAuth authentication and token management for Vectrola Sync
 */

import { Notice, requestUrl, Events } from "obsidian";
import {
	VectrolaSyncSettings,
	GOOGLE_CLIENT_ID,
	OAUTH_SERVER,
	REDIRECT_URI,
	SCOPES,
} from "./types";

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
// Auth Manager Interface
// =============================================================================

export interface AuthManager {
	authenticate: () => Promise<void>;
	handleOAuthCallback: (params: Record<string, string>) => Promise<void>;
	refreshAccessToken: () => Promise<boolean>;
	getValidAccessToken: () => Promise<string | null>;
	signOut: () => Promise<void>;
	isAuthenticated: () => boolean;
	hasTokensOnly: () => boolean;
	getUserInfo: (accessToken: string) => Promise<{ email?: string }>;
	resolveDrivePath: (path: string) => Promise<string | null>;
	retryFolderDiscovery: () => Promise<void>;
}

// =============================================================================
// Auth Manager Factory
// =============================================================================

export interface AuthManagerDeps {
	settings: VectrolaSyncSettings;
	saveSettings: () => Promise<void>;
	events: Events;
	driveRequest: (endpoint: string, method?: string, body?: string | ArrayBuffer, contentType?: string) => Promise<any>;
	setupSyncInterval: () => void;
	clearSyncInterval: () => void;
}

export function createAuthManager(deps: AuthManagerDeps): AuthManager {
	let pendingAuthState: string | null = null;

	const isAuthenticated = (): boolean => {
		return !!(deps.settings.accessToken && deps.settings.wikiFolderId);
	};

	const hasTokensOnly = (): boolean => {
		return !!(deps.settings.accessToken && !deps.settings.wikiFolderId);
	};

	const authenticate = async (): Promise<void> => {
		// Generate PKCE verifier and challenge
		const codeVerifier = generateCodeVerifier();
		const codeChallenge = await generateCodeChallenge(codeVerifier);

		// Generate random state for CSRF protection
		const state = generateRandomState();
		pendingAuthState = state;

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
			pendingAuthState = null;
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
		if (deps.settings.userEmail) {
			authUrl += `&login_hint=${encodeURIComponent(deps.settings.userEmail)}`;
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
	};

	const getUserInfo = async (accessToken: string): Promise<{ email?: string }> => {
		const response = await requestUrl({
			url: "https://www.googleapis.com/oauth2/v2/userinfo",
			method: "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		});
		return response.json;
	};

	const resolveDrivePath = async (path: string): Promise<string | null> => {
		if (path === "/" || path === "") return "root";

		const parts = path.replace(/^\/+|\/+$/g, "").split("/");
		let currentId = "root";

		for (const part of parts) {
			const query = `name='${part}' and '${currentId}' in parents and trashed=false`;
			const response = await deps.driveRequest(
				`files?q=${encodeURIComponent(query)}&fields=files(id)`
			);
			const files = response?.files || [];
			if (files.length === 0) return null;
			currentId = files[0].id;
		}
		return currentId;
	};

	const handleOAuthCallback = async (params: Record<string, string>): Promise<void> => {
		const { access_token, refresh_token, expires_in, state, error } = params;

		// Verify state to prevent CSRF
		if (state !== pendingAuthState) {
			console.error("OAuth state mismatch:", { expected: pendingAuthState, received: state });
			new Notice("❌ Authentication failed: Invalid session. Please try again.");
			return;
		}

		pendingAuthState = null;

		if (error || !access_token) {
			new Notice(`❌ Authentication failed: ${error || "No token received"}`);
			return;
		}

		// Store tokens
		deps.settings.accessToken = access_token;
		if (refresh_token) {
			deps.settings.refreshToken = refresh_token;
		}
		deps.settings.tokenExpiry = Date.now() + (parseInt(expires_in) * 1000);

		// Try to get user email for login_hint
		try {
			const userInfo = await getUserInfo(access_token);
			if (userInfo.email) {
				deps.settings.userEmail = userInfo.email;
			}
		} catch {
			// Not critical, ignore
		}

		await deps.saveSettings();

		// Auto-discover Vectrola folders created by CLI
		new Notice("🔍 Looking for Vectrola folders...");

		try {
			const wikiId = await resolveDrivePath("/Vectrola/wiki");
			const audioId = await resolveDrivePath("/Vectrola/audio");

			if (!wikiId) {
				new Notice("❌ /Vectrola/wiki folder not found.\n\nRun 'vectrola wiki --sync' in terminal first to create it.", 8000);
				return;
			}

			deps.settings.wikiFolderId = wikiId;
			deps.settings.audioFolderId = audioId || "";
			await deps.saveSettings();

			deps.setupSyncInterval();
			deps.events.trigger("auth-state-changed");
			new Notice("✅ Connected to Vectrola folders!");
		} catch (e) {
			console.error("Failed to resolve Vectrola folders:", e);
			new Notice("❌ Failed to find Vectrola folders. Run 'vectrola wiki --sync' first.");
		}
	};

	const retryFolderDiscovery = async (): Promise<void> => {
		if (!deps.settings.accessToken) {
			new Notice("Please sign in first.");
			return;
		}

		new Notice("🔍 Looking for Vectrola folders...");

		try {
			const wikiId = await resolveDrivePath("/Vectrola/wiki");
			const audioId = await resolveDrivePath("/Vectrola/audio");

			if (!wikiId) {
				new Notice("❌ /Vectrola/wiki folder not found.\n\nRun 'vectrola wiki --sync' in terminal first.", 8000);
				return;
			}

			deps.settings.wikiFolderId = wikiId;
			deps.settings.audioFolderId = audioId || "";
			await deps.saveSettings();

			deps.setupSyncInterval();
			deps.events.trigger("auth-state-changed");
			new Notice("✅ Found Vectrola folders!");
		} catch (e) {
			console.error("Failed to resolve Vectrola folders:", e);
			new Notice("❌ Failed to find Vectrola folders.");
		}
	};

	const refreshAccessToken = async (): Promise<boolean> => {
		if (!deps.settings.refreshToken) {
			return false;
		}

		try {
			// Use server for refresh (has client_secret)
			const response = await requestUrl({
				url: `${OAUTH_SERVER}/auth/refresh`,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ refresh_token: deps.settings.refreshToken }),
			});

			const tokens = response.json;

			if (tokens.error) {
				throw new Error(tokens.error);
			}

			deps.settings.accessToken = tokens.access_token;
			deps.settings.tokenExpiry = Date.now() + tokens.expires_in * 1000;
			await deps.saveSettings();
			return true;
		} catch (error) {
			console.error("Token refresh failed:", error);
			return false;
		}
	};

	const getValidAccessToken = async (): Promise<string | null> => {
		// Refresh 1 minute before expiry
		if (Date.now() > deps.settings.tokenExpiry - 60000) {
			const refreshed = await refreshAccessToken();
			if (!refreshed) {
				new Notice("Session expired. Please sign in again.");
				return null;
			}
		}
		return deps.settings.accessToken;
	};

	const signOut = async (): Promise<void> => {
		deps.settings.accessToken = "";
		deps.settings.refreshToken = "";
		deps.settings.tokenExpiry = 0;
		deps.settings.userEmail = "";
		deps.settings.wikiFolderId = "";
		deps.settings.audioFolderId = "";
		await deps.saveSettings();

		deps.clearSyncInterval();
		deps.events.trigger("auth-state-changed");
		new Notice("Signed out from Google Drive.");
	};

	return {
		authenticate,
		handleOAuthCallback,
		refreshAccessToken,
		getValidAccessToken,
		signOut,
		isAuthenticated,
		hasTokensOnly,
		getUserInfo,
		resolveDrivePath,
		retryFolderDiscovery,
	};
}
