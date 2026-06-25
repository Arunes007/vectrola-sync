/**
 * Google Drive API operations for Vectrola Sync
 */

import { requestUrl } from "obsidian";
import { DriveFile, CancellationToken } from "./types";

// =============================================================================
// Drive Client Interface
// =============================================================================

export interface DriveClient {
	driveRequest: (endpoint: string, method?: string, body?: string | ArrayBuffer, contentType?: string) => Promise<any>;
	findOrCreateFolder: (path: string) => Promise<string>;
	listDriveFiles: (folderId: string) => Promise<DriveFile[]>;
	downloadFile: (fileId: string) => Promise<string>;
	downloadFileBuffer: (fileId: string, token?: CancellationToken) => Promise<ArrayBuffer>;
	uploadFile: (name: string, content: string, parentId: string, existingFileId?: string) => Promise<string>;
}

// =============================================================================
// Drive Client Factory
// =============================================================================

export function createDriveClient(getToken: () => Promise<string | null>): DriveClient {

	const driveRequest = async (
		endpoint: string,
		method: string = "GET",
		body?: string | ArrayBuffer,
		contentType?: string
	): Promise<any> => {
		const token = await getToken();
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
	};

	const findOrCreateFolder = async (path: string): Promise<string> => {
		const parts = path.split("/").filter((p) => p);
		let parentId = "root";

		for (const part of parts) {
			// Search for existing folder
			const query = `name='${part}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
			const searchResult = await driveRequest(
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

				const created = await driveRequest(
					"files?fields=id",
					"POST",
					JSON.stringify(metadata),
					"application/json"
				);
				parentId = created.id;
			}
		}

		return parentId;
	};

	const listDriveFiles = async (folderId: string): Promise<DriveFile[]> => {
		const files: DriveFile[] = [];
		let pageToken: string | undefined;

		do {
			const query = `'${folderId}' in parents and trashed=false`;
			let url = `files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,parents)`;
			if (pageToken) {
				url += `&pageToken=${pageToken}`;
			}

			const result = await driveRequest(url);
			if (result.files) {
				files.push(...result.files);
			}
			pageToken = result.nextPageToken;
		} while (pageToken);

		return files;
	};

	const downloadFile = async (fileId: string): Promise<string> => {
		const token = await getToken();
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
	};

	const downloadFileBuffer = async (fileId: string, token?: CancellationToken): Promise<ArrayBuffer> => {
		const authToken = await getToken();
		if (!authToken) {
			throw new Error("Not authenticated with Google Drive");
		}

		// Use requestUrl (CORS-safe - routes through Electron main process)
		// Native fetch() would fail due to Google Drive CORS restrictions
		const response = await requestUrl({
			url: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
			method: "GET",
			headers: {
				Authorization: `Bearer ${authToken}`,
			},
		});

		// Check cancellation token after download completes
		// This is the "Ignore-on-Abort Guard" - bytes flew over wire, but we reject them
		// Prevents storing canceled preloads without affecting concurrent valid requests
		if (token?.isCancelled) {
			throw new DOMException("Download cancelled", "AbortError");
		}

		return response.arrayBuffer;
	};

	const uploadFile = async (
		name: string,
		content: string,
		parentId: string,
		existingFileId?: string
	): Promise<string> => {
		const token = await getToken();
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
	};

	return {
		driveRequest,
		findOrCreateFolder,
		listDriveFiles,
		downloadFile,
		downloadFileBuffer,
		uploadFile,
	};
}
