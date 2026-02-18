# OpenClaw Bridge — Mirror for Upload

This folder contains a snapshot of all files from [absurdfounder/openclawbridge](https://github.com/absurdfounder/openclawbridge).

**Purpose:** Edit files here, then upload/push them to the openclawbridge repo to replace the remote files.

## How to Upload

### Option 1: Git (if you have push access)

```bash
cd openclawbridge
git init
git remote add origin https://github.com/absurdfounder/openclawbridge.git
git add .
git commit -m "Update from Crabs-HQ mirror"
git push -u origin main --force   # replaces all remote files
```

### Option 2: Manual upload via GitHub

1. Go to https://github.com/absurdfounder/openclawbridge
2. For each file: click the file → Edit (pencil) → paste content from this folder → Commit
3. Or: delete all files, then upload these as new files

### Option 3: Fork + PR

1. Fork the repo
2. Replace all files with contents from this folder
3. Open a PR to the upstream repo

## Files in this folder

| File | Description |
|------|-------------|
| `index.mjs` | Main bridge server (ESM) — used by VPS setup |
| `index.js` | Alternate entry (legacy) |
| `setup-openclaw-full.sh` | VPS cloud-init script — used by CrabsHQ provision.js |
| `package.json` | Dependencies |
| `.env.example` | Example env vars |
| `.gitignore` | Git ignore rules |
| `README.md` | Repo readme |

## CrabsHQ patches

If you've applied patches from `server/scripts/` (e.g. `OPENCLAWBRIDGE-PATCH.md`, `BRIDGE-SCREENSHOT-PATCH.md`), those changes should be in the files above before uploading.
