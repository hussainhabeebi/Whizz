// Intentionally empty for now — index.html runs as the renderer completely unmodified,
// talking to the local server over plain relative fetch() calls, so there's nothing it
// needs from Node/Electron yet. Kept as a real preload (with contextIsolation on and
// nodeIntegration off in main.js) rather than skipping it, so native-UX features added
// later (tray status, notifications) have a safe place to expose a minimal bridge without
// loosening the renderer's security posture to do it.
