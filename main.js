const { app, BrowserWindow, screen, globalShortcut, ipcMain } = require('electron');
const net = require('net');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const STATE_FILE = path.join(app.getPath('userData'), 'rlvision-positions.json');


// ─── Global State ─────────────────────────────────────────────────────────────
let state = {
  mmr: 0,
  wins: 0,
  losses: 0,
  streak: 0,
  mmrGained: 0,
  overlayX: null,
  overlayY: null,
  overlayWidth: 300,
  overlayHeight: 110,
};

// ─── Windows ──────────────────────────────────────────────────────────────────
let mainWindow = null;
let overlayWindow = null;

// ─── RL Socket ────────────────────────────────────────────────────────────────
let client = null;
let reconnectInterval = null;

// ─── RL Detection ─────────────────────────────────────────────────────────────
let rlWasActive = false;
let rlCheckProcess = null;
let hideTimeout = null;

// ─── Player Data ──────────────────────────────────────────────────────────────
let playerID = null;
let myTeamNum = null;
let currentPlaylist = null;
let matchEnded = false;
let initialMMRFetched = false;
// Flag to know when the round has started (all players loaded)
let roundStarted = false;
let gamePlayers = []; // tableau {name, primaryId} de tous les joueurs
let playersLogged = false;
let playerOverlayWindows = []; // fenêtres overlay par joueur
let playerOverlaysEnabled = false; // toggle depuis le main
let fullscreenCursorWindow = null;
let saveWindow = null;
let scoreboardKey = null; // { type: 'keyboard'|'gamepad', code, label }
let isBindingMode = false;
let gamepadWindow = null;
let slotPositions = {}; // { 'blue_1': {x, y}, 'orange_2': {x, y}, ... }
// Ajoute en global
let previousOrder = {}; // { 'blue': ['nom1', 'nom2'], 'orange': ['nom1', 'nom2'] }
let playerWon = null;
let lastTimeSeconds = null;
let lastBOvertime = null;

app.commandLine.appendSwitch('high-dpi-support', '1');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
// Save positions to disk
function savePositionsToDisk() {
  let existing = {};
  try {
    if (fs.existsSync(STATE_FILE)) {
      existing = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {}

  // Sauvegarde les positions des player overlays sous la clé du mode actuel
  const playlist = currentPlaylist ?? '2v2';
  existing.overlayX = state.overlayX;
  existing.overlayY = state.overlayY;
  existing.overlayWidth = state.overlayWidth;
  existing.overlayHeight = state.overlayHeight;
  existing[`playerOverlayPositions_${playlist}`] = gamePlayers.map(p => ({
    teamNum: p.teamNum,
    teamSlot: p.teamSlot,
    overlayX: p.overlayX ?? null,
    overlayY: p.overlayY ?? null,
  }));

  fs.writeFileSync(STATE_FILE, JSON.stringify(existing), 'utf8');
  console.log(`💾 Positions saved for mode: ${playlist}`);
}

function loadPositionsFromDisk() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      state.overlayX = saved.overlayX ?? null;
      state.overlayY = saved.overlayY ?? null;
      state.overlayWidth = saved.overlayWidth ?? 300;
      state.overlayHeight = saved.overlayHeight ?? 110;
      console.log('✅ Positions loaded from disk');
    }
  } catch (e) {
    console.log('⚠️ Could not load positions');
  }
  loadScoreboardKey();
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN WINDOW
// ─────────────────────────────────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 620,
    resizable: false,
    title: 'RLVision',
    backgroundColor: '#0f0f1a',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('main.html');
  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.on('did-finish-load', () => {
    const isConnected = client && !client.destroyed && client.writable;
    sendToMain('rl-connected', isConnected);
    sendToMain('state-update', state);
    if (scoreboardKey) sendToMain('scoreboard-key', scoreboardKey);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (overlayWindow) overlayWindow.destroy();
    if (client) client.destroy();
    if (reconnectInterval) clearInterval(reconnectInterval);
    if (rlCheckProcess) rlCheckProcess.kill();
    app.quit();
  });
}


function createGamepadWindow() {
  gamepadWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  gamepadWindow.loadFile('gamepad.html');
  gamepadWindow.on('closed', () => { gamepadWindow = null; });
}

// ─────────────────────────────────────────────────────────────────────────────
// OVERLAY WINDOW
// ─────────────────────────────────────────────────────────────────────────────
function createOverlayWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;

  if (state.overlayX === null) state.overlayX = width - state.overlayWidth - 20;
  if (state.overlayY === null) state.overlayY = 20;

  overlayWindow = new BrowserWindow({
    width: state.overlayWidth,
    height: state.overlayHeight,
    x: state.overlayX,
    y: state.overlayY,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  overlayWindow.loadFile('overlay.html');
  overlayWindow.setAlwaysOnTop(true, 'pop-up-menu');
  overlayWindow.hide();

  overlayWindow.on('moved', () => {
    const [x, y] = overlayWindow.getPosition();
    state.overlayX = x;
    state.overlayY = y;
  });

  overlayWindow.on('closed', () => { overlayWindow = null; });
}


function createFullscreenCursorWindow() {
  const { width, height } = screen.getPrimaryDisplay().bounds;

  fullscreenCursorWindow = new BrowserWindow({
    width, height, x: 0, y: 0,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    webPreferences: { nodeIntegration: false }
  });

  // Page transparente qui montre juste le curseur
  fullscreenCursorWindow.loadURL(`data:text/html,<html><body style="margin:0;background:transparent;cursor:default;width:100vw;height:100vh;pointer-events:none;"></body></html>`);
  fullscreenCursorWindow.setAlwaysOnTop(true, 'normal');
  fullscreenCursorWindow.setIgnoreMouseEvents(true, { forward: true });
  fullscreenCursorWindow.hide();

  fullscreenCursorWindow.on('closed', () => { fullscreenCursorWindow = null; });
}



function createSaveWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  saveWindow = new BrowserWindow({
    width: 160,
    height: 44,
    x: Math.round(width / 2) - 80,
    y: height - 80,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  saveWindow.loadFile('overlay-save.html');
  saveWindow.setAlwaysOnTop(true, 'pop-up-menu');
  saveWindow.hide();
  saveWindow.on('closed', () => { saveWindow = null; });
}

function createPlayerOverlays() {
  playerOverlayWindows.forEach(w => { if (w && !w.isDestroyed()) w.destroy(); });
  playerOverlayWindows = [];
  slotPositions = {}; // reset

  const slotMap = {
    '1v1': [
      { teamNum: 0, teamSlot: 1 },
      { teamNum: 1, teamSlot: 1 },
    ],
    '2v2': [
      { teamNum: 0, teamSlot: 1 },
      { teamNum: 0, teamSlot: 2 },
      { teamNum: 1, teamSlot: 1 },
      { teamNum: 1, teamSlot: 2 },
    ],
    '3v3': [
      { teamNum: 0, teamSlot: 1 },
      { teamNum: 0, teamSlot: 2 },
      { teamNum: 0, teamSlot: 3 },
      { teamNum: 1, teamSlot: 1 },
      { teamNum: 1, teamSlot: 2 },
      { teamNum: 1, teamSlot: 3 },
    ],
  };

  const slots = slotMap[currentPlaylist] ?? slotMap['2v2'];

  let savedPositions = [];
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const playlist = currentPlaylist ?? '2v2';
      savedPositions = saved[`playerOverlayPositions_${playlist}`] ?? [];
    }
  } catch (e) {}

  slots.forEach((slot, i) => {
    const player = gamePlayers[i] ?? null;

    const savedPos = savedPositions.find(p =>
      p.teamNum === slot.teamNum && p.teamSlot === slot.teamSlot
    ) ?? null;

    const x = savedPos?.overlayX ?? 20;
    const y = savedPos?.overlayY ?? (20 + i * 46);

    // Clé de slot unique
    const slotKey = `${slot.teamNum === 0 ? 'blue' : 'orange'}_${slot.teamSlot}`;
    slotPositions[slotKey] = { x, y };

    if (player) {
      player.teamNum = slot.teamNum;
      player.teamSlot = slot.teamSlot;
      player.overlayX = x;
      player.overlayY = y;
    }

    const win = new BrowserWindow({
      width: 160,
      height: 36,
      x, y,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });

    win.loadFile('overlay-player.html');
    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.hide();

    win.webContents.on('did-finish-load', () => {
      win.webContents.send('player-data', {
        name: player?.name ?? '...',
        mmr: player?.mmr ?? null,
        teamNum: slot.teamNum,
        teamSlot: slot.teamSlot,
      });
    });

    let isDraggable = false;

    // Dans createPlayerOverlays(), remplace le win.on('move') :
    win.on('move', () => {
      if (!isDraggable) return;
      const [px, py] = win.getPosition();
      if (player) { player.overlayX = px; player.overlayY = py; }
      slotPositions[slotKey] = { x: px, y: py };
      win.webContents.send('drag-start');
      clearTimeout(dragEndTimer);
      dragEndTimer = setTimeout(() => {
        win.webContents.send('drag-end');
      }, 300);
    });

    win.on('closed', () => { playerOverlayWindows[i] = null; });
    playerOverlayWindows.push(win);
  });
}



function startBindingMode() {
  isBindingMode = true;

  // Écoute clavier
  const ps = spawn('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Add-Type @"
      using System;
      using System.Runtime.InteropServices;
      public class KeyBinder {
        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int vKey);
      }
"@
    $ignored = @(1, 2, 4, 5, 6)
    Start-Sleep -Milliseconds 500
    $keys = 0..254
    while($true) {
      foreach ($k in $keys) {
        if ($ignored -contains $k) { continue }
        $s = [KeyBinder]::GetAsyncKeyState($k)
        if ($s -band 0x0001) {
          Write-Output "KEY:$k"
          exit
        }
      }
      Start-Sleep -Milliseconds 50
    }`
  ]);

  ps.stdout.on('data', (data) => {
    if (!isBindingMode) { ps.kill(); return; }
    const line = data.toString().trim();
    if (line.startsWith('KEY:')) {
      const code = parseInt(line.replace('KEY:', ''));
      const label = getKeyLabel(code);
      scoreboardKey = { type: 'keyboard', code, label };
      isBindingMode = false;
      ps.kill();
      saveScoreboardKey();
      sendToMain('binding-captured', scoreboardKey);
    }
  });

  ps.stderr.on('data', (d) => console.log('PS bind err:', d.toString()));

  // Écoute manette XInput
  const psGamepad = spawn('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Add-Type @"
      using System;
      using System.Runtime.InteropServices;
      public class XInputBinder {
        [DllImport("xinput1_4.dll")]
        public static extern int XInputGetState(int dwUserIndex, IntPtr pState);
        public static short GetButtons(IntPtr pState) {
          return Marshal.ReadInt16(pState, 4);
        }
        public static IntPtr AllocState() {
          return Marshal.AllocHGlobal(16);
        }
      }
"@
    $ptr = [XInputBinder]::AllocState()
    $prevButtons = 0
    Start-Sleep -Milliseconds 500
    while($true) {
      $result = [XInputBinder]::XInputGetState(0, $ptr)
      if ($result -eq 0) {
        $buttons = [XInputBinder]::GetButtons($ptr)
        $newPress = $buttons -band (-bnot $prevButtons)
        if ($newPress -ne 0) {
          Write-Output "BTN:$newPress"
          exit
        }
        $prevButtons = $buttons
      }
      Start-Sleep -Milliseconds 50
    }`
  ]);

  psGamepad.stdout.on('data', (data) => {
    if (!isBindingMode) { psGamepad.kill(); return; }
    const line = data.toString().trim();
    if (line.startsWith('BTN:')) {
      const code = parseInt(line.replace('BTN:', ''));
      const label = getGamepadButtonLabel(code);
      scoreboardKey = { type: 'gamepad', code, label };
      isBindingMode = false;
      psGamepad.kill();
      saveScoreboardKey();
      sendToMain('binding-captured', scoreboardKey);
    }
  });

  psGamepad.stderr.on('data', (d) => console.log('🎮 Gamepad bind err:', d.toString()));
}

function getKeyLabel(code) {
  const map = {
    9: 'Tab', 13: 'Enter', 16: 'Shift', 17: 'Ctrl', 18: 'Alt',
    32: 'Space', 37: '←', 38: '↑', 39: '→', 40: '↓',
    112: 'F1', 113: 'F2', 114: 'F3', 115: 'F4',
    116: 'F5', 117: 'F6', 118: 'F7', 119: 'F8',
  };
  if (map[code]) return map[code];
  if (code >= 65 && code <= 90) return String.fromCharCode(code);
  if (code >= 48 && code <= 57) return String.fromCharCode(code);
  return `Key(${code})`;
}

function getGamepadButtonLabel(button) {
  const map = {
    0: 'A', 1: 'B', 2: 'X', 3: 'Y',
    4: 'LB', 5: 'RB',
    6: 'LT', 7: 'RT',
    8: 'Back', 9: 'Start',
    10: 'LS', 11: 'RS',
    12: 'D-pad Haut', 13: 'D-pad Bas',
    14: 'D-pad Gauche', 15: 'D-pad Droite',
  };
  return map[button] ?? `Btn(${button})`;
}

function saveScoreboardKey() {
  try {
    let existing = {};
    if (fs.existsSync(STATE_FILE)) {
      existing = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
    existing.scoreboardKey = scoreboardKey;
    fs.writeFileSync(STATE_FILE, JSON.stringify(existing), 'utf8');
    console.log('💾 Scoreboard key saved:', scoreboardKey);
  } catch (e) {}
}

function loadScoreboardKey() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (saved.scoreboardKey) {
        scoreboardKey = saved.scoreboardKey;
        console.log('✅ Scoreboard key loaded:', scoreboardKey);
      }
    }
  } catch (e) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// ROCKET LEAGUE DETECTION
// ─────────────────────────────────────────────────────────────────────────────


// ─── Alt Key Detection ────────────────────────────────────────────────────────
let altKeyProcess = null;  // ← GLOBAL (hors de toute fonction)
let altIsHeld = false;     // ← GLOBAL

function startAltKeyDetection() {
  altKeyProcess = spawn('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Add-Type @"
      using System;
      using System.Runtime.InteropServices;
      public class KeyState {
        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int vKey);
      }
"@
    while($true) {
      $alt = [KeyState]::GetAsyncKeyState(0x12)
      if ($alt -band 0x8000) {
        Write-Output 'ALT_DOWN'
      } else {
        Write-Output 'ALT_UP'
      }
      Start-Sleep -Milliseconds 100
    }`
  ]);

  altKeyProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').map(l => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];

    if (last === 'ALT_DOWN' && !altIsHeld) {
        altIsHeld = true;
        isDraggable = true;  // ← active
        showPlayerOverlays(); // ← ajoute

      if (saveWindow && !saveWindow.isDestroyed()) {
        saveWindow.showInactive();
        saveWindow.setAlwaysOnTop(true, 'pop-up-menu');
      }

      if (fullscreenCursorWindow && !fullscreenCursorWindow.isDestroyed()) {
        fullscreenCursorWindow.showInactive();
        fullscreenCursorWindow.setAlwaysOnTop(true, 'normal');
        // Toujours forwarder les clics, juste afficher le curseur
        fullscreenCursorWindow.setIgnoreMouseEvents(true, { forward: true }); // ← WAS false
      }

      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.setIgnoreMouseEvents(false);
        overlayWindow.setAlwaysOnTop(true, 'pop-up-menu');
      }
      playerOverlayWindows.forEach(w => {
        if (w && !w.isDestroyed()) {
          w.setIgnoreMouseEvents(false);
          w.setAlwaysOnTop(true, 'pop-up-menu');
        }
      });
      if (saveWindow && !saveWindow.isDestroyed()) {
        saveWindow.setIgnoreMouseEvents(false);
        saveWindow.setAlwaysOnTop(true, 'pop-up-menu');
      }

    } else if (last === 'ALT_UP' && altIsHeld) {
      altIsHeld = false;
      isDraggable = false;  // ← désactive
      hidePlayerOverlays(); // ← ajoute
      if (saveWindow && !saveWindow.isDestroyed()) saveWindow.hide();
      // Cache la fenêtre plein écran → curseur disparaît
      if (fullscreenCursorWindow && !fullscreenCursorWindow.isDestroyed()) {
        fullscreenCursorWindow.setIgnoreMouseEvents(true, { forward: true });
        fullscreenCursorWindow.hide();
      }
      if (overlayWindow && !overlayWindow.isDestroyed())
        overlayWindow.setIgnoreMouseEvents(true, { forward: true });
      playerOverlayWindows.forEach(w => {
        if (w && !w.isDestroyed()) w.setIgnoreMouseEvents(true, { forward: true });
      });
    }
  });

  altKeyProcess.stderr.on('data', () => {});
}
function startRLDetection() {
  const ps = spawn('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `while($true) {
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class ForegroundWindow {
          [DllImport("user32.dll")]
          public static extern IntPtr GetForegroundWindow();
          [DllImport("user32.dll")]
          public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
        }
"@
      $hwnd = [ForegroundWindow]::GetForegroundWindow()
      $procId = 0
      [ForegroundWindow]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
      $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
      if ($proc -and $proc.Name -eq 'RocketLeague') {
        Write-Output 'RL_OPEN'
      } else {
        Write-Output 'RL_CLOSED'
      }
      Start-Sleep -Milliseconds 500
    }`
  ]);

  rlCheckProcess = ps;

  ps.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) return;
    const lastLine = lines[lines.length - 1];
    const isRLFocused = lastLine.includes('RL_OPEN');

    // Ne skip que si on est en train de dragger un overlay (altIsHeld)
    if (altIsHeld) return;

    if (isRLFocused && !rlWasActive) {
      if (hideTimeout) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
      }
      rlWasActive = true;
      showOverlay();
    } else if (!isRLFocused && rlWasActive) {
      if (!hideTimeout) {
        hideTimeout = setTimeout(() => {
          if (altIsHeld) {
            hideTimeout = null;
            return;
          }
          rlWasActive = false;
          hideOverlay();
          hideTimeout = null;
        }, 1000);
      }
    }
  });

  ps.stderr.on('data', () => {});
}

function showOverlay() {
  if (overlayWindow) {
    overlayWindow.showInactive();
    overlayWindow.setAlwaysOnTop(true, 'pop-up-menu');
    sendToOverlay('state-update', state);
  }
  // Player overlays gérés uniquement par la touche scoreboard
}

function hideOverlay() {
  if (overlayWindow) overlayWindow.hide();
  // Player overlays gérés uniquement par la touche scoreboard
}

// ─────────────────────────────────────────────────────────────────────────────
// ROCKET LEAGUE STATS API CONNECTION
// ─────────────────────────────────────────────────────────────────────────────
function connectToRL() {
  if (client) { client.destroy(); client = null; }

  client = new net.Socket();

  // Port 49123 is the default SOS plugin (Rocket League Stats) TCP port
  client.connect(49123, '127.0.0.1', () => {
    console.log('✅ Connected to RL Stats API');
    sendToMain('rl-connected', true);
    sendToOverlay('rl-connected', true);
    if (reconnectInterval) {
      clearInterval(reconnectInterval);
      reconnectInterval = null;
    }
  });


  client.on('data', (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.Data && typeof message.Data === 'string') {
        message.Data = JSON.parse(message.Data);
      }
      handleRLEvent(message);
    } catch (e) {
      // Silently ignore parse errors
    }
  });

  client.on('error', () => { sendToMain('rl-connected', false); startReconnect(); });
  client.on('close', () => { sendToMain('rl-connected', false); startReconnect(); });
  }

function startReconnect() {
  if (reconnectInterval) return;
  reconnectInterval = setInterval(connectToRL, 5000);
}

// ─────────────────────────────────────────────────────────────────────────────
// RL EVENT HANDLER
// ─────────────────────────────────────────────────────────────────────────────
function handleRLEvent(message) {
  const { Event, Data } = message;

  if (Event === 'MatchCreated' || Event === 'MatchInitialized') {
    matchEnded = false;
    myTeamNum = null;
    currentPlaylist = null;
    initialMMRFetched = false;
    roundStarted = false;
    playerID = null;
    gamePlayers = [];
    playersLogged = false;
    playerOverlayWindows.forEach(w => { if (w && !w.isDestroyed()) w.destroy(); });
    playerOverlayWindows = [];
    previousOrder = {};
  }

  if (Event === 'RoundStarted') {
    roundStarted = true;
    console.log('🚀 Round started, all players loaded!');
  }

  if (Event === 'UpdateState' && Data && Data.Players) {
    const timeSeconds = Data.Game?.TimeSeconds ?? null;


    if (Data.Game) lastTimeSeconds = Data.Game.TimeSeconds ?? null;

    function formatTime(seconds) {
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60);
      return `${m}:${s.toString().padStart(2, '0')}`;
    }

    if (roundStarted && !playersLogged && Data.Players.length > 0) {
      playersLogged = true;

      gamePlayers = Data.Players.map(p => ({
        name: p.Name,
        primaryId: p.PrimaryId && !p.PrimaryId.startsWith('Unknown') ? p.PrimaryId : null,
        teamNum: p.TeamNum,
      }));

      gamePlayers.sort((a, b) => a.teamNum - b.teamNum);

      console.log('─────────────────────────────');
      console.log('👥 Players found:', gamePlayers.length);
      gamePlayers.forEach(p => console.log(`   • [${p.teamNum === 0 ? 'Blue' : 'Orange'}] ${p.name} — ${p.primaryId}`));
      console.log('─────────────────────────────');

      for (const player of gamePlayers) {
        if (player.primaryId === playerID) continue;
        if (!player.primaryId) continue;
        fetchRealMMR(false, player.primaryId).then(mmr => {
          player.mmr = mmr;
          const idx = gamePlayers.indexOf(player);
          const win = playerOverlayWindows[idx];
          if (win && !win.isDestroyed()) {
            win.webContents.send('player-data', {
              name: player.name,
              mmr,
              teamNum: player.teamNum,
              teamSlot: player.teamSlot,
            });
          }
        });
      }
    }

    // Step 1: Identify player via camera target
    if (!playerID && roundStarted && Data.Game && Data.Game.bHasTarget && Data.Game.Target) {
      const targetName = Data.Game.Target.Name;
      const me = Data.Players.find(p => p.Name === targetName);
      if (me && me.PrimaryId) {
        playerID = me.PrimaryId;
        myTeamNum = me.TeamNum;
        console.log('👤 Player identified via camera target:', me.Name);
        console.log('👤 Team:', myTeamNum === 0 ? 'Blue' : 'Orange');
      }
    }

    // Step 2: Detect playlist
    if (playerID && currentPlaylist === null && !matchEnded && roundStarted) {
      const totalPlayers = Data.Players.length;

      if (totalPlayers === 2) currentPlaylist = '1v1';
      else if (totalPlayers === 4) currentPlaylist = '2v2';
      else if (totalPlayers === 6) currentPlaylist = '3v3';
      else return; // free play ou mode non supporté

      console.log('🎮 Playlist detected:', currentPlaylist, '| Total players:', totalPlayers);

      if (playerOverlaysEnabled) createPlayerOverlays();
    }

    // Step 3: Fetch MMR once both are ready
    if (playerID && currentPlaylist !== null && !initialMMRFetched) {
      initialMMRFetched = true;
      console.log('🎮 Ready, fetching MMR...');
      sendToMain('mmr-source', 'fetching');
      fetchRealMMR();
    }

    // Step 4: Tri par score en temps réel → met à jour le contenu des overlays
    if (roundStarted && gamePlayers.length > 0 && playerOverlayWindows.length > 0) {
      const blueTeam = gamePlayers.filter(p => p.teamNum === 0);
      const orangeTeam = gamePlayers.filter(p => p.teamNum === 1);

      for (const team of [blueTeam, orangeTeam]) {
        const teamKey = team[0].teamNum === 0 ? 'blue' : 'orange';

        team.forEach(p => {
          const live = Data.Players.find(lp => lp.Name === p.name);
          if (live) p.liveScore = live.Score ?? 0;
        });

        const sorted = [...team].sort((a, b) => b.liveScore - a.liveScore);
        const newOrder = sorted.map(p => p.name);
        const prevOrder = previousOrder[teamKey] ?? [];

        // Ne met à jour que si l'ordre a changé
        const orderChanged = newOrder.some((name, i) => name !== prevOrder[i]);
        if (!orderChanged) continue;

        previousOrder[teamKey] = newOrder;

        sorted.forEach((player, i) => {
          const targetSlot = i + 1;
          const slotIndex = gamePlayers.findIndex(
            p => p.teamNum === team[0].teamNum && p.teamSlot === targetSlot
          );
          const win = playerOverlayWindows[slotIndex];
          if (win && !win.isDestroyed()) {
            win.webContents.send('player-data', {
              name: player.name,
              mmr: player.mmr ?? null,
              teamNum: team[0].teamNum,
              teamSlot: targetSlot,
            });
          }
        });
      }
    }


    if(Data.Game.bOvertime){
      lastBOvertime = true;
    }

    if (Data.Game && !matchEnded) {
      if (Data.Game.TimeSeconds === 0 || lastBOvertime) {
        const teams = Data.Game.Teams;
        if (teams && teams.length >= 2) {
          const blueScore = teams.find(t => t.TeamNum === 0)?.Score ?? 0;
          const orangeScore = teams.find(t => t.TeamNum === 1)?.Score ?? 0;
          const winnerTeam = blueScore > orangeScore ? 0 : 1;
          playerWon = winnerTeam === myTeamNum;
          console.log('🚪 MatchDestroyed | playerWon:', playerWon);
        }
      }
    }
  }

  if (Event === 'MatchEnded' && !matchEnded) {
    matchEnded = true;
    const playerTeam = myTeamNum !== null ? myTeamNum : 0;
    const won = Data.WinnerTeamNum === playerTeam;

    console.log(`🏁 Match ended | ${won ? 'WIN' : 'LOSS'}`);

    if (won) {
      state.wins++;
      state.streak = state.streak > 0 ? state.streak + 1 : 1;
    } else {
      state.losses++;
      state.streak = state.streak < 0 ? state.streak - 1 : -1;
    }

    broadcastState();

    playerOverlayWindows.forEach(w => { if (w && !w.isDestroyed()) w.destroy(); });
    playerOverlayWindows = [];
    currentPlaylist = null;
    console.log('⏳ Waiting for rlstats.net to update...');
    sendToMain('mmr-source', 'fetching');
    fetchRealMMRWithRetry();
  }


  if (Event === 'MatchDestroyed') {
    console.log('🚪 MatchDestroyed | playerWon:', playerWon);
    const savedPlaylist = currentPlaylist; // ← sauvegarde
    if (currentPlaylist !== null) {
      if (lastTimeSeconds !== 0 && !lastBOvertime) playerWon = false;
      if (playerWon === null) playerWon = false;

      if (playerWon) {
        state.wins++;
        state.streak = state.streak > 0 ? state.streak + 1 : 1;
      } else {
        state.losses++;
        state.streak = state.streak < 0 ? state.streak - 1 : -1;
      }
      broadcastState();
      sendToMain('mmr-source', 'fetching');
      fetchRealMMRWithRetry(savedPlaylist); // ← passe la playlist
      
    }

    playerOverlayWindows.forEach(w => { if (w && !w.isDestroyed()) w.destroy(); });
    playerOverlayWindows = [];
    gamePlayers = [];
    currentPlaylist = null;
    roundStarted = false;
    playersLogged = false;
    previousOrder = {};
    playerWon = null;
    lastTimeSeconds = null;
    console.log('🚪 Match destroyed');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REAL MMR FETCH VIA RLSTATS.NET
// ─────────────────────────────────────────────────────────────────────────────
async function fetchRealMMR(fromMatch = false, primaryId = playerID, playlist = currentPlaylist) {
  const isMe = primaryId === playerID;
  if (!primaryId) return null;

  try {
    const parts = primaryId.split('|');
    const platform = parts[0];
    const id = parts[1];

    console.log('🔍 Platform:', platform, '| ID:', id);

    let url;
    if (platform.toLowerCase() === 'epic') {
      url = `https://rlstats.net/profile/Epic/${id}`;
    } else if (platform.toLowerCase() === 'steam') {
      url = `https://rlstats.net/profile/Steam/${id}`;
    } else if (platform.toLowerCase() === 'xboxone') {
      url = `https://rlstats.net/profile/Xbox/${id}`;
    } else if (platform.toLowerCase() === 'ps4') {
      url = `https://rlstats.net/profile/PS4/${id}`;
    } else if (platform.toLowerCase() === 'switch') {
      console.log('⚠️ Switch not supported by rlstats.net, skipping:', id);
      return null;
    } else {
      console.log('⚠️ Unknown platform:', platform);
      return null;
    }

    console.log('🌐 Fetching URL:', url);

    const response = await fetch(url);
    const html = await response.text();
    const dataMatch = html.match(/new Date\(\d+\*1000\),\s*([\d,\s]+)/);

    if (dataMatch) {
      const values = dataMatch[1].split(',').map(v => parseInt(v.trim())).filter(v => !isNaN(v));
      console.log('📊 MMR values:', values);

      let realMMR = null;
      if (playlist === '1v1') realMMR = values[0];
      else if (playlist === '2v2') realMMR = values[1];
      else if (playlist === '3v3') realMMR = values[2];
      else realMMR = values[1];

      if (realMMR) {
        console.log('✅ Real MMR found:', realMMR, '(' + (playlist || '2v2') + ')');

        if (isMe) {
          if (fromMatch && state.mmr !== 0) {
            const diff = realMMR - state.mmr;
            state.mmrGained += diff;
          }
          state.mmr = realMMR;
          broadcastState();
          sendToMain('mmr-source', 'real');

          // ← Ajoute : met à jour l'overlay du joueur local
          const meIdx = gamePlayers.findIndex(p => p.primaryId === playerID);
          if (meIdx !== -1) {
            gamePlayers[meIdx].mmr = realMMR;
            const win = playerOverlayWindows[meIdx];
            if (win && !win.isDestroyed()) {
              win.webContents.send('player-data', {
                name: gamePlayers[meIdx].name,
                mmr: realMMR,
                teamNum: gamePlayers[meIdx].teamNum,
                teamSlot: gamePlayers[meIdx].teamSlot,
              });
            }
          }
        }

        return realMMR;
      } else {
        console.log('⚠️ MMR not found in parsed values');
        if (isMe) sendToMain('mmr-source', 'estimated');
        return null;
      }
    } else {
      console.log('⚠️ MMR pattern not found in HTML');
      if (isMe) sendToMain('mmr-source', 'estimated');
      return null;
    }
  } catch (err) {
    console.error('❌ MMR fetch error:', err.message);
    if (isMe) sendToMain('mmr-source', 'estimated');
    return null;
  }
}

function startScoreboardKeyDetection() {
  if (!scoreboardKey || scoreboardKey.type !== 'keyboard') return;

  const ps = spawn('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Add-Type @"
      using System;
      using System.Runtime.InteropServices;
      public class ScoreboardKey {
        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int vKey);
      }
"@
    $wasDown = $false
    while($true) {
      $state = [ScoreboardKey]::GetAsyncKeyState(${scoreboardKey.code})
      $isDown = ($state -band 0x8000) -ne 0
      if ($isDown -and -not $wasDown) {
        Write-Output 'SCOREBOARD_DOWN'
      } elseif (-not $isDown -and $wasDown) {
        Write-Output 'SCOREBOARD_UP'
      }
      $wasDown = $isDown
      Start-Sleep -Milliseconds 50
    }`
  ]);

  ps.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').map(l => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    if (last === 'SCOREBOARD_DOWN') showPlayerOverlays();
    else if (last === 'SCOREBOARD_UP') hidePlayerOverlays();
  });

  ps.stderr.on('data', () => {});
  return ps;
}

async function fetchRealMMRWithRetry(playlist, retries = 5, delay = 15000) {
  const mmrBeforeMatch = state.mmr; // ← sauvegarde avant tout retry

  for (let i = 0; i < retries; i++) {
    await new Promise(res => setTimeout(res, i === 0 ? 10000 : delay));
    
    // Fetch sans fromMatch pour ne pas accumuler pendant les retries
    await fetchRealMMR(false, playerID, playlist);

    if (state.mmr !== mmrBeforeMatch) {
      // Calculer le diff une seule fois ici
      const diff = state.mmr - mmrBeforeMatch;
      state.mmrGained += diff;
      console.log('📈 MMR diff:', diff > 0 ? `+${diff}` : diff);
      broadcastState();
      console.log('✅ MMR updated after', i + 1, 'attempt(s)');
      return;
    }
    console.log(`⏳ MMR unchanged, retrying... (${i + 1}/${retries})`);
  }
  console.log('⚠️ MMR did not update after all retries');
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC COMMUNICATION
// ─────────────────────────────────────────────────────────────────────────────
function sendToMain(channel, data) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send(channel, data);
  }
}

function sendToOverlay(channel, data) {
  if (overlayWindow && overlayWindow.webContents) {
    overlayWindow.webContents.send(channel, data);
  }
}

function broadcastState() {
  sendToMain('state-update', state);
  sendToOverlay('state-update', state);
}


function showPlayerOverlays() {
  if (playerOverlayWindows.length === 0) return;
  playerOverlayWindows.forEach((w) => {
    if (w && !w.isDestroyed()) w.showInactive();
  });
}

function hidePlayerOverlays() {
  if (playerOverlayWindows.length === 0) return;
  playerOverlayWindows.forEach((w) => {
    if (w && !w.isDestroyed()) w.hide();
  });
}

ipcMain.on('get-state', (event) => { event.reply('state-update', state); });
ipcMain.on('set-mmr', (event, value) => { state.mmr = parseInt(value) || 0; broadcastState(); });
ipcMain.on('reset-stats', () => { state.wins = 0; state.losses = 0; state.streak = 0; state.mmrGained = 0; broadcastState(); });
ipcMain.on('refresh-mmr', () => {
  console.log('🔄 Manual MMR refresh');
  fetchRealMMR();
});

ipcMain.on('toggle-player-overlays', (_, enabled) => {
  playerOverlaysEnabled = enabled;
  if (enabled) {
    if (gamePlayers.length > 0) createPlayerOverlays();
  } else {
    playerOverlayWindows.forEach(w => { if (w && !w.isDestroyed()) w.destroy(); });
    playerOverlayWindows = [];
  }
});

ipcMain.on('start-binding', () => startBindingMode());
ipcMain.on('stop-binding', () => { isBindingMode = false; });
ipcMain.on('clear-binding', () => {
  scoreboardKey = null;
  saveScoreboardKey();
});


ipcMain.on('gamepad-connected', (_, data) => {
});

ipcMain.on('gamepad-disconnected', (_, data) => {
});

ipcMain.on('gamepad-button-down', (_, data) => {
  if (isBindingMode) {
    const label = getGamepadButtonLabel(data.button);
    scoreboardKey = { type: 'gamepad', button: data.button, label };
    isBindingMode = false;
    saveScoreboardKey();
    sendToMain('binding-captured', scoreboardKey);
    return;
  }

  // Scoreboard key detection
  if (scoreboardKey && scoreboardKey.type === 'gamepad' && data.button === scoreboardKey.button) {
    showPlayerOverlays();
  }
});

ipcMain.on('gamepad-button-up', (_, data) => {
  if (scoreboardKey && scoreboardKey.type === 'gamepad' && data.button === scoreboardKey.button) {
    hidePlayerOverlays();
  }
});



ipcMain.on('save-overlay-positions', () => {
  if (overlayWindow) {
    const [x, y] = overlayWindow.getPosition();
    state.overlayX = x;
    state.overlayY = y;
  }
  playerOverlayWindows.forEach((w, i) => {
    if (w && !w.isDestroyed() && gamePlayers[i]) {
      const [x, y] = w.getPosition();
      gamePlayers[i].overlayX = x;
      gamePlayers[i].overlayY = y;
    }
  });
  console.log('💾 Positions saved!');
  savePositionsToDisk();
  if (saveWindow && !saveWindow.isDestroyed()) saveWindow.hide();
  if (fullscreenCursorWindow && !fullscreenCursorWindow.isDestroyed()) {
    fullscreenCursorWindow.setIgnoreMouseEvents(true, { forward: true });
    fullscreenCursorWindow.hide();
  }
  if (overlayWindow && !overlayWindow.isDestroyed())
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  playerOverlayWindows.forEach(w => {
    if (w && !w.isDestroyed()) w.setIgnoreMouseEvents(true, { forward: true });
  });
  altIsHeld = false;
});

ipcMain.on('set-overlay-size', (event, { width, height }) => {
  state.overlayWidth = width;
  state.overlayHeight = height;
  if (overlayWindow) {
    overlayWindow.setSize(width, height);
    overlayWindow.webContents.executeJavaScript(`
      document.body.style.width = '${width}px';
      document.body.style.height = '${height}px';
    `);
    sendToOverlay('state-update', state);
  }
  savePositionsToDisk(); // ← AJOUTE ICI AUSSI
});

ipcMain.on('open-main', () => {
  if (mainWindow) { mainWindow.focus(); } else { createMainWindow(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// APP INIT
// ─────────────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
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

  globalShortcut.register('CommandOrControl+Shift+H', () => {
    if (overlayWindow) {
      if (overlayWindow.isVisible()) { overlayWindow.hide(); }
      else { overlayWindow.showInactive(); }
    }
  });
});

app.on('window-all-closed', () => { app.quit(); });

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (client) client.destroy();
  if (rlCheckProcess) rlCheckProcess.kill();
  if (altKeyProcess) altKeyProcess.kill(); // ← AJOUTE
  if (fullscreenCursorWindow) fullscreenCursorWindow.destroy();
});