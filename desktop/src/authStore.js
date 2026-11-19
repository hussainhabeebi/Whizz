// Stores the desktop pairing token using Electron's safeStorage (Keychain on macOS, DPAPI
// on Windows, libsecret on Linux) — the OS-encrypted bytes still have to live somewhere, so
// they're written to a small file in the app's own userData folder, never in plaintext.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

function tokenPath() {
  return path.join(app.getPath('userData'), 'auth.bin');
}

function getToken() {
  try {
    const encrypted = fs.readFileSync(tokenPath());
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(encrypted);
  } catch (_) {
    return null;
  }
}

function setToken(token) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level secure storage isn\'t available on this machine — can\'t safely store the pairing token.');
  }
  fs.mkdirSync(path.dirname(tokenPath()), { recursive: true });
  fs.writeFileSync(tokenPath(), safeStorage.encryptString(token));
}

function clearToken() {
  try { fs.unlinkSync(tokenPath()); } catch (_) { /* already gone */ }
}

module.exports = { getToken, setToken, clearToken };
