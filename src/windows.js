const { BrowserWindow, screen, app } = require('electron');
const fs   = require('fs');
const path = require('path');

const S = require('./state');
const { sendToMain } = require('./ipc-helpers');
const { STATE_FILE } = require('./persistence');

// ─── Main Window ──────────────────────────────────────────────────────────────

function createMainWindow() {
  S.mainWindow = new BrowserWindow({
    width     : 560,
    height    : 700,
    minWidth  : 400,
    minHeight : 500,
    resizable : true,
    title     : 'RLVision',
    icon      : path.join(__dirname, '..', 'assets', 'logo.ico'),
    backgroundColor: '#0f0f1a',
    webPreferences: {
      nodeIntegration  : true,
      contextIsolation : false,
      webSecurity: false,  // ← ajoute cette ligne
    },
  });

  S.mainWindow.loadFile('main.html');
  S.mainWindow.setMenuBarVisibility(false);

  S.mainWindow.webContents.on('did-finish-load', () => {
    const { client } = require('./state');
    const isConnected = client && !client.destroyed && client.writable;
    sendToMain('rl-connected', isConnected);
    sendToMain('state-update', S.state);
    if (S.scoreboardKey) sendToMain('scoreboard-key', S.scoreboardKey);

    try {
      if (fs.existsSync(STATE_FILE)) {
        const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (saved.boostEnabled !== undefined) {
          sendToMain('boost-state', saved.boostEnabled);
          console.log('✅ Boost state restored:', saved.boostEnabled);
        }
        if (saved.playerOverlaysEnabled !== undefined) {
          sendToMain('player-overlays-state', saved.playerOverlaysEnabled);
          console.log('✅ Player overlays state restored:', saved.playerOverlaysEnabled);
        }
      }
    } catch (e) {
      console.log('⚠️ Could not restore states');
    }
  });

  S.mainWindow.on('closed', () => {
    S.mainWindow = null;
    if (S.overlayWindow)     S.overlayWindow.destroy();
    if (S.client)            S.client.destroy();
    if (S.reconnectInterval) clearInterval(S.reconnectInterval);
    if (S.rlCheckProcess)    S.rlCheckProcess.kill();
    app.quit();
  });
}

// ─── Gamepad Window ───────────────────────────────────────────────────────────

function createGamepadWindow() {
  S.gamepadWindow = new BrowserWindow({
    width       : 1,
    height      : 1,
    show        : false,
    skipTaskbar : true,
    webPreferences: {
      nodeIntegration  : true,
      contextIsolation : false,
    },
  });

  S.gamepadWindow.loadFile('gamepad.html');
  S.gamepadWindow.on('closed', () => { S.gamepadWindow = null; });
}

// ─── Overlay Window ───────────────────────────────────────────────────────────

function createOverlayWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;

  if (S.state.overlayX === null) S.state.overlayX = width - S.state.overlayWidth - 20;
  if (S.state.overlayY === null) S.state.overlayY = 20;

  S.overlayWindow = new BrowserWindow({
    width     : S.state.overlayWidth,
    height    : S.state.overlayHeight,
    x         : S.state.overlayX,
    y         : S.state.overlayY,
    transparent : true,
    frame       : false,
    alwaysOnTop : true,
    skipTaskbar : true,
    resizable   : false,
    webPreferences: {
      nodeIntegration  : true,
      contextIsolation : false,
      webSecurity: false,  // ← ajoute cette ligne
    },
  });

  S.overlayWindow.loadFile('overlay.html');
  S.overlayWindow.setAlwaysOnTop(true, 'pop-up-menu');
  S.overlayWindow.hide();

  S.overlayWindow.on('moved', () => {
    const [x, y] = S.overlayWindow.getPosition();
    S.state.overlayX = x;
    S.state.overlayY = y;
  });

  S.overlayWindow.on('closed', () => { S.overlayWindow = null; });
}

// ─── Fullscreen Cursor Window ─────────────────────────────────────────────────

function createFullscreenCursorWindow() {
  const { width, height } = screen.getPrimaryDisplay().bounds;

  S.fullscreenCursorWindow = new BrowserWindow({
    width, height, x: 0, y: 0,
    transparent : true,
    frame       : false,
    alwaysOnTop : true,
    skipTaskbar : true,
    focusable   : false,
    webPreferences: { nodeIntegration: false },
  });

  S.fullscreenCursorWindow.loadURL(
    `data:text/html,<html><body style="margin:0;background:transparent;cursor:default;width:100vw;height:100vh;pointer-events:none;"></body></html>`
  );
  S.fullscreenCursorWindow.setAlwaysOnTop(true, 'normal');
  S.fullscreenCursorWindow.setIgnoreMouseEvents(true, { forward: true });
  S.fullscreenCursorWindow.hide();

  S.fullscreenCursorWindow.on('closed', () => { S.fullscreenCursorWindow = null; });
}

// ─── Save Window ──────────────────────────────────────────────────────────────

function createSaveWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  S.saveWindow = new BrowserWindow({
    width     : 160,
    height    : 44,
    x         : Math.round(width / 2) - 80,
    y         : height - 80,
    transparent : true,
    frame       : false,
    alwaysOnTop : true,
    skipTaskbar : true,
    resizable   : false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  S.saveWindow.loadFile('overlay-save.html');
  S.saveWindow.setAlwaysOnTop(true, 'pop-up-menu');
  S.saveWindow.hide();
  S.saveWindow.on('closed', () => { S.saveWindow = null; });
}

// ─── Player Overlays ──────────────────────────────────────────────────────────

function createPlayerOverlays() {
  S.playerOverlayWindows.forEach(w => { if (w && !w.isDestroyed()) w.destroy(); });
  S.playerOverlayWindows = [];
  S.slotPositions = {};

  const slotMap = {
    '1v1': [
      { teamNum: 0, teamSlot: 1 },
      { teamNum: 1, teamSlot: 1 },
    ],
    '2v2': [
      { teamNum: 0, teamSlot: 1 }, { teamNum: 0, teamSlot: 2 },
      { teamNum: 1, teamSlot: 1 }, { teamNum: 1, teamSlot: 2 },
    ],
    '3v3': [
      { teamNum: 0, teamSlot: 1 }, { teamNum: 0, teamSlot: 2 }, { teamNum: 0, teamSlot: 3 },
      { teamNum: 1, teamSlot: 1 }, { teamNum: 1, teamSlot: 2 }, { teamNum: 1, teamSlot: 3 },
    ],
  };

  const slots = slotMap[S.currentPlaylist] ?? slotMap['2v2'];

  let savedPositions = [];
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      savedPositions = saved[`playerOverlayPositions_${S.currentPlaylist ?? '2v2'}`] ?? [];
    }
  } catch (e) {}

  slots.forEach((slot, i) => {
    const player = S.gamePlayers[i] ?? null;

    const savedPos = savedPositions.find(
      p => p.teamNum === slot.teamNum && p.teamSlot === slot.teamSlot
    ) ?? null;

    const x = savedPos?.overlayX ?? 20;
    const y = savedPos?.overlayY ?? (20 + i * 46);

    const slotKey = `${slot.teamNum === 0 ? 'blue' : 'orange'}_${slot.teamSlot}`;
    S.slotPositions[slotKey] = { x, y };

    if (player) {
      player.teamNum  = slot.teamNum;
      player.teamSlot = slot.teamSlot;
      player.overlayX = x;
      player.overlayY = y;
    }

    const win = new BrowserWindow({
      width     : 160,
      height    : 36,
      x, y,
      transparent : true,
      frame       : false,
      alwaysOnTop : true,
      skipTaskbar : true,
      resizable   : false,
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });

    win.loadFile('overlay-player.html');
    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.hide();

    win.webContents.on('did-finish-load', () => {
      win.webContents.send('player-data', {
        name     : player?.name     ?? '...',
        mmr      : player?.mmr      ?? null,
        teamNum  : slot.teamNum,
        teamSlot : slot.teamSlot,
      });
    });

    let dragEndTimer;
    win.on('move', () => {
      if (!S.isDraggable) return;
      const [px, py] = win.getPosition();
      if (player) { player.overlayX = px; player.overlayY = py; }
      S.slotPositions[slotKey] = { x: px, y: py };

      win.webContents.send('drag-start');
      clearTimeout(dragEndTimer);
      dragEndTimer = setTimeout(() => {
        win.webContents.send('drag-end');
      }, 300);
    });

    win.on('closed', () => { S.playerOverlayWindows[i] = null; });
    S.playerOverlayWindows.push(win);
  });
}



function createRecapOverlayWindow() {
  const { width, height } = screen.getPrimaryDisplay().bounds;

  S.recapOverlayWindow = new BrowserWindow({
    width, height, x: 0, y: 0,
    transparent : true,
    frame       : false,
    alwaysOnTop : true,
    skipTaskbar : true,
    resizable   : false,
    focusable   : false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  S.recapOverlayWindow.loadURL('http://127.0.0.1:3000/recap');
  S.recapOverlayWindow.webContents.on('did-fail-load', () => {
    setTimeout(() => {
      if (S.recapOverlayWindow && !S.recapOverlayWindow.isDestroyed())
        S.recapOverlayWindow.loadURL('http://127.0.0.1:3000/recap');
    }, 1000);
  });
  S.recapOverlayWindow.setAlwaysOnTop(true, 'pop-up-menu');
  S.recapOverlayWindow.setIgnoreMouseEvents(true, { forward: true });
  S.recapOverlayWindow.on('show', () => {
    S.recapOverlayWindow.setIgnoreMouseEvents(true, { forward: true });
  });
  S.recapOverlayWindow.hide();
  S.recapOverlayWindow.on('closed', () => { S.recapOverlayWindow = null; });
}

function createProdOverlayWindow() {
  const { width, height } = screen.getPrimaryDisplay().bounds;

  S.prodOverlayWindow = new BrowserWindow({
    width       : width,
    height      : height,
    x           : 0,
    y           : 0,
    transparent : true,
    frame       : false,
    alwaysOnTop : true,
    skipTaskbar : true,
    resizable   : false,
    focusable   : false,
    webPreferences: {
      nodeIntegration  : false,
      contextIsolation : true,
    },
  });

  S.prodOverlayWindow.loadURL('http://127.0.0.1:3000/overlay');

  S.prodOverlayWindow.webContents.on('did-fail-load', () => {
    setTimeout(() => {
      if (S.prodOverlayWindow && !S.prodOverlayWindow.isDestroyed())
        S.prodOverlayWindow.loadURL('http://127.0.0.1:3000/overlay');
    }, 1000);
  });
  S.prodOverlayWindow.setAlwaysOnTop(true, 'pop-up-menu');
  S.prodOverlayWindow.setIgnoreMouseEvents(true, { forward: true });
  S.prodOverlayWindow.hide();

  S.prodOverlayWindow.on('closed', () => { S.prodOverlayWindow = null; });
}

module.exports = {
  createMainWindow,
  createGamepadWindow,
  createOverlayWindow,
  createFullscreenCursorWindow,
  createSaveWindow,
  createPlayerOverlays,
  createProdOverlayWindow,
  createRecapOverlayWindow,
};
