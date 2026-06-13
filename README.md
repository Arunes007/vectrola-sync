# Vectrola Sync - Obsidian Plugin

Sync your Vectrola music wiki with Google Drive across devices.

## Features

- **🚀 Seamless One-Click OAuth**: Sign in with Google - browser redirects back automatically, no copy-paste!
- **⬇️ Pull from Drive**: Download latest wiki from Google Drive to your vault
- **⬆️ Push to Drive**: Upload your vault to Google Drive
- **📊 Progress Bar**: Visual sync progress with download/skip counts
- **⏭️ Smart Caching**: Skips unchanged files using MD5 hash comparison
- **🔄 Auto-sync**: Automatically sync when vault opens or on interval
- **🎵 GDrive Playback**: Play music directly from Google Drive in your wiki

## Installation

### Manual Installation

1. Download the latest release (`main.js`, `manifest.json`, `styles.css`)
2. Create folder: `<vault>/.obsidian/plugins/vectrola-sync/`
3. Copy the files into that folder
4. Enable the plugin in Obsidian Settings → Community Plugins

### Build from Source

```bash
cd vectrola-sync
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` to your vault's plugin folder.

## Setup

### 1. Sign in with Google

1. Open Obsidian Settings → Vectrola Sync
2. Click **"Sign in with Google"**
3. Browser opens → Sign in with your Google account
4. **Browser automatically redirects back to Obsidian** ✨
5. Done! Settings update to show "Connected" status

No copy-paste required. No Client ID or Client Secret needed.

### 2. Configure Settings (Optional)

| Setting | Description | Default |
|---------|-------------|---------|
| Drive Folder Path | Where wiki is stored in Drive | `/Vectrola/wiki` |
| Auto-sync on open | Pull from Drive when vault opens | On |
| Sync interval | Auto-sync frequency in minutes | 5 |

### 3. Sync Your Wiki

**From Vectrola CLI:**
```bash
vectrola wiki --sync
```

**In Obsidian:**
- Click the sync icon (🔄) in the ribbon
- Or use command palette: "Vectrola Sync: Pull wiki from Google Drive"

## Commands

| Command | Description |
|---------|-------------|
| Pull wiki from Google Drive | Download latest wiki |
| Push wiki to Google Drive | Upload current vault |
| Sign in with Google Drive | Connect to Google account |
| Sign out | Disconnect and optionally clear data |

## Progress Display

During sync, you'll see a progress bar showing:
- `⬇️ X` - Files downloaded
- `⏭️ Y` - Files skipped (unchanged)
- Progress bar with `current/total` count
- Cancel button (×) to stop sync

The plugin caches file hashes, so subsequent syncs skip unchanged files for faster performance.

## How It Works

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Vectrola CLI   │────▶│  Google Drive   │◀────│ Obsidian Plugin │
│  vectrola wiki  │     │  /Vectrola/wiki │     │  Pull / Push    │
│     --sync      │     │                 │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

1. **CLI generates wiki** → `vectrola wiki --sync` creates markdown files and uploads to GDrive
2. **Plugin pulls wiki** → Downloads markdown files to your Obsidian vault
3. **Smart sync** → MD5 hash comparison skips unchanged files
4. **GDrive playback** → Wiki player streams music directly from your Google Drive

## OAuth Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Plugin    │────▶│   Google    │────▶│   Railway   │────▶│  Obsidian   │
│  (Start)    │     │   OAuth     │     │   Server    │     │  (Tokens)   │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
      │                   │                   │                   │
      │ Open browser      │ User signs in     │ Exchange code     │ obsidian://
      │ with auth URL     │ & grants access   │ for tokens        │ vectrola-auth
      └───────────────────┴───────────────────┴───────────────────┘
```

The plugin uses Obsidian's protocol handler (`obsidian://vectrola-auth`) to receive tokens directly from the OAuth server - no manual copy-paste needed!

## GDrive Music Playback

The wiki includes an interactive audio player that can play music directly from Google Drive:

1. Tracks ingested from GDrive have their file IDs stored
2. When you click play in the wiki, the plugin streams the audio from Drive
3. Works across all your devices - no local files needed!

## Troubleshooting

### "Not authenticated" error
- Go to Settings → Vectrola Sync → Click "Sign in with Google"
- Complete the OAuth flow in your browser

### Browser doesn't redirect back to Obsidian
- Make sure Obsidian is running
- Try signing out and signing in again
- Check if your browser is blocking the `obsidian://` protocol

### Files not syncing
- Check that Drive Folder Path matches what CLI uses (default: `/Vectrola/wiki`)
- Try manual Pull to see error messages

### Token expired
- Plugin auto-refreshes tokens
- If issues persist, sign out and sign in again

### Sync seems slow
- First sync downloads all files
- Subsequent syncs use caching and skip unchanged files
- Check progress bar for skip count (⏭️)

## Privacy & Security

- **No API keys required**: OAuth handled via secure server-side token exchange
- **Your credentials are safe**: Client secret never leaves the server
- **CSRF protection**: State parameter prevents cross-site request forgery
- **Tokens stored locally**: Access tokens saved in Obsidian's plugin data
- **Minimal permissions**: Only requests access to Drive files

## License

MIT
