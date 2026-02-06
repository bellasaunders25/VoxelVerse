# Fly.io setup for VoxelVerse multiplayer

This repository now includes a deployable WebSocket backend for VoxelVerse.

## Files included
- `server.js` - room-based WebSocket relay (`JOIN`, `CHAT`, `BLOCK`)
- `package.json` - Node + ws dependency
- `Dockerfile` - container build
- `fly.toml` - Fly app/service configuration

## Deploy

1. Install Fly CLI and login:
   ```bash
   fly auth login
   ```

2. (Optional) change app name in `fly.toml` (`app = "voxelverse-realtime"`) so it is unique.

3. Launch/deploy:
   ```bash
   fly launch --no-deploy
   fly deploy
   ```

4. Get your public URL:
   ```bash
   fly status
   ```
   Use `wss://<your-app>.fly.dev` in the game `Realtime Server` field.

## Notes
- Your Vercel site should connect to this Fly URL via `wss://...`.
- Join code generation in the game already embeds endpoint + room id.
