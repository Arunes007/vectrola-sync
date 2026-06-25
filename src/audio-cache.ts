/**
 * Audio Cache - IndexedDB-backed cache for audio files from Google Drive
 *
 * Features:
 * - Full file caching with LRU + frequency-based eviction
 * - In-flight request deduplication (prevents duplicate downloads)
 * - CancellationToken pattern for soft-cancel (Obsidian's requestUrl doesn't support AbortSignal)
 * - High/low watermark batch eviction (not per-write)
 * - Graceful quota error handling
 */

import type { TrackInfo, CancellationToken } from "./types";

// =============================================================================
// Types
// =============================================================================

export interface AudioCacheConfig {
	maxSizeBytes: number;
	isMobile: boolean;
}

export interface CacheStats {
	totalSize: number;
	fileCount: number;
	hits: number;
	misses: number;
}

interface CacheEntry {
	file_id: string;
	buffer: ArrayBuffer;  // Store as ArrayBuffer, not Blob (WebKit IndexedDB bug)
	size: number;
	title: string;
	artist: string;
	last_accessed: number;
	access_count: number;
	created_at: number;
}

interface CacheMetadata {
	file_id: string;
	size: number;
	last_accessed: number;
	access_count: number;
}

// Download function signature - takes optional CancellationToken
type DownloadFn = (fileId: string, token?: CancellationToken) => Promise<ArrayBuffer>;

// =============================================================================
// Audio Cache Implementation
// =============================================================================

export class AudioCache {
	private db: IDBDatabase | null = null;
	private inFlightRequests: Map<string, Promise<Blob>> = new Map();

	// CancellationToken pattern: each preload gets its own unique token reference
	// This avoids the "Cancel-then-Play" race condition where a canceled preload
	// would incorrectly cancel a subsequent valid playback request for the same file
	private activePreloadTokens: Map<string, CancellationToken> = new Map();
	private preloadQueue: TrackInfo[] = [];
	private isPreloadQueueRunning: boolean = false;
	private currentPreloadDownloadFn: DownloadFn | null = null;

	private cachedFileIds: Set<string> = new Set(); // Fast existence check
	private totalCacheSize: number = 0;
	private stats = { hits: 0, misses: 0 };

	// Track files to protect from eviction (current + adjacent tracks)
	private protectedFileIds: Set<string> = new Set();

	private readonly DB_NAME = "vectrola-audio-cache";
	private readonly DB_VERSION = 1;
	private readonly STORE_NAME = "audio-files";

	constructor(private config: AudioCacheConfig) {}

	// =========================================================================
	// Initialization
	// =========================================================================

	async init(): Promise<void> {
		try {
			await this.openDatabase();
			await this.loadCacheIndex();
		} catch (e) {
			console.warn("Audio cache database corrupted, recreating:", e);
			await this.deleteDatabase();
			await this.openDatabase();
		}
	}

	private openDatabase(): Promise<void> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

			request.onerror = () => reject(request.error);

			request.onupgradeneeded = (event) => {
				const db = (event.target as IDBOpenDBRequest).result;

				if (!db.objectStoreNames.contains(this.STORE_NAME)) {
					const store = db.createObjectStore(this.STORE_NAME, {
						keyPath: "file_id",
					});
					store.createIndex("last_accessed", "last_accessed", {
						unique: false,
					});
				}
			};

			request.onsuccess = () => {
				this.db = request.result;
				resolve();
			};
		});
	}

	private deleteDatabase(): Promise<void> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.deleteDatabase(this.DB_NAME);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Load cache index into memory for fast has() checks
	 */
	private async loadCacheIndex(): Promise<void> {
		if (!this.db) return;

		return new Promise((resolve, reject) => {
			const tx = this.db!.transaction(this.STORE_NAME, "readonly");
			const store = tx.objectStore(this.STORE_NAME);
			const request = store.openCursor();

			this.cachedFileIds.clear();
			this.totalCacheSize = 0;

			request.onsuccess = (event) => {
				const cursor = (event.target as IDBRequest<IDBCursorWithValue>)
					.result;
				if (cursor) {
					const entry = cursor.value as CacheEntry;
					this.cachedFileIds.add(entry.file_id);
					this.totalCacheSize += entry.size;
					cursor.continue();
				} else {
					resolve();
				}
			};

			request.onerror = () => reject(request.error);
		});
	}

	// =========================================================================
	// Core Cache Operations
	// =========================================================================

	/**
	 * Check if file is cached (sync, fast)
	 */
	has(fileId: string): boolean {
		return this.cachedFileIds.has(fileId);
	}

	/**
	 * Set files as protected from eviction (current + adjacent tracks)
	 * Pass empty array to clear protection
	 */
	setProtected(fileIds: string[]): void {
		this.protectedFileIds.clear();
		for (const id of fileIds) {
			this.protectedFileIds.add(id);
		}
	}

	/**
	 * Main entry point - get from cache, coalesce in-flight, or download
	 * Handles deduplication automatically
	 *
	 * @param fileId - Google Drive file ID
	 * @param downloadFn - Function to download the file (receives optional CancellationToken)
	 * @param metadata - Track metadata for logging/debugging
	 * @param token - Optional CancellationToken (foreground plays typically don't need this)
	 */
	async fetchOrGet(
		fileId: string,
		downloadFn: (token?: CancellationToken) => Promise<ArrayBuffer>,
		metadata: { title: string; artist: string },
		token?: CancellationToken
	): Promise<Blob> {
		// 1. Check completed cache
		const cached = await this.get(fileId);
		if (cached) {
			this.stats.hits++;
			console.log("Cache HIT:", metadata.title);
			return cached;
		}

		// 2. Check if already downloading (coalesce requests)
		const inFlight = this.inFlightRequests.get(fileId);
		if (inFlight) {
			console.log("Coalescing in-flight request:", metadata.title);
			return inFlight;
		}

		// 3. Start new download
		this.stats.misses++;
		console.log("Cache MISS:", metadata.title);

		const downloadPromise = this.executeDownload(
			fileId,
			downloadFn,
			metadata,
			token
		);

		this.inFlightRequests.set(fileId, downloadPromise);

		try {
			return await downloadPromise;
		} finally {
			this.inFlightRequests.delete(fileId);
		}
	}

	private async executeDownload(
		fileId: string,
		downloadFn: (token?: CancellationToken) => Promise<ArrayBuffer>,
		metadata: { title: string; artist: string },
		token?: CancellationToken
	): Promise<Blob> {
		const arrayBuffer = await downloadFn(token);

		// Check cancellation after download completes
		// This is the "Ignore-on-Abort Guard" - bytes flew, but we reject them
		if (token?.isCancelled) {
			throw new DOMException("Download cancelled", "AbortError");
		}

		const blob = new Blob([arrayBuffer], { type: "audio/mpeg" });

		// Store in cache (don't await - don't block playback)
		this.put(fileId, blob, metadata).catch((e) => {
			console.warn("Failed to cache audio:", e);
		});

		return blob;
	}

	/**
	 * Get blob from cache, update access stats
	 * Reconstructs Blob from stored ArrayBuffer (WebKit IndexedDB doesn't preserve Blob properly)
	 */
	private async get(fileId: string): Promise<Blob | null> {
		if (!this.db || !this.cachedFileIds.has(fileId)) {
			return null;
		}

		return new Promise((resolve, reject) => {
			const tx = this.db!.transaction(this.STORE_NAME, "readwrite");
			const store = tx.objectStore(this.STORE_NAME);
			const request = store.get(fileId);

			request.onsuccess = () => {
				const entry = request.result as CacheEntry | undefined;
				if (!entry) {
					// Cache index out of sync
					this.cachedFileIds.delete(fileId);
					resolve(null);
					return;
				}

				// Update access stats
				entry.last_accessed = Date.now();
				entry.access_count++;
				store.put(entry);

				// Reconstruct fresh Blob from stored ArrayBuffer
				// This fixes WebKit's IndexedDB Blob serialization bug
				const blob = new Blob([entry.buffer], { type: "audio/mpeg" });
				resolve(blob);
			};

			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Store blob in cache, trigger eviction if needed
	 * Converts Blob to ArrayBuffer for storage (WebKit IndexedDB bug workaround)
	 */
	private async put(
		fileId: string,
		blob: Blob,
		metadata: { title: string; artist: string }
	): Promise<void> {
		if (!this.db) return;

		// Convert Blob to ArrayBuffer for storage
		// WebKit's IndexedDB doesn't properly serialize/deserialize Blobs
		const buffer = await blob.arrayBuffer();

		// Check if we need to evict before storing
		const newTotalSize = this.totalCacheSize + buffer.byteLength;
		if (newTotalSize > this.config.maxSizeBytes) {
			await this.evictToWatermark(buffer.byteLength);
		}

		const entry: CacheEntry = {
			file_id: fileId,
			buffer,
			size: buffer.byteLength,
			title: metadata.title,
			artist: metadata.artist,
			last_accessed: Date.now(),
			access_count: 1,
			created_at: Date.now(),
		};

		return new Promise((resolve, reject) => {
			const tx = this.db!.transaction(this.STORE_NAME, "readwrite");
			const store = tx.objectStore(this.STORE_NAME);
			const request = store.put(entry);

			request.onsuccess = () => {
				this.cachedFileIds.add(fileId);
				this.totalCacheSize += buffer.byteLength;
				console.log(
					`Cached: ${metadata.title} (${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB)`
				);
				resolve();
			};

			request.onerror = () => {
				const error = request.error;
				if (error?.name === "QuotaExceededError") {
					console.warn("Cache quota exceeded, attempting emergency eviction");
					// Emergency eviction - try to free 50% and retry once
					this.emergencyEvict()
						.then(() => this.put(fileId, blob, metadata))
						.then(resolve)
						.catch(reject);
				} else {
					reject(error);
				}
			};
		});
	}

	// =========================================================================
	// Eviction
	// =========================================================================

	/**
	 * Batch eviction: trigger at 100%, evict to 80%
	 * Uses hybrid LRU + frequency scoring
	 * Protects current + adjacent tracks from eviction
	 */
	private async evictToWatermark(incomingSize: number): Promise<void> {
		if (!this.db) return;

		// Target: 80% of max, minus incoming file
		const targetSize =
			this.config.maxSizeBytes * 0.8 - incomingSize - 10 * 1024 * 1024; // 10MB buffer

		if (this.totalCacheSize <= targetSize) return;

		const metadata = await this.getAllMetadata();
		const scored = metadata.map((m) => ({
			...m,
			score: this.evictionScore(m),
		}));

		// Sort ascending: lowest scores first (evict first)
		scored.sort((a, b) => a.score - b.score);

		const toEvict: string[] = [];
		let projectedSize = this.totalCacheSize;

		for (const entry of scored) {
			if (projectedSize <= Math.max(0, targetSize)) break;

			// Don't evict protected tracks (current + adjacent)
			if (this.protectedFileIds.has(entry.file_id)) {
				console.log(`Skipping eviction of protected track: ${entry.file_id}`);
				continue;
			}

			toEvict.push(entry.file_id);
			projectedSize -= entry.size;
		}

		if (toEvict.length === 0) return;

		console.log(`Evicting ${toEvict.length} files to reach watermark`);

		// Batch delete in single transaction
		return new Promise((resolve, reject) => {
			const tx = this.db!.transaction(this.STORE_NAME, "readwrite");
			const store = tx.objectStore(this.STORE_NAME);

			for (const fileId of toEvict) {
				store.delete(fileId);
				this.cachedFileIds.delete(fileId);
			}

			tx.oncomplete = () => {
				this.totalCacheSize = projectedSize;
				resolve();
			};

			tx.onerror = () => reject(tx.error);
		});
	}

	/**
	 * Emergency eviction when quota exceeded - clear 50%
	 */
	private async emergencyEvict(): Promise<void> {
		const targetSize = this.config.maxSizeBytes * 0.5;
		await this.evictToWatermark(
			this.totalCacheSize - targetSize + 50 * 1024 * 1024
		);
	}

	/**
	 * Eviction score: lower = evict first
	 * Combines recency (LRU) with frequency (keep popular tracks longer)
	 */
	private evictionScore(entry: CacheMetadata): number {
		const ageMs = Date.now() - entry.last_accessed;
		const ageDays = ageMs / (24 * 60 * 60 * 1000);
		const frequencyBonus = Math.log2(entry.access_count + 1) * 0.5;
		return -ageDays + frequencyBonus;
	}

	private async getAllMetadata(): Promise<CacheMetadata[]> {
		if (!this.db) return [];

		return new Promise((resolve, reject) => {
			const tx = this.db!.transaction(this.STORE_NAME, "readonly");
			const store = tx.objectStore(this.STORE_NAME);
			const request = store.openCursor();

			const metadata: CacheMetadata[] = [];

			request.onsuccess = (event) => {
				const cursor = (event.target as IDBRequest<IDBCursorWithValue>)
					.result;
				if (cursor) {
					const entry = cursor.value as CacheEntry;
					metadata.push({
						file_id: entry.file_id,
						size: entry.size,
						last_accessed: entry.last_accessed,
						access_count: entry.access_count,
					});
					cursor.continue();
				} else {
					resolve(metadata);
				}
			};

			request.onerror = () => reject(request.error);
		});
	}

	// =========================================================================
	// Preloading
	// =========================================================================

	/**
	 * Queue tracks for background preloading
	 * Each preload gets its own CancellationToken to avoid race conditions
	 */
	async preloadTracks(tracks: TrackInfo[], downloadFn: DownloadFn): Promise<void> {
		// Filter to only tracks with Google Drive sources
		const validTracks = tracks.filter(t => t.sources?.cloud?.gdrive?.file_id);
		if (validTracks.length === 0) return;

		// Store download function for queue processing
		this.currentPreloadDownloadFn = downloadFn;

		// Add to queue (don't duplicate)
		for (const track of validTracks) {
			const fileId = track.sources.cloud.gdrive.file_id;

			// Skip if already cached or already in queue
			if (this.has(fileId)) continue;
			if (this.activePreloadTokens.has(fileId)) continue;
			if (this.preloadQueue.some(t => t.sources?.cloud?.gdrive?.file_id === fileId)) continue;

			this.preloadQueue.push(track);
		}

		// Start processing if not already running
		if (!this.isPreloadQueueRunning) {
			this.isPreloadQueueRunning = true;
			this.processNextPreload();
		}
	}

	/**
	 * Process preload queue sequentially
	 * Each preload gets its own unique CancellationToken reference
	 */
	private async processNextPreload(): Promise<void> {
		if (!this.isPreloadQueueRunning || this.preloadQueue.length === 0 || !this.currentPreloadDownloadFn) {
			this.isPreloadQueueRunning = false;
			return;
		}

		const track = this.preloadQueue.shift()!;
		const fileId = track.sources?.cloud?.gdrive?.file_id;

		if (!fileId) {
			this.processNextPreload();
			return;
		}

		// Skip if already cached or already downloading
		if (this.has(fileId) || this.inFlightRequests.has(fileId)) {
			this.processNextPreload();
			return;
		}

		// Create a UNIQUE token reference for this specific preload
		// This is crucial: if we just tracked by fileId, a cancel-then-play
		// sequence would incorrectly cancel the valid playback request
		const token: CancellationToken = { isCancelled: false };
		this.activePreloadTokens.set(fileId, token);

		try {
			console.log(`Preloading: ${track.title}`);
			const arrayBuffer = await this.currentPreloadDownloadFn(fileId, token);

			// Check cancellation AFTER download (the "Ignore-on-Abort Guard")
			if (token.isCancelled) {
				throw new DOMException("Preload cancelled", "AbortError");
			}

			const blob = new Blob([arrayBuffer], { type: "audio/mpeg" });
			await this.put(fileId, blob, {
				title: track.title,
				artist: track.artist,
			});

			console.log(`Preloaded: ${track.title}`);
		} catch (e) {
			if ((e as Error).name === "AbortError") {
				console.log(`Preload cancelled: ${track.title}`);
			} else {
				console.warn(`Preload failed: ${track.title}`, e);
			}
		} finally {
			this.activePreloadTokens.delete(fileId);
		}

		// Small delay between preloads to be bandwidth-friendly
		await new Promise((r) => setTimeout(r, 100));

		// Continue with next item in queue
		this.processNextPreload();
	}

	/**
	 * Cancel all in-progress preloads by flipping their tokens
	 * The downloads will complete (can't stop requestUrl), but results will be ignored
	 */
	cancelPreload(): void {
		// Flip ALL active preload tokens - they'll throw AbortError on return
		for (const [fileId, token] of this.activePreloadTokens.entries()) {
			console.log(`Cancelling preload: ${fileId}`);
			token.isCancelled = true;
		}
		this.activePreloadTokens.clear();

		// Clear the queue
		this.preloadQueue = [];
		this.isPreloadQueueRunning = false;
	}

	// =========================================================================
	// Management
	// =========================================================================

	async getStats(): Promise<CacheStats> {
		return {
			totalSize: this.totalCacheSize,
			fileCount: this.cachedFileIds.size,
			hits: this.stats.hits,
			misses: this.stats.misses,
		};
	}

	async clear(): Promise<void> {
		if (!this.db) return;

		// Cancel any in-progress preloads
		this.cancelPreload();

		return new Promise((resolve, reject) => {
			const tx = this.db!.transaction(this.STORE_NAME, "readwrite");
			const store = tx.objectStore(this.STORE_NAME);
			const request = store.clear();

			request.onsuccess = () => {
				this.cachedFileIds.clear();
				this.totalCacheSize = 0;
				this.stats = { hits: 0, misses: 0 };
				console.log("Audio cache cleared");
				resolve();
			};

			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Close database connection (call on plugin unload)
	 */
	close(): void {
		this.cancelPreload();
		this.inFlightRequests.clear();
		this.db?.close();
		this.db = null;
	}
}
