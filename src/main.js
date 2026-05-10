const { app, globalShortcut, ipcMain } = require('electron');
const { execSync, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const http = require('http');

// DPI scaling
app.commandLine.appendSwitch('high-dpi-support', '1');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const S = require('./state');
const { sendToMain, broadcastState }          = require('./ipc-helpers');
const { loadPositionsFromDisk, savePositionsToDisk, saveScoreboardKey, STATE_FILE } = require('./persistence');
const { createMainWindow, createOverlayWindow, createFullscreenCursorWindow, createSaveWindow, createGamepadWindow, createPlayerOverlays, createProdOverlayWindow, createRecapOverlayWindow } = require('./windows');
const { startRLDetection, startAltKeyDetection } = require('./detection');
const { startBindingMode, startScoreboardKeyDetection, getGamepadButtonLabel } = require('./keybinding');
const { showPlayerOverlays, hidePlayerOverlays } = require('./overlays');
const { connectToRL }                         = require('./rl-connection');
const { fetchRealMMR }                        = require('./mmr');
const prodServer                              = require('./production/server');

// ─── Load .env ────────────────────────────────────────────────────────────────

try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^\s*([^#=\s]+)\s*=\s*["']?([^"'\r\n]*)["']?\s*$/);
      if (m) process.env[m[1]] = m[2];
    });
  }
} catch {}

function stripUpkExt(filename) {
  return String(filename || '').replace(/\.upk$/i, '');
}

function runLocalRlUpkToolsSwap({ cookedDir, donorFilename, targetFilename }) {
  const scriptPath = path.join(app.getAppPath(), 'src', 'RLUPKTools', 'main.py');
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`RLUPKTools script not found: ${scriptPath}`);
  }

  const cooked = String(cookedDir || '').trim();
  const donor = stripUpkExt(donorFilename);
  const target = stripUpkExt(targetFilename);
  if (!cooked || !donor || !target) throw new Error('Invalid swap parameters');

  const cmd = `python "${scriptPath}" --cooked-dir "${cooked}" swap --source "${donor}" --target "${target}"`;

  console.log(`[RLUPKTools] Executing: ${cmd}`);

  const result = execSync(cmd, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
    shell: true
  });

  console.log('[RLUPKTools] Output:', result);

  if (!result.includes('OK - swap applique')) {
    throw new Error(result || 'Swap failed');
  }

  return result;
}

// ─── App Init ─────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  app.setAppUserModelId('com.rlvision.app');
  loadPositionsFromDisk();
  createMainWindow();
  createOverlayWindow();
  connectToRL();
  startRLDetection();
  startAltKeyDetection();
  createFullscreenCursorWindow();
  createSaveWindow();
  createGamepadWindow();
  startScoreboardKeyDetection();
  
  prodServer.start(sendToMain);
  setTimeout(() => {
    createProdOverlayWindow();
    createRecapOverlayWindow();
    sendToMain('prod-server-status', true);
  }, 500);

  globalShortcut.register('CommandOrControl+Shift+H', () => {
    if (!S.overlayWindow) return;
    if (S.overlayWindow.isVisible()) S.overlayWindow.hide();
    else S.overlayWindow.showInactive();
  });

  globalShortcut.register('CommandOrControl+Shift+R', () => {
    if (!S.recapOverlayWindow || S.recapOverlayWindow.isDestroyed()) return;
    if (S.recapHideTimer) { clearTimeout(S.recapHideTimer); S.recapHideTimer = null; }
    if (S.recapOverlayWindow.isVisible()) {
      S.recapOverlayWindow.hide();
    } else {
      S.recapOverlayWindow.showInactive();
      S.recapOverlayWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  });

  globalShortcut.register('F2', () => {
    if (!S.mainWindow || S.mainWindow.isDestroyed()) {
      createMainWindow();
      return;
    }

    if (S.mainWindow.isMinimized()) S.mainWindow.restore();
    S.mainWindow.show();
    S.mainWindow.moveTop();
    S.mainWindow.focus();
  });
});

app.on('window-all-closed', () => app.quit());

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  prodServer.stop();
  if (S.client)                 S.client.destroy();
  if (S.rlCheckProcess)         S.rlCheckProcess.kill();
  if (S.altKeyProcess)          S.altKeyProcess.kill();
  if (S.fullscreenCursorWindow) S.fullscreenCursorWindow.destroy();
});

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.on('get-state', (event) => { event.reply('state-update', S.state); });

ipcMain.on('reset-stats', () => {
  S.state.wins = 0; S.state.losses = 0; S.state.streak = 0; S.state.mmrGained = 0;
  broadcastState();
});

ipcMain.on('refresh-mmr', () => {
  console.log('🔄 Manual MMR refresh');
  if (!S.playerID || S.playerID === '__observer__') {
    S.state.rankImageUrl = null;
    broadcastState();
    sendToMain('mmr-source', 'estimated');
    console.log('⚠️ MMR refresh skipped: no local player id (join a match first).');
    return;
  }
  const playlist = S.currentPlaylist || S.lastPlaylist || '2v2';
  sendToMain('mmr-source', 'fetching');
  fetchRealMMR(false, S.playerID, playlist);
});

ipcMain.on('manual-score', (_, { blue, orange }) => {
  prodServer.setManualScore(blue, orange);
});

ipcMain.on('manual-series', (_, { blue, orange }) => {
  prodServer.setManualSeries(blue, orange);
});



ipcMain.on('toggle-prod-overlay', (_, enabled) => {
  S.prodOverlayUserEnabled = enabled;
  if (!S.prodOverlayWindow) return;
  if (enabled && S.rlFocused) S.prodOverlayWindow.showInactive();
  else                        S.prodOverlayWindow.hide();
});

ipcMain.on('toggle-recap-overlay', (_, enabled) => {
  S.recapAutoEnabled = enabled;
  if (!enabled && S.recapHideTimer) {
    clearTimeout(S.recapHideTimer);
    S.recapHideTimer = null;
  }
});

ipcMain.on('toggle-player-overlays', (_, enabled) => {
  S.playerOverlaysEnabled = enabled;
  try {
    let existing = {};
    if (fs.existsSync(STATE_FILE)) existing = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    existing.playerOverlaysEnabled = enabled;
    fs.writeFileSync(STATE_FILE, JSON.stringify(existing), 'utf8');
    console.log('💾 Player overlays state saved:', enabled);
  } catch (e) {}

  if (enabled) {
    if (S.gamePlayers.length > 0) createPlayerOverlays();
  } else {
    S.playerOverlayWindows.forEach(w => { if (w && !w.isDestroyed()) w.destroy(); });
    S.playerOverlayWindows = [];
  }
});

ipcMain.on('start-binding', () => startBindingMode());
ipcMain.on('stop-binding',  () => { S.isBindingMode = false; });
ipcMain.on('clear-binding', () => { S.scoreboardKey = null; saveScoreboardKey(); });

ipcMain.on('gamepad-connected',    () => {});
ipcMain.on('gamepad-disconnected', () => {});

ipcMain.on('gamepad-button-down', (_, data) => {
  if (S.isBindingMode) {
    const label = getGamepadButtonLabel(data.button);
    S.scoreboardKey = { type: 'gamepad', button: data.button, label };
    S.isBindingMode = false;
    saveScoreboardKey();
    sendToMain('binding-captured', S.scoreboardKey);
    return;
  }
  if (S.scoreboardKey?.type === 'gamepad' && data.button === S.scoreboardKey.button) {
    if (S.rlFocused) showPlayerOverlays();
  }
});

ipcMain.on('gamepad-button-up', (_, data) => {
  if (S.scoreboardKey?.type === 'gamepad' && data.button === S.scoreboardKey.button) {
    hidePlayerOverlays();
  }
});

ipcMain.on('save-overlay-positions', () => {
  if (S.overlayWindow) {
    const [x, y] = S.overlayWindow.getPosition();
    S.state.overlayX = x;
    S.state.overlayY = y;
  }
  S.playerOverlayWindows.forEach((w, i) => {
    if (w && !w.isDestroyed() && S.gamePlayers[i]) {
      const [x, y] = w.getPosition();
      S.gamePlayers[i].overlayX = x;
      S.gamePlayers[i].overlayY = y;
    }
  });

  console.log('💾 Positions saved!');
  savePositionsToDisk();

  if (S.saveWindow && !S.saveWindow.isDestroyed()) S.saveWindow.hide();
  if (S.fullscreenCursorWindow && !S.fullscreenCursorWindow.isDestroyed()) {
    S.fullscreenCursorWindow.setIgnoreMouseEvents(true, { forward: true });
    S.fullscreenCursorWindow.hide();
  }
  if (S.overlayWindow && !S.overlayWindow.isDestroyed())
    S.overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  S.playerOverlayWindows.forEach(w => {
    if (w && !w.isDestroyed()) w.setIgnoreMouseEvents(true, { forward: true });
  });

  S.altIsHeld = false;
});

ipcMain.on('set-overlay-size', (event, { width, height }) => {
  S.state.overlayWidth  = width;
  S.state.overlayHeight = height;
  if (S.overlayWindow) {
    S.overlayWindow.setSize(width, height);
    S.overlayWindow.webContents.executeJavaScript(`
      document.body.style.width  = '${width}px';
      document.body.style.height = '${height}px';
    `);
    const { sendToOverlay } = require('./ipc-helpers');
    sendToOverlay('state-update', S.state);
  }
  savePositionsToDisk();
});

ipcMain.on('open-main', () => {
  if (S.mainWindow) S.mainWindow.focus();
  else createMainWindow();
});

const RL_COOKED_PATHS = [
  'C:\\Program Files\\Epic Games\\rocketleague\\TAGame\\CookedPCConsole',
  'C:\\Program Files (x86)\\Steam\\steamapps\\common\\rocketleague\\TAGame\\CookedPCConsole',
  'D:\\Program Files\\Epic Games\\rocketleague\\TAGame\\CookedPCConsole',
  'D:\\Program Files (x86)\\Steam\\steamapps\\common\\rocketleague\\TAGame\\CookedPCConsole',
  'D:\\Steam\\steamapps\\common\\rocketleague\\TAGame\\CookedPCConsole',
  'C:\\Steam\\steamapps\\common\\rocketleague\\TAGame\\CookedPCConsole',
];

function findRLCookedDir() {
  if (S.rlInstallPath) return path.dirname(S.rlInstallPath);
  return RL_COOKED_PATHS.find(p => fs.existsSync(p)) || null;
}

ipcMain.on('toggle-boost', (event, enabled) => {
  try {
    const appDir = app.getAppPath();
    const src = path.join(
      appDir,
      enabled ? 'FilesChanges\\Boost-Alpha\\Sound\\Enable\\SFX_Boost_Standard.bnk'
              : 'FilesChanges\\Boost-Alpha\\Sound\\Disable\\SFX_Boost_Standard.bnk'
    );

    const cookedDir = findRLCookedDir();
    if (!cookedDir) {
      event.reply('boost-result', { success: false, error: 'Rocket League not found. Launch RL first or check your install path.' });
      return;
    }

    fs.copyFileSync(src, path.join(cookedDir, 'SFX_Boost_Standard.bnk'));

    let existing = {};
    if (fs.existsSync(STATE_FILE)) existing = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    existing.boostEnabled = enabled;
    fs.writeFileSync(STATE_FILE, JSON.stringify(existing), 'utf8');

    event.reply('boost-result', { success: true, enabled });
  } catch (err) {
    console.error('❌ Error:', err.message);
    event.reply('boost-result', { success: false, error: err.message });
  }
});

// ─── Workshop IPC ─────────────────────────────────────────────────────────────

const https = require('https');
const REMOTE_MANIFEST_URL = 'https://api.rlpeak.com/v1/manifest.json';
const REMOTE_CATALOGS_FALLBACK = {
  skins: 'https://api.rlpeak.com/v1/catalogs/skins.json',
  wheels: 'https://api.rlpeak.com/v1/catalogs/wheels.json',
  boosts: 'https://api.rlpeak.com/v1/catalogs/boosts.json',
};
const ORIGINAL_RELEASE_ZIPS = {
  skins: 'https://github.com/Endrix300/RLVision/releases/download/Original-Files/OriginalSkins.zip',
  wheels: 'https://github.com/Endrix300/RLVision/releases/download/Original-Files/OriginalWheel.zip',
  boosts: 'https://github.com/Endrix300/RLVision/releases/download/Original-Files/OriginalBoost.zip',
};
let remoteCatalogCache = null;


const ITEMS_RELEASE_BASE = 'https://github.com/Endrix300/RLVision/releases/download/Items-Files';

const ITEMS_RELEASE_ZIPS = {
  boosts : `${ITEMS_RELEASE_BASE}/Boosts.zip`,
  wheels : `${ITEMS_RELEASE_BASE}/Wheels.zip`,
  skins  : {
    Skin_1: `${ITEMS_RELEASE_BASE}/Skin_1.zip`,
    Skin_2: `${ITEMS_RELEASE_BASE}/Skin_2.zip`,
    Skin_3: `${ITEMS_RELEASE_BASE}/Skin_3.zip`,
    Skin_4: `${ITEMS_RELEASE_BASE}/Skin_4.zip`,
  }
};

const SKINS_INDEX = require('./skins-index.json'); // ← mets skins-index.json dans src/

function httpsGet(urlOrOptions) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlOrOptions, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpsGet(res.headers.location));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

function getRemoteSwapsFile() {
  return path.join(app.getPath('userData'), 'rlvision-remote-swaps.json');
}

function readRemoteSwaps() {
  try {
    return JSON.parse(fs.readFileSync(getRemoteSwapsFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeRemoteSwaps(data) {
  fs.writeFileSync(getRemoteSwapsFile(), JSON.stringify(data, null, 2), 'utf8');
}

function buildRemoteFileUrl(baseFilesUrl, remotePath) {
  const cleanBase = String(baseFilesUrl || '').replace(/\/+$/, '');
  const cleanPath = String(remotePath || '').split('/').map(encodeURIComponent).join('/');
  return `${cleanBase}/${cleanPath}`;
}

function getOriginalBackupsDir() {
  const dir = path.join(app.getPath('userData'), 'rlvision-original-backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function backupOriginalFileIfNeeded(cookedDir, filename) {
  const sourcePath = path.join(cookedDir, filename);
  if (!fs.existsSync(sourcePath)) return;

  const backupPath = path.join(getOriginalBackupsDir(), filename);
  if (fs.existsSync(backupPath)) return;

  const backupParent = path.dirname(backupPath);
  if (!fs.existsSync(backupParent)) fs.mkdirSync(backupParent, { recursive: true });
  fs.copyFileSync(sourcePath, backupPath);
}

function restoreOriginalFileFromBackup(cookedDir, filename) {
  const backupPath = path.join(getOriginalBackupsDir(), filename);
  if (!fs.existsSync(backupPath)) return false;

  const targetPath = path.join(cookedDir, filename);
  const targetParent = path.dirname(targetPath);
  if (!fs.existsSync(targetParent)) fs.mkdirSync(targetParent, { recursive: true });
  fs.copyFileSync(backupPath, targetPath);
  return true;
}

function clearOriginalBackup(filename) {
  const backupPath = path.join(getOriginalBackupsDir(), filename);
  if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
}

function getLocalSwapBackupsDir() {
  const dir = path.join(app.getPath('userData'), 'rlvision-local-swap-backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function backupTargetFileIfNeeded(cookedDir, targetFilename, existingBackupPath) {
  const targetPath = path.join(cookedDir, targetFilename);
  if (!fs.existsSync(targetPath)) throw new Error(`Target file not found: ${targetFilename}`);

  if (existingBackupPath && fs.existsSync(existingBackupPath)) {
    return existingBackupPath;
  }

  const backupsDir = getLocalSwapBackupsDir();
  const stamp = Date.now();
  const backupPath = path.join(backupsDir, `${targetFilename}.${stamp}.bak`);
  fs.copyFileSync(targetPath, backupPath);
  return backupPath;
}

function restoreTargetFileFromBackup(cookedDir, targetFilename, backupPath) {
  if (!backupPath || !fs.existsSync(backupPath)) {
    throw new Error('Backup not found for target (cannot revert)');
  }
  const targetPath = path.join(cookedDir, targetFilename);
  fs.copyFileSync(backupPath, targetPath);
}

function inferStripesTargetFromDonorFilename(donorFilename) {
  const name = String(donorFilename || '').trim();
  if (!name) return null;

  // Examples:
  //   Skin_Backfire_Lightning_SF.upk  -> Skin_Backfire_Stripes_SF.upk
  //   skin_backfire_lightning_SF.upk  -> skin_backfire_flames_SF.upk (preserve case prefix)
  const m = name.match(/^(skin|Skin)_([^_]+)_.+?_SF\.upk$/);
  if (!m) return null;

  const prefix = m[1]; // 'skin' or 'Skin'
  const carName = m[2]; // e.g., 'Backfire', 'Octane'
  return `${prefix}_${carName}_Stripes_SF.upk`;
}

function getTargetFilenameForSwap(category, donorFilename) {
  const cat = String(category || '').toLowerCase().trim();
  if (cat === 'boosts') return 'Boost_Standard_SF.upk';
  if (cat === 'wheels') return 'WHEEL_Vortex_SF.upk';
  if (cat === 'skins') {
    const inferred = inferStripesTargetFromDonorFilename(donorFilename);
    return inferred || 'Stripes_SF.upk';
  }
  return 'Stripes_SF.upk';
}

async function restoreFileFromOriginalSource({ category, filename, cookedDir }) {
  if (restoreOriginalFileFromBackup(cookedDir, filename)) {
    clearOriginalBackup(filename);
    return;
  }

  const zipUrl = ORIGINAL_RELEASE_ZIPS[category];
  if (!zipUrl) throw new Error(`No original ZIP configured for ${category}`);

  const originalFile = await extractFromRemoteZip(zipUrl, filename);
  fs.writeFileSync(path.join(cookedDir, filename), originalFile);
}

function normalizeSkinsCatalog(catalog) {
  const cars = catalog?.cars || {};
  const out = [];
  Object.values(cars).forEach((car) => {
    const skins = Array.isArray(car?.skins) ? car.skins : [];
    skins.forEach((skin) => {
      const remoteFiles = Array.isArray(skin?.remote_files) ? skin.remote_files : [];
      if (!remoteFiles.length) return;
      const id = `${skin.car_folder || 'Unknown'}::${skin.skin_folder || skin.ingame_decal_name || 'unknown'}`;
      out.push({
        id,
        name: skin.ingame_decal_name || skin.skin_folder || 'Unnamed skin',
        subtitle: skin.ingame_body || skin.car_folder || '',
        car: skin.car_folder || car?.car || 'Unknown',
        outputFile: skin.output_upk_file || remoteFiles[0]?.filename || '',
        skinOriginale: skin.skin_originale || '',  // ← ajoute ça
        remoteFiles: remoteFiles.map((f) => ({ filename: f.filename, remote_path: f.remote_path })),
      });
    });
  });
  return out;
}

function normalizeSimpleCatalog(catalog, arrKey, nameKey, folderKey, outputFileKey) {
  const list = Array.isArray(catalog?.[arrKey]) ? catalog[arrKey] : [];
  return list
    .map((item) => {
      const remoteFiles = Array.isArray(item?.remote_files) ? item.remote_files : [];
      if (!remoteFiles.length) return null;
      return {
        id: item[folderKey] || item[nameKey] || `item-${Math.random().toString(36).slice(2)}`,
        name: item[nameKey] || item[folderKey] || 'Unnamed item',
        subtitle: '',
        outputFile: item[outputFileKey] || remoteFiles[0]?.filename || '',
        remoteFiles: remoteFiles.map((f) => ({ filename: f.filename, remote_path: f.remote_path })),
      };
    })
    .filter(Boolean);
}

function resolveLocalItemsJsonPath() {
  const candidates = [
    path.join(app.getAppPath(), 'src', 'RLUPKTools', 'items.json'),
    path.join(app.getAppPath(), 'RLUPKTools', 'items.json'),
    path.join(__dirname, 'RLUPKTools', 'items.json'),
    path.join(__dirname, 'RLUPKTools', 'items.json'),
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

function loadLocalItemsBySlot() {
  const itemsPath = resolveLocalItemsJsonPath();
  if (!itemsPath) throw new Error('Local items.json not found (RLUPKTools/items.json)');
  const raw = JSON.parse(fs.readFileSync(itemsPath, 'utf8'));
  const rows = Array.isArray(raw?.Items) ? raw.Items : (Array.isArray(raw) ? raw : []);
  const out = {};

  rows.forEach((row) => {
    const slot = String(row?.Slot || '').trim() || 'Unknown';
    const id = row?.ID;
    const name = String(row?.Product || '').trim() || `Item ${id ?? ''}`.trim();
    const assetPackage = String(row?.AssetPackage || '').trim();
    const assetPath = String(row?.AssetPath || '').trim();

    if (!out[slot]) out[slot] = [];
    out[slot].push({
      id: String(id ?? ''),
      name,
      subtitle: assetPath,
      outputFile: assetPackage,
      assetPackage,
      slot,
    });
  });

  Object.keys(out).forEach((slot) => {
    out[slot].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  });
  return out;
}

function mapSlotsToPresetCategories(bySlot) {
  const pick = (predicate) => {
    const slots = Object.keys(bySlot);
    const picked = [];
    slots.forEach((slot) => {
      if (predicate(slot)) picked.push(...(bySlot[slot] || []));
    });
    return picked;
  };

  const skins = pick((s) => s.toLowerCase() === 'decal' || s.toLowerCase() === 'skin');
  const wheels = pick((s) => s.toLowerCase() === 'wheels' || s.toLowerCase() === 'wheel');
  const boosts = pick((s) => {
    const v = s.toLowerCase();
    return v === 'boost' || v === 'boosts' || v === 'rocket boost' || v === 'rocket boosts';
  });

  // Local items.json doesn't include a dedicated car field for decals.
  // Derive it from the Product label when available: "Fennec: Stripes" -> car="Fennec".
  skins.forEach((item) => {
    if (item && !item.car) {
      const product = String(item.name || '').trim();
      const idx = product.indexOf(':');
      if (idx > 0) item.car = product.slice(0, idx).trim();
    }
  });

  return { skins, wheels, boosts };
}

async function fetchRemoteCatalogs() {
  if (remoteCatalogCache) return remoteCatalogCache;

  const bySlot = loadLocalItemsBySlot();
  const categories = mapSlotsToPresetCategories(bySlot);

  remoteCatalogCache = {
    manifest: {
      apiVersion: 'local',
      catalogVersion: '',
      baseFilesUrl: '',
    },
    categories,
  };

  return remoteCatalogCache;
}

// ─── Remote ZIP Extraction (GitHub Releases) ─────────────────────────────────

const ORIGINAL_MAPS_URL = 'https://github.com/Endrix300/RLVision/releases/download/Original-Files/OriginalMaps.zip';

function httpsRange(url, start, end) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { 'Range': `bytes=${start}-${end}`, 'User-Agent': 'RLVision' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpsRange(res.headers.location, start, end).then(resolve).catch(reject);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function resolveUrlAndSize(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'HEAD',
      headers: { 'User-Agent': 'RLVision' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return resolveUrlAndSize(res.headers.location).then(resolve).catch(reject);
      resolve({ finalUrl: url, size: parseInt(res.headers['content-length'] || '0') });
    });
    req.on('error', reject);
    req.end();
  });
}

async function extractFromRemoteZip(zipUrl, entryName) {
  const { finalUrl, size } = await resolveUrlAndSize(zipUrl);
  if (!size) throw new Error('Could not determine ZIP file size');

  // Read last 65KB to locate End of Central Directory
  const tail = await httpsRange(finalUrl, size - Math.min(65536, size), size - 1);
  let eocdPos = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i+1] === 0x4b && tail[i+2] === 0x05 && tail[i+3] === 0x06) {
      eocdPos = i; break;
    }
  }
  if (eocdPos === -1) throw new Error('EOCD not found in ZIP');

  let cdSize   = tail.readUInt32LE(eocdPos + 12);
  let cdOffset = tail.readUInt32LE(eocdPos + 16);

  // ZIP64 support
  if (cdOffset === 0xFFFFFFFF) {
    const lp = eocdPos - 20;
    if (lp >= 0 && tail[lp] === 0x50 && tail[lp+1] === 0x4b && tail[lp+2] === 0x06 && tail[lp+3] === 0x07) {
      const z64Off = Number(tail.readBigUInt64LE(lp + 8));
      const z64Buf = await httpsRange(finalUrl, z64Off, z64Off + 55);
      cdSize   = Number(z64Buf.readBigUInt64LE(40));
      cdOffset = Number(z64Buf.readBigUInt64LE(48));
    } else throw new Error('ZIP64 locator not found');
  }

  // Download and parse Central Directory
  const cd  = await httpsRange(finalUrl, cdOffset, cdOffset + cdSize - 1);
  let pos = 0, found = null;
  const wanted = String(entryName || '').replace(/\\/g, '/').toLowerCase();
  while (pos + 46 <= cd.length) {
    if (cd.readUInt32LE(pos) !== 0x02014b50) break;
    const compression    = cd.readUInt16LE(pos + 10);
    const compressedSize = cd.readUInt32LE(pos + 20);
    const fileNameLen    = cd.readUInt16LE(pos + 28);
    const extraLen       = cd.readUInt16LE(pos + 30);
    const commentLen     = cd.readUInt16LE(pos + 32);
    let   localOffset    = cd.readUInt32LE(pos + 42);
    const fileName       = cd.slice(pos + 46, pos + 46 + fileNameLen).toString('utf8');

    // ZIP64 local offset in extra field
    if (localOffset === 0xFFFFFFFF) {
      let ep = pos + 46 + fileNameLen, ee = ep + extraLen;
      while (ep + 4 <= ee) {
        const hid = cd.readUInt16LE(ep), ds = cd.readUInt16LE(ep + 2);
        if (hid === 0x0001) {
          let zp = ep + 4;
          if (cd.readUInt32LE(pos + 24) === 0xFFFFFFFF) zp += 8;
          if (cd.readUInt32LE(pos + 20) === 0xFFFFFFFF) zp += 8;
          localOffset = Number(cd.readBigUInt64LE(zp));
          break;
        }
        ep += 4 + ds;
      }
    }

    const normalized = fileName.replace(/\\/g, '/');
    const normalizedBase = normalized.includes('/') ? normalized.split('/').pop() : normalized;
    if (normalized.toLowerCase() === wanted || normalizedBase.toLowerCase() === wanted) {
      found = { compression, compressedSize, localOffset }; break;
    }
    pos += 46 + fileNameLen + extraLen + commentLen;
  }
  if (!found) throw new Error(`${entryName} not found in remote ZIP`);

  // Read local file header to get exact data offset
  const lh          = await httpsRange(finalUrl, found.localOffset, found.localOffset + 29);
  const dataStart   = found.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  const compressed  = await httpsRange(finalUrl, dataStart, dataStart + found.compressedSize - 1);

  if (found.compression === 0) return compressed;
  if (found.compression === 8) return zlib.inflateRawSync(compressed);
  throw new Error(`Unsupported compression method: ${found.compression}`);
}

// ─────────────────────────────────────────────────────────────────────────────

ipcMain.handle('fetch-bakkesmaps', async (_, { page = 1, query = '' } = {}) => {
  try {
    const pageNum = Math.max(1, parseInt(page) || 1);
    const qs      = query ? `?page=${pageNum}&search=${encodeURIComponent(query)}` : `?page=${pageNum}`;
    const { body } = await httpsGet({
      hostname : 'bakkesplugins.com',
      path     : `/maps${qs}`,
      headers  : {
        'User-Agent' : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept'     : 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      },
    });
    const html = body.toString('utf8');

    // Extract map cards: each card is an <a href="/maps/{id}"> block
    const maps = [];
    const seenIds = new Set();
    const cardRe = /<a[^>]+href="\/maps\/(\d+)"[^>]*>([\s\S]*?)(?=<a[^>]+href="\/maps\/\d+"|$)/g;
    let m;
    while ((m = cardRe.exec(html)) !== null) {
      const id      = m[1];
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const inner   = m[2];
      const imgM    = inner.match(/src="(https?:\/\/[^"]+)"/);
      const titleM  = inner.match(/<h\d[^>]*>\s*([^<]+?)\s*<\/h\d>/);
      const authorM = inner.match(/(?:by|author)[^>]*>\s*([^<]+?)\s*</i) ||
                      inner.match(/<(?:span|p|small)[^>]*>\s*([^<]{2,40}?)\s*<\/(?:span|p|small)>/);
      const name    = titleM ? titleM[1].trim() : `Map ${id}`;
      const author  = authorM ? authorM[1].trim() : '';
      const image   = imgM ? imgM[1] : null;
      if (query) {
        const q = query.toLowerCase();
        if (!name.toLowerCase().includes(q) && !author.toLowerCase().includes(q)) continue;
      }
      maps.push({ id, name, image, author });
    }

    // Detect total pages from pagination links
    const pageNums = [...html.matchAll(/[?&]page=(\d+)/g)].map(x => parseInt(x[1]));
    const totalPages = pageNums.length ? Math.max(...pageNums) : 1;

    return { maps, totalPages };
  } catch (e) {
    return { maps: [], totalPages: 1, error: e.message };
  }
});

ipcMain.handle('install-bakkesmap', async (_, { id, name }) => {
  try {
    const workshopDir = path.join(app.getAppPath(), 'FilesChanges', 'Workshop', 'Enable');
    if (!fs.existsSync(workshopDir)) fs.mkdirSync(workshopDir, { recursive: true });

    // Fetch map detail page — the Nuxt SSR JSON embeds the CDN file URL directly
    const { body: detailBuf } = await httpsGet({
      hostname : 'bakkesplugins.com',
      path     : `/maps/${id}`,
      headers  : { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
    });
    const detail = detailBuf.toString('utf8');

    // Extract edgeUrl from __NUXT_DATA__ JSON: "https://cdn.bakkesplugins.com/uploads/{hash}-{name}.zip"
    const cdnMatch = detail.match(/"(https:\/\/cdn\.bakkesplugins\.com\/uploads\/[a-f0-9]+-[^"]+\.zip)"/i);
    if (!cdnMatch) return { success: false, error: 'ZIP file not found on the page' };

    const fileUrl  = cdnMatch[1];
    // Build filename: {id}_{originalName}.zip  (strip CDN hash prefix)
    const rawFileName = decodeURIComponent(fileUrl.split('/').pop());
    const cleanName   = rawFileName.replace(/^[a-f0-9]+-/i, '');
    const fileName    = `${id}_${cleanName}`;

    const { statusCode, body: fileBuf } = await httpsGet(fileUrl);
    if (statusCode !== 200 || fileBuf.length < 1000) {
      return { success: false, error: `Download failed (HTTP ${statusCode})` };
    }

    const destPath = path.join(workshopDir, fileName);
    fs.writeFileSync(destPath, fileBuf);
    return { success: true, path: destPath, fileName };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

const RECOMMENDED_PATTERNS = [
  'arc_p', 'arcp_standard', 'badlands', 'tokyounderpass',
  'throwback', 'barricade', 'basin', 'colosseum', 'corridor',
  'cosmic', 'duplexo', 'galleon', 'hourglass', 'loophole',
  'octagon', 'pillars', 'underpass', 'utopiaretro', 'roadblock',
];

function isRecommended(fileName) {
  const f = fileName.toLowerCase();
  return RECOMMENDED_PATTERNS.some(p => f.includes(p));
}

const INSTALLS_FILE = () => path.join(app.getAppPath(), 'FilesChanges', 'Workshop', 'installs.json');

function readInstalls() {
  try { return JSON.parse(fs.readFileSync(INSTALLS_FILE(), 'utf8')); } catch { return {}; }
}

function writeInstalls(data) {
  fs.writeFileSync(INSTALLS_FILE(), JSON.stringify(data, null, 2));
}

ipcMain.handle('get-rl-maps', async () => {
  const cookedDir = findRLCookedDir();
  if (!cookedDir) return { maps: [], error: 'Rocket League not found' };
  try {
    const installs  = readInstalls();
    const usedFiles = new Set(Object.values(installs).map(r => r.targetMapFile));
    const files     = fs.readdirSync(cookedDir)
      .filter(f => /_P\.upk$/i.test(f))
      .sort();
    return {
      maps: files.map(f => ({
        fileName    : f,
        displayName : f.replace(/_P\.upk$/i, '').replace(/_/g, ' '),
        recommended : isRecommended(f),
        inUse       : usedFiles.has(f),
      }))
    };
  } catch (e) {
    return { maps: [], error: e.message };
  }
});

ipcMain.handle('load-workshop-map', async (_, { zipFileName, targetMapFile }) => {
  try {
    const AdmZip      = require('adm-zip');
    const workshopDir = path.join(app.getAppPath(), 'FilesChanges', 'Workshop', 'Enable');
    const zipPath     = path.join(workshopDir, zipFileName);
    const cookedDir   = findRLCookedDir();
    if (!cookedDir) return { success: false, error: 'Rocket League not found' };

    // Extract workshop .udk from zip and overwrite the RL map
    const zip      = new AdmZip(zipPath);
    const mapEntry = zip.getEntries().find(e => /\.(udk|upk|umap)$/i.test(e.entryName) && !e.isDirectory);
    if (!mapEntry) return { success: false, error: 'No .udk file found in the zip' };
    fs.writeFileSync(path.join(cookedDir, targetMapFile), zip.readFile(mapEntry));

    // Save install record
    const installs = readInstalls();
    installs[zipFileName] = { targetMapFile, installedAt: new Date().toISOString() };
    writeInstalls(installs);

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('revert-workshop-map', async (_, { zipFileName }) => {
  try {
    const installs = readInstalls();
    const record   = installs[zipFileName];
    if (!record) return { success: false, error: 'No install record found' };

    const cookedDir = findRLCookedDir();
    if (!cookedDir) return { success: false, error: 'Rocket League not found' };

    const fileBuffer = await extractFromRemoteZip(ORIGINAL_MAPS_URL, record.targetMapFile);
    fs.writeFileSync(path.join(cookedDir, record.targetMapFile), fileBuffer);

    delete installs[zipFileName];
    writeInstalls(installs);

    return { success: true, targetMapFile: record.targetMapFile };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.on('revert-all-workshop-maps', async (event) => {
  try {
    const installs = readInstalls();
    const entries = Object.entries(installs);
    const total = entries.length;

    if (!total) {
      event.reply('revert-all-workshop-progress', {
        success: true,
        done: 0,
        total: 0,
        percent: 100,
        finished: true,
        message: 'No active workshop maps',
      });
      return;
    }

    const cookedDir = findRLCookedDir();
    if (!cookedDir) {
      event.reply('revert-all-workshop-progress', { success: false, finished: true, error: 'Rocket League not found' });
      return;
    }

    let done = 0;
    for (const [zipFileName, record] of entries) {
      const targetMapFile = record?.targetMapFile;
      if (!targetMapFile) continue;

      const fileBuffer = await extractFromRemoteZip(ORIGINAL_MAPS_URL, targetMapFile);
      fs.writeFileSync(path.join(cookedDir, targetMapFile), fileBuffer);
      delete installs[zipFileName];

      done += 1;
      event.reply('revert-all-workshop-progress', {
        success: true,
        done,
        total,
        percent: Math.round((done / total) * 100),
        finished: false,
        message: `Restored ${targetMapFile}`,
      });
    }

    writeInstalls(installs);
    event.reply('revert-all-workshop-progress', {
      success: true,
      done: total,
      total,
      percent: 100,
      finished: true,
      message: 'All workshop maps restored',
    });
  } catch (e) {
    event.reply('revert-all-workshop-progress', { success: false, finished: true, error: e.message });
  }
});

ipcMain.handle('get-installed-maps', async () => {
  try {
    const workshopDir = path.join(app.getAppPath(), 'FilesChanges', 'Workshop', 'Enable');
    if (!fs.existsSync(workshopDir)) return { maps: [] };

    const installs = readInstalls();
    const files = fs.readdirSync(workshopDir).filter(f => /\.zip$/i.test(f));
    const maps  = [];

    for (const file of files) {
      const idMatch = file.match(/^(\d+)_/);
      const id      = idMatch ? idMatch[1] : null;
      const fallbackName = file.replace(/^\d+_/, '').replace(/\.zip$/i, '');

      let name  = fallbackName;
      let image = null;

      if (id) {
        try {
          const { body } = await httpsGet({
            hostname : 'bakkesplugins.com',
            path     : `/maps/${id}`,
            headers  : { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          });
          const html = body.toString('utf8');
          // Preview image from CDN
          const imgM  = html.match(/"(https:\/\/cdn\.bakkesplugins\.com\/uploads\/[a-f0-9]+-preview\.jpg)"/);
          if (imgM) image = imgM[1];
          // Map name from og:title or Nuxt data "name" field
          const nameM = html.match(/<meta property="og:title" content="([^"]+?)(?:\s*-\s*BakkesPlugins)?"/i);
          if (nameM) name = nameM[1].trim();
        } catch {}
      }

      maps.push({ id, name, image, fileName: file, install: installs[file] || null });
    }

    return { maps };
  } catch (e) {
    return { maps: [], error: e.message };
  }
});

ipcMain.handle('fetch-remote-catalogs', async () => {
  try {
    const data = await fetchRemoteCatalogs();
    return { success: true, ...data };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-remote-swaps', async () => {
  try {
    return { success: true, swaps: readRemoteSwaps() };
  } catch (e) {
    return { success: false, swaps: {}, error: e.message };
  }
});

ipcMain.handle('apply-remote-item', async (_, { category, itemId }) => {
  try {
    console.log(`[apply-remote-item] Starting swap for ${category}:${itemId}`);

    const cookedDir = findRLCookedDir();
    if (!cookedDir) return { success: false, error: 'Rocket League not found' };
    console.log(`[apply-remote-item] Cooked dir: ${cookedDir}`);

    const catalogData = await fetchRemoteCatalogs();
    const items = catalogData?.categories?.[category];
    if (!Array.isArray(items)) return { success: false, error: `Unknown category: ${category}` };
    const item = items.find((x) => x.id === itemId);
    if (!item) return { success: false, error: 'Item not found in catalog' };
    console.log(`[apply-remote-item] Found item: ${item.name} (${item.assetPackage || item.outputFile})`);

    const donorFilename = String(item.assetPackage || item.outputFile || '').trim();
    if (!donorFilename) return { success: false, error: 'Selected item has no AssetPackage' };

    const targetFilename = getTargetFilenameForSwap(category, donorFilename);
    console.log(`[apply-remote-item] Donor: ${donorFilename}, Target: ${targetFilename}`);

    const donorPath = path.join(cookedDir, donorFilename);
    if (!fs.existsSync(donorPath)) {
      return { success: false, error: `Donor file not found in CookedPCConsole: ${donorFilename}` };
    }

    const targetPath = path.join(cookedDir, targetFilename);
    if (!fs.existsSync(targetPath)) {
      return { success: false, error: `Target file not found in CookedPCConsole: ${targetFilename}` };
    }

    const swaps = readRemoteSwaps();
    const existingKeys = Object.keys(swaps);
    let existingBackupPath = null;
    existingKeys.forEach((k) => {
      const rec = swaps[k];
      if (rec?.targetFilename === targetFilename && rec?.backupPath) existingBackupPath = rec.backupPath;
    });

    const backupPath = backupTargetFileIfNeeded(cookedDir, targetFilename, existingBackupPath);
    console.log(`[apply-remote-item] Backup path: ${backupPath}`);

    // One active swap per target: clear any previous record for this target
    existingKeys.forEach((k) => {
      if (swaps[k]?.targetFilename === targetFilename) delete swaps[k];
    });

    // Verify the target file was modified (check size/mtime change)
    const targetStatsBefore = fs.statSync(targetPath);
    console.log(`[apply-remote-item] Target file before swap: ${targetStatsBefore.size} bytes, mtime: ${targetStatsBefore.mtime}`);

    // Use RLUPKTools to patch/merge the UPK instead of raw copying.
    console.log(`[apply-remote-item] Calling RLUPKTools swap...`);
    try {
      runLocalRlUpkToolsSwap({ cookedDir, donorFilename, targetFilename });

      // Verify file was actually modified
      const targetStatsAfter = fs.statSync(targetPath);
      console.log(`[apply-remote-item] Target file after swap: ${targetStatsAfter.size} bytes, mtime: ${targetStatsAfter.mtime}`);

      const sizeChanged = targetStatsAfter.size !== targetStatsBefore.size;
      const timeChanged = targetStatsAfter.mtime.getTime() !== targetStatsBefore.mtime.getTime();

      if (!sizeChanged && !timeChanged) {
        console.warn(`[apply-remote-item] WARNING: Target file appears unchanged after swap!`);
        return { success: false, error: 'Swap appears to have failed - file was not modified. Check Python logs.' };
      }

      console.log(`[apply-remote-item] RLUPKTools swap completed successfully (file modified: size=${sizeChanged}, mtime=${timeChanged})`);
    } catch (swapError) {
      console.error(`[apply-remote-item] RLUPKTools swap failed:`, swapError.message);
      // Restore backup if swap failed
      try {
        if (fs.existsSync(backupPath)) {
          fs.copyFileSync(backupPath, targetPath);
          console.log(`[apply-remote-item] Restored target from backup after failed swap`);
        }
      } catch (restoreErr) {
        console.error(`[apply-remote-item] Failed to restore backup:`, restoreErr.message);
      }
      return { success: false, error: `Swap failed: ${swapError.message}` };
    }

    const key = `${category}:${item.id}`;
    swaps[key] = {
      category,
      itemId: item.id,
      itemName: item.name,
      donorFilename,
      targetFilename,
      backupPath,
      updatedAt: new Date().toISOString(),
    };
    writeRemoteSwaps(swaps);
    console.log(`[apply-remote-item] Swap saved to journal: ${key}`);

    return { success: true, key, files: [targetFilename] };
  } catch (e) {
    console.error(`[apply-remote-item] Unexpected error:`, e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('revert-remote-item', async (_, { category, itemId }) => {
  try {
    const cookedDir = findRLCookedDir();
    if (!cookedDir) return { success: false, error: 'Rocket League not found' };

    const swaps = readRemoteSwaps();
    const key = `${category}:${itemId}`;
    const record = swaps[key];
    if (!record) return { success: false, error: 'No swap state found for this item' };

    const targetFilename = record.targetFilename || 'Stripes_SF.upk';
    restoreTargetFileFromBackup(cookedDir, targetFilename, record.backupPath);

    delete swaps[key];
    writeRemoteSwaps(swaps);
    return { success: true, files: [targetFilename] };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.on('revert-all-remote-items', async (event) => {
  try {
    const cookedDir = findRLCookedDir();
    if (!cookedDir) {
      event.reply('revert-all-remote-progress', { success: false, error: 'Rocket League not found' });
      return;
    }

    const swaps = readRemoteSwaps();
    const records = Object.values(swaps);
    const tasks = [];
    const seenTargets = new Set();
    records.forEach((record) => {
      const targetFilename = String(record?.targetFilename || '').trim();
      const backupPath = String(record?.backupPath || '').trim();
      if (!targetFilename || !backupPath) return;
      const key = targetFilename.toLowerCase();
      if (seenTargets.has(key)) return;
      seenTargets.add(key);
      tasks.push({ targetFilename, backupPath });
    });

    const total = tasks.length;
    if (!total) {
      event.reply('revert-all-remote-progress', {
        success: true,
        done: 0,
        total: 0,
        percent: 100,
        finished: true,
        message: 'Nothing to restore',
      });
      return;
    }

    let done = 0;
    for (const task of tasks) {
      restoreTargetFileFromBackup(cookedDir, task.targetFilename, task.backupPath);
      done += 1;
      event.reply('revert-all-remote-progress', {
        success: true,
        done,
        total,
        percent: Math.round((done / total) * 100),
        finished: false,
        message: `Restored ${task.targetFilename}`,
      });
    }

    writeRemoteSwaps({});
    event.reply('revert-all-remote-progress', {
      success: true,
      done: total,
      total,
      percent: 100,
      finished: true,
      message: 'All original files restored',
    });
  } catch (e) {
    event.reply('revert-all-remote-progress', {
      success: false,
      finished: true,
      error: e.message,
    });
  }
});

// ─── Production IPC ───────────────────────────────────────────────────────────

function downloadLogo(imageUrl, team) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',  // ✅ IPv4 forcé, pas 'localhost'
      port: 3000,
      path: `/download-logo?url=${encodeURIComponent(imageUrl)}&team=${team}`,
      method: 'GET',
    };

    http.get(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

ipcMain.on('prod-config-update', async (_, config) => {

  // Logo bleu
  if (config.blueLogo) {
    if (config.blueLogo.startsWith('http') && !config.blueLogo.startsWith('http://localhost')) {
      try {
        const data = await downloadLogo(config.blueLogo, 'blue');
        if (data.success) config.blueLogo = data.url;
      } catch(e) { console.error('Blue logo download failed:', e.message); }
    
    } else if (!config.blueLogo.startsWith('http')) {
      // ✅ Chemin local — copie dans assets
      config.blueLogo = config.blueLogo.trim().replace(/^["']|["']$/g, '');
      try {
        const destDir  = path.join(__dirname, 'production', 'assets');
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        const fileName = `logo-blue-${Date.now()}${path.extname(config.blueLogo)}`;
        fs.copyFileSync(config.blueLogo, path.join(destDir, fileName));
        config.blueLogo = `http://localhost:3000/assets/${fileName}`;
      } catch(e) { console.error('Blue logo copy failed:', e.message); }
    }
  }

  // Logo orange
  if (config.orangeLogo) {
    if (config.orangeLogo.startsWith('http') && !config.orangeLogo.startsWith('http://localhost')) {
      try {
        const data = await downloadLogo(config.orangeLogo, 'orange');
        if (data.success) config.orangeLogo = data.url;
      } catch(e) { console.error('Orange logo copy failed:', e.message); }

    } else if (!config.orangeLogo.startsWith('http')) {
      // ✅ Chemin local — copie dans assets
      config.orangeLogo = config.orangeLogo.trim().replace(/^["']|["']$/g, '');
      try {
        const destDir  = path.join(__dirname, 'production', 'assets');
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        const fileName = `logo-orange-${Date.now()}${path.extname(config.orangeLogo)}`;
        fs.copyFileSync(config.orangeLogo, path.join(destDir, fileName));
        config.orangeLogo = `http://localhost:3000/assets/${fileName}`;
      } catch(e) { console.error('Orange logo copy failed:', e.message); }
    }
  }

  prodServer.updateProdConfig(config);
});

// ─── Profile Folder Management ─────────────────────────────────────────────────────

ipcMain.handle('create-profile-folders', async (_, { profileName }) => {
  try {
    const profilesDir = path.join(app.getPath('userData'), 'profiles');
    if (!fs.existsSync(profilesDir)) {
      fs.mkdirSync(profilesDir, { recursive: true });
    }

    const profileDir = path.join(profilesDir, profileName);
    if (fs.existsSync(profileDir)) {
      return { success: false, error: 'Profile folder already exists' };
    }

    // Create profile directory with subdirectories
    fs.mkdirSync(profileDir, { recursive: true });
    fs.mkdirSync(path.join(profileDir, 'boosts'), { recursive: true });
    fs.mkdirSync(path.join(profileDir, 'skins'), { recursive: true });
    fs.mkdirSync(path.join(profileDir, 'wheels'), { recursive: true });

    console.log(`[Profile] Created folder structure for profile: ${profileName}`);
    return { success: true, profileDir };
  } catch (error) {
    console.error('[Profile] Error creating profile folders:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('add-items-to-profile', async (_, { profileName, category, enabledItems }) => {
  try {
    console.log(`[Profile Debug] Starting add-items-to-profile for ${profileName}/${category}`);
    console.log(`[Profile Debug] Enabled items:`, enabledItems);
    
    const cookedDir = findRLCookedDir();
    if (!cookedDir) {
      console.log(`[Profile Debug] Rocket League not found: ${cookedDir}`);
      return { success: false, error: 'Rocket League not found' };
    }

    const catalogData = await fetchRemoteCatalogs();
    const catalogItems = catalogData?.categories?.[category] || [];
    console.log(`[Profile Debug] Catalog items found:`, catalogItems.length);
    
    const profilesDir = path.join(app.getPath('userData'), 'profiles');
    const profileCategoryDir = path.join(profilesDir, profileName, category);
    console.log(`[Profile Debug] Profile category directory: ${profileCategoryDir}`);
    
    if (!fs.existsSync(profileCategoryDir)) {
      console.log(`[Profile Debug] Creating profile directory: ${profileCategoryDir}`);
      fs.mkdirSync(profileCategoryDir, { recursive: true });
    }

    const copiedFiles = [];
    
    for (const enabledItem of enabledItems) {
      console.log(`[Profile Debug] Processing enabledItem:`, enabledItem);
      
      const catalogItem = catalogItems.find(item => 
        item.id === enabledItem.itemId || item.id === String(enabledItem.itemId)
      );
      
      if (!catalogItem) {
        console.warn(`[Profile] Item ${enabledItem.itemId} not found in catalog, skipping`);
        continue;
      }

      console.log(`[Profile Debug] Found catalogItem:`, catalogItem);

      // Find the CURRENTLY ACTIVE modified file in CookedPCConsole
      let donorFilename = null;
      
      // Check swaps to find the currently active file for this category
      const swaps = readRemoteSwaps();
      const activeSwap = Object.values(swaps).find(swap => 
        swap.category === category && swap.itemId === enabledItem.itemId
      );
      
      // Always copy the TARGET file (original file), not the donor file
      let targetFilename = null;
      if (activeSwap && activeSwap.targetFilename) {
        targetFilename = activeSwap.targetFilename;
        console.log(`[Profile Debug] Found target file in swaps: ${targetFilename}`);
      } else {
        // Fallback to default target file
        targetFilename = getTargetFilenameForSwap(category, catalogItem.assetPackage || catalogItem.outputFile || '');
        console.log(`[Profile Debug] Using default target file: ${targetFilename}`);
      }
      
      if (!targetFilename) {
        console.warn(`[Profile] Cannot determine target file for item ${enabledItem.itemId}, skipping`);
        continue;
      }

      // Copy TARGET file (original) to profile
      const sourcePath = path.join(cookedDir, targetFilename);
      const destPath = path.join(profileCategoryDir, targetFilename);
      
      console.log(`[Profile Debug] Source path: ${sourcePath}`);
      console.log(`[Profile Debug] Dest path: ${destPath}`);
      console.log(`[Profile Debug] Source exists: ${fs.existsSync(sourcePath)}`);
      
      if (fs.existsSync(sourcePath)) {
        console.log(`[Profile Debug] Attempting to copy ${sourcePath} to ${destPath}`);
        fs.copyFileSync(sourcePath, destPath);
        copiedFiles.push({
          itemId: enabledItem.itemId,
          filename: targetFilename,
          itemName: catalogItem.name
        });
        console.log(`[Profile] Copied active ${targetFilename} to profile ${profileName}/${category}`);
      } else {
        console.warn(`[Profile] Active file not found: ${sourcePath}`);
      }
    }

    return { success: true, copiedFiles };
  } catch (error) {
    console.error('[Profile] Error adding items to profile:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('load-profile-files', async (_, { profileName, category, files }) => {
  try {
    console.log(`[Profile Debug] Starting load-profile-files for ${profileName}/${category}`);
    
    const cookedDir = findRLCookedDir();
    if (!cookedDir) {
      console.log(`[Profile Debug] Rocket League not found: ${cookedDir}`);
      return { success: false, error: 'Rocket League not found' };
    }

    const profilesDir = path.join(app.getPath('userData'), 'profiles');
    const profileCategoryDir = path.join(profilesDir, profileName, category);
    console.log(`[Profile Debug] Profile category directory: ${profileCategoryDir}`);
    
    if (!fs.existsSync(profileCategoryDir)) {
      console.log(`[Profile Debug] Profile directory does not exist: ${profileCategoryDir}`);
      return { success: true, loadedCount: 0, failedCount: 0, enabledItems: [] };
    }

    // List ALL files in profile directory (ignore the files parameter)
    let filesInDir = [];
    try {
      filesInDir = fs.readdirSync(profileCategoryDir);
      console.log(`[Profile Debug] Files found in directory:`, filesInDir);
    } catch (e) {
      console.error(`[Profile Debug] Error reading directory:`, e.message);
      return { success: true, loadedCount: 0, failedCount: 0, enabledItems: [] };
    }

    // Filter only .upk and .bnk files
    const upkFiles = filesInDir.filter(f => f.endsWith('.upk') || f.endsWith('.bnk'));
    console.log(`[Profile Debug] .upk/.bnk files to copy:`, upkFiles);

    let loadedCount = 0;
    let failedCount = 0;

    // Copy ALL .upk/.bnk files from profile to CookedPCConsole
    for (const filename of upkFiles) {
      const sourcePath = path.join(profileCategoryDir, filename);
      const destPath = path.join(cookedDir, filename);
      
      console.log(`[Profile Debug] Copying ${sourcePath} to ${destPath}`);
      
      try {
        fs.copyFileSync(sourcePath, destPath);
        console.log(`[Profile] Copied ${filename} from profile ${profileName}/${category} to CookedPCConsole`);
        loadedCount++;
      } catch (copyError) {
        console.error(`[Profile] Failed to copy ${filename}:`, copyError.message);
        failedCount++;
      }
    }

    return { 
      success: true, 
      loadedCount, 
      failedCount
    };
  } catch (error) {
    console.error('[Profile] Error loading profile files:', error);
    return { success: false, error: error.message };
  }
});