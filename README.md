# Vectrola Sync - Obsidian Plugin

Sync your Vectrola music wiki with Google Drive across devices.

## Features

- **Pull from Drive**: Download latest wiki from Google Drive to your vault
- **Push to Drive**: Upload your vault to Google Drive
- **Auto-sync**: Automatically sync when vault opens or on interval
- **OAuth 2.0**: Secure authentication with Google Drive

## Installation

### Manual Installation

1. Download the latest release (`main.js`, `manifest.json`, `styles.css`)
2. Create folder: `<vault>/.obsidian/plugins/vectrola-sync/`
3. Copy the files into that folder
4. Enable the plugin in Obsidian Settings → Community Plugins

### Build from Source

```bash
cd obsidian-vectrola-sync
npm install
npm run build
```

Copy `main.js` and `manifest.json` to your vault's plugin folder.

## Setup

### 1. Create Google OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable the Google Drive API
4. Go to Credentials → Create Credentials → OAuth Client ID
5. Choose "Desktop app" as application type
6. Copy the Client ID and Client Secret

### 2. Configure the Plugin

1. Open Obsidian Settings → Vectrola Sync
2. Enter your Client ID and Client Secret
3. Click "Authenticate" and follow the OAuth flow
4. Set your preferred Drive folder path (default: `/Vectrola/wiki`)

### 3. Sync Your Wiki

**From Vectrola CLI:**
```bash
vectrola wiki --sync
```

**In Obsidian:**
- Click the sync icon in the ribbon
- Or use command palette: "Vectrola Sync: Pull wiki from Google Drive"

## Commands

| Command | Description |
|---------|-------------|
| Pull wiki from Google Drive | Download latest wiki |
| Push wiki to Google Drive | Upload current vault |
| Authenticate with Google Drive | Connect to Google account |

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Client ID | Google OAuth Client ID | (required) |
| Client Secret | Google OAuth Client Secret | (required) |
| Drive Folder Path | Where wiki is stored in Drive | `/Vectrola/wiki` |
| Auto-sync on open | Pull from Drive when vault opens | On |
| Sync interval | Auto-sync frequency in minutes | 5 |

## How It Works

1. **CLI generates wiki** → `vectrola wiki --sync` uploads to GDrive
2. **Plugin pulls wiki** → Downloads markdown files to your Obsidian vault
3. **Changes sync both ways** → Pull gets updates, Push uploads changes

## Troubleshooting

### "Not authenticated" error
- Go to Settings → Vectrola Sync → Click "Authenticate"
- Make sure Client ID and Secret are correct

### Files not syncing
- Check that Drive Folder Path matches what CLI uses (default: `/Vectrola/wiki`)
- Try manual Pull to see error messages

### Token expired
- Plugin auto-refreshes tokens, but if issues persist, re-authenticate

## License

MIT
