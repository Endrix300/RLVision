const { app, BrowserWindow, screen, globalShortcut, ipcMain } = require('electron');
const net = require('net');
const { exec, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');


// Path where window positions and settings are persisted between sessions
const STATE_FILE = path.join(app.getPath('userData'), 'rlvision-positions.json');

// ─── Global State ─────────────────────────────────────────────────────────────

// Session stats and overlay position — shared between the main window and the overlay
let state = {
  mmr        : 0,
  wins       : 0,
  losses     : 0,
  streak     : 0,
  mmrGained  : 0,
  overlayX   : null,
  overlayY   : null,
  overlayWidth : 300,
  overlayHeight: 110,
};

// ─── Windows ──────────────────────────────────────────────────────────────────

let mainWindow           = null; // Main settings/stats window
let overlayWindow        = null; // Transparent in-game MMR overlay

// ─── RL Socket ────────────────────────────────────────────────────────────────

let client           = null; // Active TCP connection to the SOS plugin
let reconnectInterval = null; // Interval handle for automatic reconnection attempts

// ─── RL Detection ─────────────────────────────────────────────────────────────

let rlWasActive    = false; // Tracks whether RL was the foreground window on the last check
let rlCheckProcess = null;  // PowerShell process that polls for RL focus
let hideTimeout    = null;  // Debounce timer for hiding the overlay when RL loses focus
let rlInstallPath = null; // Chemin vers CookedPCConsole, détecté automatiquement

// ─── Player Data ──────────────────────────────────────────────────────────────

let playerID          = null;  // Local player's primary ID (platform|id format)
let myTeamNum         = null;  // Local player's team (0 = Blue, 1 = Orange)
let currentPlaylist   = null;  // Active playlist: '1v1', '2v2', or '3v3'
let matchEnded        = false; // Prevents double-counting wins/losses
let initialMMRFetched = false; // Prevents multiple MMR fetches at match start
let roundStarted      = false; // True once RoundStarted fires (all players are loaded)
let gamePlayers       = [];    // Array of player objects for the current match
let playersLogged     = false; // Prevents logging the player list more than once per match

// ─── Player Overlay Windows ───────────────────────────────────────────────────

let playerOverlayWindows  = []; // One BrowserWindow per player slot
let playerOverlaysEnabled = false; // Controlled by the main window toggle

// ─── UI / Drag State ──────────────────────────────────────────────────────────

let fullscreenCursorWindow = null; // Transparent fullscreen window used to show cursor during drag
let saveWindow             = null; // Small "Save positions" confirmation overlay
let isDraggable            = false; // True while Alt is held — overlays become draggable

// ─── Scoreboard Key Binding ───────────────────────────────────────────────────

let scoreboardKey  = null;  // { type: 'keyboard'|'gamepad', code|button, label }
let isBindingMode  = false; // True while waiting for the user to press a key/button
let gamepadWindow  = null;  // Hidden window that polls gamepad state via the Gamepad API

// ─── Slot Positions ───────────────────────────────────────────────────────────

let slotPositions  = {}; // { 'blue_1': {x, y}, 'orange_2': {x, y}, ... }

// ─── Live Score Tracking ──────────────────────────────────────────────────────

let previousOrder  = {}; // Tracks { blue: ['name1', 'name2'], orange: [...] } to detect reordering
let playerWon      = null; // Outcome of the last match (true = win, false = loss)
let lastTimeSeconds = null; // Last known game clock value
let lastBOvertime   = null; // True if overtime was triggered during the match

// ─── Startup Flags ───────────────────────────────────────────────────────────

// Ensure DPI scaling doesn't affect overlay positioning
app.commandLine.appendSwitch('high-dpi-support', '1');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

// ─── Persistence ─────────────────────────────────────────────────────────────

/**
 * Saves overlay window positions and player slot positions to disk.
 * Player positions are keyed by playlist so each mode has its own layout.
 */
function savePositionsToDisk() {
  let existing = {};
  try {
    if (fs.existsSync(STATE_FILE)) {
      existing = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {}

  const playlist = currentPlaylist ?? '2v2';
  existing.overlayX      = state.overlayX;
  existing.overlayY      = state.overlayY;
  existing.overlayWidth  = state.overlayWidth;
  existing.overlayHeight = state.overlayHeight;

  // Save each player slot's position indexed by team and slot number
  existing[`playerOverlayPositions_${playlist}`] = gamePlayers.map(p => ({
    teamNum  : p.teamNum,
    teamSlot : p.teamSlot,
    overlayX : p.overlayX ?? null,
    overlayY : p.overlayY ?? null,
  }));

  fs.writeFileSync(STATE_FILE, JSON.stringify(existing), 'utf8');
  console.log(`💾 Positions saved for mode: ${playlist}`);
}

/**
 * Loads persisted overlay positions and the scoreboard key binding from disk.
 * Called once during app startup.
 */
function loadPositionsFromDisk() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      state.overlayX      = saved.overlayX      ?? null;
      state.overlayY      = saved.overlayY      ?? null;
      state.overlayWidth  = saved.overlayWidth  ?? 300;
      state.overlayHeight = saved.overlayHeight ?? 110;
      console.log('✅ Positions loaded from disk');

      if (saved.boostEnabled !== undefined) {
        mainWindow?.webContents.on('did-finish-load', () => {
          sendToMain('boost-state', saved.boostEnabled);
        });
        console.log('✅ Boost state loaded:', saved.boostEnabled);
      }
    }
  } catch (e) {
    console.log('⚠️ Could not load positions');
  }
  loadScoreboardKey();
}
// ─── Window: Main ─────────────────────────────────────────────────────────────

/**
 * Creates the primary application window (stats panel and settings).
 * Closing this window quits the entire application.
 */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width     : 480,
    height    : 620,
    resizable : false,
    title     : 'RLVision',
    backgroundColor: '#0f0f1a',
    webPreferences: {
      nodeIntegration  : true,
      contextIsolation : false,
    },
  });

  mainWindow.loadFile('main.html');
  mainWindow.setMenuBarVisibility(false);

  // Push the current state and connection status once the window is ready
  mainWindow.webContents.on('did-finish-load', () => {
    const isConnected = client && !client.destroyed && client.writable;
    sendToMain('rl-connected', isConnected);
    sendToMain('state-update', state);
    if (scoreboardKey) sendToMain('scoreboard-key', scoreboardKey);

    // Restore boost state
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

  // Closing the main window tears down all child windows and the app
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (overlayWindow)       overlayWindow.destroy();
    if (client)              client.destroy();
    if (reconnectInterval)   clearInterval(reconnectInterval);
    if (rlCheckProcess)      rlCheckProcess.kill();
    app.quit();
  });
}

// ─── Window: Gamepad ─────────────────────────────────────────────────────────

/**
 * Creates a hidden background window used to poll gamepad button state
 * via the browser's Gamepad API (not available in the main process).
 */
function createGamepadWindow() {
  gamepadWindow = new BrowserWindow({
    width       : 1,
    height      : 1,
    show        : false,
    skipTaskbar : true,
    webPreferences: {
      nodeIntegration  : true,
      contextIsolation : false,
    },
  });

  gamepadWindow.loadFile('gamepad.html');
  gamepadWindow.on('closed', () => { gamepadWindow = null; });
}

// ─── Window: Overlay ─────────────────────────────────────────────────────────

/**
 * Creates the transparent always-on-top overlay that shows MMR and session stats.
 * Position defaults to the top-right corner if no saved position exists.
 */
function createOverlayWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;

  // Default position: top-right corner with a 20px margin
  if (state.overlayX === null) state.overlayX = width - state.overlayWidth - 20;
  if (state.overlayY === null) state.overlayY = 20;

  overlayWindow = new BrowserWindow({
    width     : state.overlayWidth,
    height    : state.overlayHeight,
    x         : state.overlayX,
    y         : state.overlayY,
    transparent : true,
    frame       : false,
    alwaysOnTop : true,
    skipTaskbar : true,
    resizable   : false,
    webPreferences: {
      nodeIntegration  : true,
      contextIsolation : false,
    },
  });

  overlayWindow.loadFile('overlay.html');
  overlayWindow.setAlwaysOnTop(true, 'pop-up-menu');
  overlayWindow.hide(); // Hidden by default — shown only when RL is in focus

  // Track position changes caused by dragging
  overlayWindow.on('moved', () => {
    const [x, y] = overlayWindow.getPosition();
    state.overlayX = x;
    state.overlayY = y;
  });

  overlayWindow.on('closed', () => { overlayWindow = null; });
}

// ─── Window: Fullscreen Cursor ────────────────────────────────────────────────

/**
 * Creates a transparent fullscreen window that makes the cursor visible
 * while the user is dragging overlays in fullscreen mode.
 * Mouse events are always forwarded through to the underlying windows.
 */
function createFullscreenCursorWindow() {
  const { width, height } = screen.getPrimaryDisplay().bounds;

  fullscreenCursorWindow = new BrowserWindow({
    width, height, x: 0, y: 0,
    transparent : true,
    frame       : false,
    alwaysOnTop : true,
    skipTaskbar : true,
    focusable   : false,
    webPreferences: { nodeIntegration: false },
  });

  fullscreenCursorWindow.loadURL(
    `data:text/html,<html><body style="margin:0;background:transparent;cursor:default;width:100vw;height:100vh;pointer-events:none;"></body></html>`
  );
  fullscreenCursorWindow.setAlwaysOnTop(true, 'normal');
  fullscreenCursorWindow.setIgnoreMouseEvents(true, { forward: true });
  fullscreenCursorWindow.hide();

  fullscreenCursorWindow.on('closed', () => { fullscreenCursorWindow = null; });
}

// ─── Window: Save Confirmation ────────────────────────────────────────────────

/**
 * Creates a small "Save" button overlay that appears at the bottom of the screen
 * while the user is repositioning overlays (Alt held).
 */
function createSaveWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  saveWindow = new BrowserWindow({
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

  saveWindow.loadFile('overlay-save.html');
  saveWindow.setAlwaysOnTop(true, 'pop-up-menu');
  saveWindow.hide();
  saveWindow.on('closed', () => { saveWindow = null; });
}

// ─── Window: Player Overlays ──────────────────────────────────────────────────

/**
 * Creates one overlay window per player slot for the current playlist.
 * Slots are fixed (e.g. blue_1, blue_2, orange_1, orange_2 for 2v2).
 * Saved positions are restored from disk; defaults stack vertically on the left.
 *
 * Players are assigned to slots dynamically at runtime based on live score order.
 */
function createPlayerOverlays() {
  // Destroy any existing player overlay windows before recreating
  playerOverlayWindows.forEach(w => { if (w && !w.isDestroyed()) w.destroy(); });
  playerOverlayWindows = [];
  slotPositions = {};

  // Define slot layout per playlist
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

  const slots = slotMap[currentPlaylist] ?? slotMap['2v2'];

  // Load saved positions for this playlist from disk
  let savedPositions = [];
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      savedPositions = saved[`playerOverlayPositions_${currentPlaylist ?? '2v2'}`] ?? [];
    }
  } catch (e) {}

  slots.forEach((slot, i) => {
    const player = gamePlayers[i] ?? null;

    // Restore saved position or fall back to a stacked default
    const savedPos = savedPositions.find(
      p => p.teamNum === slot.teamNum && p.teamSlot === slot.teamSlot
    ) ?? null;

    const x = savedPos?.overlayX ?? 20;
    const y = savedPos?.overlayY ?? (20 + i * 46);

    // Register the slot position for later drag-save lookups
    const slotKey = `${slot.teamNum === 0 ? 'blue' : 'orange'}_${slot.teamSlot}`;
    slotPositions[slotKey] = { x, y };

    // Attach slot metadata to the player object if one is assigned
    if (player) {
      player.teamNum   = slot.teamNum;
      player.teamSlot  = slot.teamSlot;
      player.overlayX  = x;
      player.overlayY  = y;
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

    // Send initial player data once the window is ready
    win.webContents.on('did-finish-load', () => {
      win.webContents.send('player-data', {
        name     : player?.name     ?? '...',
        mmr      : player?.mmr      ?? null,
        teamNum  : slot.teamNum,
        teamSlot : slot.teamSlot,
      });
    });

    // Track position while dragging (only when Alt is held)
    let dragEndTimer;
    win.on('move', () => {
      if (!isDraggable) return;
      const [px, py] = win.getPosition();
      if (player) { player.overlayX = px; player.overlayY = py; }
      slotPositions[slotKey] = { x: px, y: py };

      // Notify the overlay renderer that a drag is in progress
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

// ─── Key Binding ──────────────────────────────────────────────────────────────

/**
 * Enters binding mode and listens for the next key press (keyboard or gamepad button).
 * The captured binding is saved to disk and broadcast to the main window.
 * Two PowerShell processes run in parallel — one for keyboard, one for XInput gamepad.
 */
function startBindingMode() {
  isBindingMode = true;

  // ── Keyboard listener ──────────────────────────────────────────────────────
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
    }`,
  ]);

  ps.stdout.on('data', (data) => {
    if (!isBindingMode) { ps.kill(); return; }
    const line = data.toString().trim();
    if (line.startsWith('KEY:')) {
      const code  = parseInt(line.replace('KEY:', ''));
      const label = getKeyLabel(code);
      scoreboardKey = { type: 'keyboard', code, label };
      isBindingMode = false;
      ps.kill();
      saveScoreboardKey();
      sendToMain('binding-captured', scoreboardKey);
    }
  });

  ps.stderr.on('data', (d) => console.log('PS bind err:', d.toString()));

  // ── XInput gamepad listener ────────────────────────────────────────────────
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
    }`,
  ]);

  psGamepad.stdout.on('data', (data) => {
    if (!isBindingMode) { psGamepad.kill(); return; }
    const line = data.toString().trim();
    if (line.startsWith('BTN:')) {
      const code  = parseInt(line.replace('BTN:', ''));
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

/**
 * Returns a human-readable label for a Windows virtual key code.
 * Falls back to the character itself for letters and digits.
 *
 * @param {number} code - Windows virtual key code
 * @returns {string}
 */
function getKeyLabel(code) {
  const map = {
    9: 'Tab', 13: 'Enter', 16: 'Shift', 17: 'Ctrl', 18: 'Alt',
    32: 'Space', 37: '←', 38: '↑', 39: '→', 40: '↓',
    112: 'F1', 113: 'F2', 114: 'F3', 115: 'F4',
    116: 'F5', 117: 'F6', 118: 'F7', 119: 'F8',
  };
  if (map[code]) return map[code];
  if (code >= 65 && code <= 90) return String.fromCharCode(code); // A–Z
  if (code >= 48 && code <= 57) return String.fromCharCode(code); // 0–9
  return `Key(${code})`;
}

/**
 * Returns a human-readable label for an XInput gamepad button bitmask.
 *
 * @param {number} button - XInput button bitmask value
 * @returns {string}
 */
function getGamepadButtonLabel(button) {
  const map = {
    0: 'A', 1: 'B', 2: 'X', 3: 'Y',
    4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT',
    8: 'Back', 9: 'Start', 10: 'LS', 11: 'RS',
    12: 'D-pad Up', 13: 'D-pad Down', 14: 'D-pad Left', 15: 'D-pad Right',
  };
  return map[button] ?? `Btn(${button})`;
}

/**
 * Writes the current scoreboard key binding to the state file on disk.
 */
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

/**
 * Reads the scoreboard key binding from disk and restores it into memory.
 */
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

// ─── Alt Key Detection ────────────────────────────────────────────────────────

let altKeyProcess = null; // PowerShell process that polls the Alt key state
let altIsHeld     = false; // True while the Alt key is physically held down

/**
 * Starts a persistent PowerShell process that polls the Alt key every 100ms.
 * Holding Alt makes player overlays draggable and shows the save/cursor windows.
 * Releasing Alt hides those windows and locks overlays back to click-through mode.
 */
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
    }`,
  ]);

  altKeyProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').map(l => l.trim()).filter(Boolean);
    const last  = lines[lines.length - 1];

    if (last === 'ALT_DOWN' && !altIsHeld) {
      // ── Alt pressed: enter drag mode ──────────────────────────────────────
      altIsHeld    = true;
      isDraggable  = true;
      showPlayerOverlays();

      // Show the save button at the bottom of the screen
      if (saveWindow && !saveWindow.isDestroyed()) {
        saveWindow.showInactive();
        saveWindow.setAlwaysOnTop(true, 'pop-up-menu');
      }

      // Show the fullscreen cursor layer so the cursor is visible in RL fullscreen
      if (fullscreenCursorWindow && !fullscreenCursorWindow.isDestroyed()) {
        fullscreenCursorWindow.showInactive();
        fullscreenCursorWindow.setAlwaysOnTop(true, 'normal');
        fullscreenCursorWindow.setIgnoreMouseEvents(true, { forward: true });
      }

      // Enable mouse interaction on all overlay windows
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
      // ── Alt released: exit drag mode ─────────────────────────────────────
      altIsHeld   = false;
      isDraggable = false;
      hidePlayerOverlays();

      if (saveWindow && !saveWindow.isDestroyed()) saveWindow.hide();

      if (fullscreenCursorWindow && !fullscreenCursorWindow.isDestroyed()) {
        fullscreenCursorWindow.setIgnoreMouseEvents(true, { forward: true });
        fullscreenCursorWindow.hide();
      }

      // Return all overlay windows to click-through mode
      if (overlayWindow && !overlayWindow.isDestroyed())
        overlayWindow.setIgnoreMouseEvents(true, { forward: true });
      playerOverlayWindows.forEach(w => {
        if (w && !w.isDestroyed()) w.setIgnoreMouseEvents(true, { forward: true });
      });
    }
  });

  altKeyProcess.stderr.on('data', () => {});
}

// ─── Rocket League Focus Detection ────────────────────────────────────────────

/**
 * Starts a persistent PowerShell process that checks every 500ms whether
 * Rocket League is the foreground window. Shows/hides the MMR overlay accordingly.
 * A 1-second debounce prevents flickering when briefly tabbing out.
 */
function startRLDetection() {
  const ps = spawn('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
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
        try {
          $path = $proc.MainModule.FileName
          if ($path -like '*Steam*') {
            Write-Output "RL_OPEN:STEAM:$path"
          } else {
            Write-Output "RL_OPEN:EPIC:$path"
          }
        } catch {
          Write-Output 'RL_OPEN:UNKNOWN'
        }
      } else {
        Write-Output 'RL_CLOSED'
      }
      Start-Sleep -Milliseconds 500
    }`,
  ]);

  rlCheckProcess = ps;

  ps.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) return;
    const lastLine = lines[lines.length - 1];
    const isRLFocused = lastLine.includes('RL_OPEN');

    if (isRLFocused && !rlWasActive) {
      // Détecter la plateforme et extraire le chemin RL
      const parts = lastLine.split(':');
      const platform = parts[1]; // 'STEAM', 'EPIC', ou 'UNKNOWN'
      const exePath = parts.slice(2).join(':'); // chemin complet

      if (exePath) {
        // Déduire le chemin CookedPCConsole depuis l'exe
        rlInstallPath = exePath
          .replace('Binaries\\Win64\\RocketLeague.exe', 'TAGame\\CookedPCConsole\\')
          .replace('Binaries\\Win32\\RocketLeague.exe', 'TAGame\\CookedPCConsole\\');
      }

      console.log(`🎮 RL detected | Platform: ${platform} | Path: ${rlInstallPath}`);

      if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
      rlWasActive = true;
      showOverlay();
    } else if (!isRLFocused && rlWasActive) {
      if (!hideTimeout) {
        hideTimeout = setTimeout(() => {
          if (altIsHeld) { hideTimeout = null; return; }
          rlWasActive = false;
          hideOverlay();
          hideTimeout = null;
        }, 1000);
      }
    }
  });

  ps.stderr.on('data', () => {});
}

/** Shows the MMR overlay and pushes the latest state to it. */
function showOverlay() {
  if (overlayWindow) {
    overlayWindow.showInactive();
    overlayWindow.setAlwaysOnTop(true, 'pop-up-menu');
    sendToOverlay('state-update', state);
  }
}

/** Hides the MMR overlay. Player overlays are controlled separately by the scoreboard key. */
function hideOverlay() {
  if (overlayWindow) overlayWindow.hide();
}

// ─── RL Stats API Connection ──────────────────────────────────────────────────

/**
 * Opens a TCP connection to the SOS plugin on port 49123.
 * Automatically attempts to reconnect every 5 seconds on failure.
 */
function connectToRL() {
  if (client) { client.destroy(); client = null; }

  client = new net.Socket();

  client.connect(49123, '127.0.0.1', () => {
    console.log('✅ Connected to RL Stats API');
    sendToMain('rl-connected', true);
    sendToOverlay('rl-connected', true);
    if (reconnectInterval) { clearInterval(reconnectInterval); reconnectInterval = null; }
  });

  client.on('data', (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.Data && typeof message.Data === 'string') {
        message.Data = JSON.parse(message.Data);
      }
      handleRLEvent(message);
    } catch (e) {
      // Silently ignore malformed messages
    }
  });

  client.on('error', () => { sendToMain('rl-connected', false); startReconnect(); });
  client.on('close',  () => { sendToMain('rl-connected', false); startReconnect(); });
}

/** Starts the reconnection interval if it isn't already running. */
function startReconnect() {
  if (reconnectInterval) return;
  reconnectInterval = setInterval(connectToRL, 5000);
}

// ─── RL Event Handler ─────────────────────────────────────────────────────────

/**
 * Central dispatcher for all events received from the SOS plugin.
 * Handles match lifecycle, player identification, playlist detection,
 * live score tracking, and match outcome detection.
 *
 * @param {object} message - Parsed event with { Event, Data }
 */
function handleRLEvent(message) {
  const { Event, Data } = message;

  // ── Match Start ─────────────────────────────────────────────────────────────
  if (Event === 'MatchCreated' || Event === 'MatchInitialized') {
    matchEnded        = false;
    myTeamNum         = null;
    currentPlaylist   = null;
    initialMMRFetched = false;
    roundStarted      = false;
    playerID          = null;
    gamePlayers       = [];
    playersLogged     = false;
    playerOverlayWindows.forEach(w => { if (w && !w.isDestroyed()) w.destroy(); });
    playerOverlayWindows = [];
    previousOrder     = {};
  }

  // ── Round Started ───────────────────────────────────────────────────────────
  // All players are guaranteed to be present in UpdateState after this fires
  if (Event === 'RoundStarted') {
    roundStarted = true;
    console.log('🚀 Round started — all players loaded');
  }

  // ── State Updates ───────────────────────────────────────────────────────────
  if (Event === 'UpdateState' && Data && Data.Players) {
    if (Data.Game) lastTimeSeconds = Data.Game.TimeSeconds ?? null;

    // Step 1: Log all players once after the first round starts
    if (roundStarted && !playersLogged && Data.Players.length > 0) {
      playersLogged = true;

      // Build the player list, sorted by team (Blue first)
      gamePlayers = Data.Players.map(p => ({
        name      : p.Name,
        primaryId : p.PrimaryId && !p.PrimaryId.startsWith('Unknown') ? p.PrimaryId : null,
        teamNum   : p.TeamNum,
      }));
      gamePlayers.sort((a, b) => a.teamNum - b.teamNum);

      console.log('─────────────────────────────');
      console.log('👥 Players found:', gamePlayers.length);
      gamePlayers.forEach(p =>
        console.log(`   • [${p.teamNum === 0 ? 'Blue' : 'Orange'}] ${p.name} — ${p.primaryId}`)
      );
      console.log('─────────────────────────────');

      // Fetch MMR for all players except the local player (fetched separately in Step 3)
      for (const player of gamePlayers) {
        if (player.primaryId === playerID || !player.primaryId) continue;
        fetchRealMMR(false, player.primaryId).then(mmr => {
          player.mmr = mmr;
          const idx = gamePlayers.indexOf(player);
          const win = playerOverlayWindows[idx];
          if (win && !win.isDestroyed()) {
            win.webContents.send('player-data', {
              name     : player.name,
              mmr,
              teamNum  : player.teamNum,
              teamSlot : player.teamSlot,
            });
          }
        });
      }
    }

    // Step 2: Identify the local player via the camera target
    if (!playerID && roundStarted && Data.Game?.bHasTarget && Data.Game?.Target) {
      const targetName = Data.Game.Target.Name;
      const me = Data.Players.find(p => p.Name === targetName);
      if (me && me.PrimaryId) {
        playerID  = me.PrimaryId;
        myTeamNum = me.TeamNum;
        console.log('👤 Player identified:', me.Name);
        console.log('👤 Team:', myTeamNum === 0 ? 'Blue' : 'Orange');
      }
    }

    // Step 3: Detect the playlist from the total number of players in the match
    if (playerID && currentPlaylist === null && !matchEnded && roundStarted) {
      const total = Data.Players.length;
      if      (total === 2) currentPlaylist = '1v1';
      else if (total === 4) currentPlaylist = '2v2';
      else if (total === 6) currentPlaylist = '3v3';
      else return; // Free play or unsupported mode — skip

      console.log('🎮 Playlist detected:', currentPlaylist, '| Total players:', total);
      if (playerOverlaysEnabled) createPlayerOverlays();
    }

    // Step 4: Fetch the local player's MMR once both playerID and playlist are known
    if (playerID && currentPlaylist !== null && !initialMMRFetched) {
      initialMMRFetched = true;
      console.log('🎮 Fetching initial MMR...');
      sendToMain('mmr-source', 'fetching');
      fetchRealMMR();
    }

    // Step 5: Re-sort player overlays in real time based on live score changes
    if (roundStarted && gamePlayers.length > 0 && playerOverlayWindows.length > 0) {
      const blueTeam   = gamePlayers.filter(p => p.teamNum === 0);
      const orangeTeam = gamePlayers.filter(p => p.teamNum === 1);

      for (const team of [blueTeam, orangeTeam]) {
        const teamKey = team[0].teamNum === 0 ? 'blue' : 'orange';

        // Update each player's cached live score
        team.forEach(p => {
          const live = Data.Players.find(lp => lp.Name === p.name);
          if (live) p.liveScore = live.Score ?? 0;
        });

        // Sort descending by score
        const sorted   = [...team].sort((a, b) => b.liveScore - a.liveScore);
        const newOrder = sorted.map(p => p.name);
        const prevOrder = previousOrder[teamKey] ?? [];

        // Only update overlays if the ranking order actually changed
        if (newOrder.every((name, i) => name === prevOrder[i])) continue;
        previousOrder[teamKey] = newOrder;

        sorted.forEach((player, i) => {
          const targetSlot = i + 1;
          const slotIndex  = gamePlayers.findIndex(
            p => p.teamNum === team[0].teamNum && p.teamSlot === targetSlot
          );
          const win = playerOverlayWindows[slotIndex];
          if (win && !win.isDestroyed()) {
            win.webContents.send('player-data', {
              name     : player.name,
              mmr      : player.mmr ?? null,
              teamNum  : team[0].teamNum,
              teamSlot : targetSlot,
            });
          }
        });
      }
    }

    // Track overtime flag — used to determine match outcome on MatchDestroyed
    if (Data.Game?.bOvertime) lastBOvertime = true;

    // Detect match end early from the game clock hitting 0 (or overtime active)
    if (Data.Game && !matchEnded) {
      if (Data.Game.TimeSeconds === 0 || lastBOvertime) {
        const teams = Data.Game.Teams;
        if (teams && teams.length >= 2) {
          const blueScore   = teams.find(t => t.TeamNum === 0)?.Score ?? 0;
          const orangeScore = teams.find(t => t.TeamNum === 1)?.Score ?? 0;
          const winnerTeam  = blueScore > orangeScore ? 0 : 1;
          playerWon = winnerTeam === myTeamNum;
        }
      }
    }
  }

  // ── Match Ended ─────────────────────────────────────────────────────────────
  // Fired by the SOS plugin when the game officially ends
  if (Event === 'MatchEnded' && !matchEnded) {
    matchEnded = true;
    const won  = Data.WinnerTeamNum === (myTeamNum ?? 0);
    console.log(`🏁 Match ended | ${won ? 'WIN' : 'LOSS'}`);

    if (won) { state.wins++;   state.streak = state.streak > 0 ? state.streak + 1 : 1;  }
    else      { state.losses++; state.streak = state.streak < 0 ? state.streak - 1 : -1; }

    broadcastState();

    // Clean up player overlays and begin fetching updated MMR
    playerOverlayWindows.forEach(w => { if (w && !w.isDestroyed()) w.destroy(); });
    playerOverlayWindows = [];
    currentPlaylist = null;
    console.log('⏳ Waiting for rlstats.net to update...');
    sendToMain('mmr-source', 'fetching');
    fetchRealMMRWithRetry();
  }

  // ── Match Destroyed ─────────────────────────────────────────────────────────
  // Fired when the match session is torn down (after replays, or on disconnect)
  if (Event === 'MatchDestroyed') {
    const savedPlaylist = currentPlaylist;

    if (currentPlaylist !== null) {
      // If time wasn't at 0 and no overtime occurred, treat as a non-match (free play, etc.)
      if (lastTimeSeconds !== 0 && !lastBOvertime) playerWon = false;
      if (playerWon === null) playerWon = false;

      if (playerWon) { state.wins++;   state.streak = state.streak > 0 ? state.streak + 1 : 1;  }
      else            { state.losses++; state.streak = state.streak < 0 ? state.streak - 1 : -1; }

      broadcastState();
      sendToMain('mmr-source', 'fetching');
      fetchRealMMRWithRetry(savedPlaylist);
    }

    // Full reset for the next match
    playerOverlayWindows.forEach(w => { if (w && !w.isDestroyed()) w.destroy(); });
    playerOverlayWindows = [];
    gamePlayers      = [];
    currentPlaylist  = null;
    roundStarted     = false;
    playersLogged    = false;
    previousOrder    = {};
    playerWon        = null;
    lastTimeSeconds  = null;
    lastBOvertime    = null;
    console.log('🚪 Match destroyed — state reset');
  }
}

// ─── MMR Fetch ────────────────────────────────────────────────────────────────

/**
 * Scrapes the player's MMR from their rlstats.net profile page.
 * Supports Epic, Steam, Xbox (xboxone), and PS4 platforms.
 * Updates the global state and broadcasts it when fetching for the local player.
 *
 * @param {boolean} [fromMatch=false]       - If true, computes the MMR delta vs the stored value
 * @param {string}  [primaryId=playerID]    - Target player's primary ID (platform|id)
 * @param {string}  [playlist=currentPlaylist] - Playlist to look up ('1v1', '2v2', '3v3')
 * @returns {Promise<number|null>}
 */
async function fetchRealMMR(fromMatch = false, primaryId = playerID, playlist = currentPlaylist) {
  const isMe = primaryId === playerID;
  if (!primaryId) return null;

  try {
    const [platform, id] = primaryId.split('|');
    console.log('🔍 Platform:', platform, '| ID:', id);

    // Build the rlstats.net profile URL based on the player's platform
    let url;
    switch (platform.toLowerCase()) {
      case 'epic':    url = `https://rlstats.net/profile/Epic/${id}`;  break;
      case 'steam':   url = `https://rlstats.net/profile/Steam/${id}`; break;
      case 'xboxone': url = `https://rlstats.net/profile/Xbox/${id}`;  break;
      case 'ps4':     url = `https://rlstats.net/profile/PS4/${id}`;   break;
      case 'switch':
        console.log('⚠️ Switch is not supported by rlstats.net, skipping:', id);
        return null;
      default:
        console.log('⚠️ Unknown platform:', platform);
        return null;
    }

    console.log('🌐 Fetching URL:', url);
    const response = await fetch(url);
    const html     = await response.text();

    // Extract the embedded MMR array from the page's chart initialization code
    const dataMatch = html.match(/new Date\(\d+\*1000\),\s*([\d,\s]+)/);

    if (dataMatch) {
      const values = dataMatch[1]
        .split(',')
        .map(v => parseInt(v.trim()))
        .filter(v => !isNaN(v));

      console.log('📊 MMR values (1v1, 2v2, 3v3):', values);

      // Select the MMR for the correct playlist index
      let realMMR = null;
      if      (playlist === '1v1') realMMR = values[0];
      else if (playlist === '2v2') realMMR = values[1];
      else if (playlist === '3v3') realMMR = values[2];
      else                          realMMR = values[1]; // Default to 2v2

      if (realMMR) {
        console.log('✅ Real MMR found:', realMMR, `(${playlist ?? '2v2'})`);

        if (isMe) {
          // Accumulate the MMR delta for the session display
          if (fromMatch && state.mmr !== 0) {
            state.mmrGained += realMMR - state.mmr;
          }
          state.mmr = realMMR;
          broadcastState();
          sendToMain('mmr-source', 'real');

          // Also update the local player's entry in the player overlays
          const meIdx = gamePlayers.findIndex(p => p.primaryId === playerID);
          if (meIdx !== -1) {
            gamePlayers[meIdx].mmr = realMMR;
            const win = playerOverlayWindows[meIdx];
            if (win && !win.isDestroyed()) {
              win.webContents.send('player-data', {
                name     : gamePlayers[meIdx].name,
                mmr      : realMMR,
                teamNum  : gamePlayers[meIdx].teamNum,
                teamSlot : gamePlayers[meIdx].teamSlot,
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

// ─── Scoreboard Key Detection ─────────────────────────────────────────────────

/**
 * Starts a PowerShell process that polls for the configured scoreboard key.
 * Shows player overlays on key-down and hides them on key-up.
 * Only runs for keyboard bindings — gamepad events are handled via IPC from gamepad.html.
 *
 * @returns {ChildProcess|undefined}
 */
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
    }`,
  ]);

  ps.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').map(l => l.trim()).filter(Boolean);
    const last  = lines[lines.length - 1];
    if (last === 'SCOREBOARD_DOWN') showPlayerOverlays();
    else if (last === 'SCOREBOARD_UP') hidePlayerOverlays();
  });

  ps.stderr.on('data', () => {});
  return ps;
}

// ─── MMR Retry Logic ──────────────────────────────────────────────────────────

/**
 * Retries the MMR fetch up to `retries` times with a `delay` between each attempt.
 * Stops early once the MMR value changes, indicating rlstats.net has been updated.
 * The session MMR delta is calculated once here, not inside fetchRealMMR, to avoid drift.
 *
 * @param {string} [playlist]      - Playlist to look up
 * @param {number} [retries=5]     - Maximum number of retry attempts
 * @param {number} [delay=15000]   - Delay between retries in milliseconds
 */
async function fetchRealMMRWithRetry(playlist, retries = 5, delay = 15000) {
  const mmrBeforeMatch = state.mmr; // Snapshot before any retry modifies the value

  for (let i = 0; i < retries; i++) {
    // First attempt waits 10s; subsequent attempts wait the full delay
    await new Promise(res => setTimeout(res, i === 0 ? 10000 : delay));

    await fetchRealMMR(false, playerID, playlist);

    if (state.mmr !== mmrBeforeMatch) {
      // MMR changed — compute the delta and update the session total
      const diff = state.mmr - mmrBeforeMatch;
      state.mmrGained += diff;
      console.log('📈 MMR delta:', diff > 0 ? `+${diff}` : diff);
      broadcastState();
      console.log(`✅ MMR updated after ${i + 1} attempt(s)`);
      return;
    }

    console.log(`⏳ MMR unchanged, retrying... (${i + 1}/${retries})`);
  }

  console.log('⚠️ MMR did not update after all retries');
}

// ─── IPC Helpers ─────────────────────────────────────────────────────────────

/** Sends a message to the main settings window. */
function sendToMain(channel, data) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send(channel, data);
  }
}

/** Sends a message to the MMR overlay window. */
function sendToOverlay(channel, data) {
  if (overlayWindow && overlayWindow.webContents) {
    overlayWindow.webContents.send(channel, data);
  }
}

/** Broadcasts the current state to both the main window and the overlay. */
function broadcastState() {
  sendToMain('state-update', state);
  sendToOverlay('state-update', state);
}

// ─── Player Overlay Visibility ────────────────────────────────────────────────

/** Shows all player overlay windows (called on scoreboard key down or Alt hold). */
function showPlayerOverlays() {
  playerOverlayWindows.forEach(w => {
    if (w && !w.isDestroyed()) w.showInactive();
  });
}

/** Hides all player overlay windows (called on scoreboard key up or Alt release). */
function hidePlayerOverlays() {
  playerOverlayWindows.forEach(w => {
    if (w && !w.isDestroyed()) w.hide();
  });
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.on('get-state', (event) => { event.reply('state-update', state); });

ipcMain.on('toggle-boost', (event, enabled) => {
  try {
    const appDir = app.getAppPath();
    console.log('🚀 Toggle boost:', enabled ? 'ENABLE' : 'DISABLE');
    console.log('📁 App dir:', appDir);

    const src = path.join(
      appDir,
      enabled ? 'Boost-Alpha\\Enable\\SFX_Boost_Standard.bnk'
              : 'Boost-Alpha\\Disable\\SFX_Boost_Standard.bnk'
    );
    console.log('📂 Source file:', src);
    console.log('📂 Source exists:', fs.existsSync(src));

    // Utilise le chemin détecté automatiquement, sinon fallback sur les chemins connus
    let dest = null;
    if (rlInstallPath) {
      dest = path.join(rlInstallPath, 'SFX_Boost_Standard.bnk');
      console.log('📂 Using auto-detected path:', dest);
    } else {
      const possiblePaths = [
        'C:\\Program Files\\Epic Games\\rocketleague\\TAGame\\CookedPCConsole\\SFX_Boost_Standard.bnk',
        'C:\\Program Files (x86)\\Steam\\steamapps\\common\\rocketleague\\TAGame\\CookedPCConsole\\SFX_Boost_Standard.bnk',
        'D:\\Program Files\\Epic Games\\rocketleague\\TAGame\\CookedPCConsole\\SFX_Boost_Standard.bnk',
        'D:\\Program Files (x86)\\Steam\\steamapps\\common\\rocketleague\\TAGame\\CookedPCConsole\\SFX_Boost_Standard.bnk',
        'D:\\Steam\\steamapps\\common\\rocketleague\\TAGame\\CookedPCConsole\\SFX_Boost_Standard.bnk',
        'C:\\Steam\\steamapps\\common\\rocketleague\\TAGame\\CookedPCConsole\\SFX_Boost_Standard.bnk',
      ];
      dest = possiblePaths.find(p => fs.existsSync(p));
      console.log('📂 Using fallback path:', dest);
    }

    if (!dest) {
      console.error('❌ Rocket League not found');
      event.reply('boost-result', { success: false, error: 'Rocket League not found. Launch RL first or check your install path.' });
      return;
    }

    fs.copyFileSync(src, dest);
    console.log('✅ File copied successfully');

    let existing = {};
    if (fs.existsSync(STATE_FILE)) existing = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    existing.boostEnabled = enabled;
    fs.writeFileSync(STATE_FILE, JSON.stringify(existing), 'utf8');
    console.log('💾 Boost state saved:', enabled);

    event.reply('boost-result', { success: true, enabled });
  } catch (err) {
    console.error('❌ Error:', err.message);
    event.reply('boost-result', { success: false, error: err.message });
  }
});

// Reset all session stats
ipcMain.on('reset-stats', () => {
  state.wins = 0; state.losses = 0; state.streak = 0; state.mmrGained = 0;
  broadcastState();
});

// Manually trigger an MMR refresh from rlstats.net
ipcMain.on('refresh-mmr', () => {
  console.log('🔄 Manual MMR refresh');
  fetchRealMMR();
});

// Toggle the player overlay windows on/off
ipcMain.on('toggle-player-overlays', (_, enabled) => {
  playerOverlaysEnabled = enabled;

  // Sauvegarde l'état
  try {
    let existing = {};
    if (fs.existsSync(STATE_FILE)) existing = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    existing.playerOverlaysEnabled = enabled;
    fs.writeFileSync(STATE_FILE, JSON.stringify(existing), 'utf8');
    console.log('💾 Player overlays state saved:', enabled);
  } catch (e) {}

  if (enabled) {
    if (gamePlayers.length > 0) createPlayerOverlays();
  } else {
    playerOverlayWindows.forEach(w => { if (w && !w.isDestroyed()) w.destroy(); });
    playerOverlayWindows = [];
  }
});

// Key binding lifecycle
ipcMain.on('start-binding', () => startBindingMode());
ipcMain.on('stop-binding',  () => { isBindingMode = false; });
ipcMain.on('clear-binding', () => { scoreboardKey = null; saveScoreboardKey(); });

// Gamepad events forwarded from the hidden gamepad.html window
ipcMain.on('gamepad-connected',    (_, data) => {});
ipcMain.on('gamepad-disconnected', (_, data) => {});

ipcMain.on('gamepad-button-down', (_, data) => {
  // Capture button during binding mode
  if (isBindingMode) {
    const label = getGamepadButtonLabel(data.button);
    scoreboardKey = { type: 'gamepad', button: data.button, label };
    isBindingMode = false;
    saveScoreboardKey();
    sendToMain('binding-captured', scoreboardKey);
    return;
  }
  // Show player overlays when the scoreboard button is held
  if (scoreboardKey?.type === 'gamepad' && data.button === scoreboardKey.button) {
    showPlayerOverlays();
  }
});

ipcMain.on('gamepad-button-up', (_, data) => {
  if (scoreboardKey?.type === 'gamepad' && data.button === scoreboardKey.button) {
    hidePlayerOverlays();
  }
});


// Save overlay positions when the user clicks the save button (shown while Alt is held)
ipcMain.on('save-overlay-positions', () => {
  // Snapshot the main overlay position
  if (overlayWindow) {
    const [x, y] = overlayWindow.getPosition();
    state.overlayX = x;
    state.overlayY = y;
  }
  // Snapshot each player overlay position
  playerOverlayWindows.forEach((w, i) => {
    if (w && !w.isDestroyed() && gamePlayers[i]) {
      const [x, y] = w.getPosition();
      gamePlayers[i].overlayX = x;
      gamePlayers[i].overlayY = y;
    }
  });

  console.log('💾 Positions saved!');
  savePositionsToDisk();

  // Exit drag mode and hide all drag-related UI
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

// Resize the main MMR overlay window
ipcMain.on('set-overlay-size', (event, { width, height }) => {
  state.overlayWidth  = width;
  state.overlayHeight = height;
  if (overlayWindow) {
    overlayWindow.setSize(width, height);
    overlayWindow.webContents.executeJavaScript(`
      document.body.style.width  = '${width}px';
      document.body.style.height = '${height}px';
    `);
    sendToOverlay('state-update', state);
  }
  savePositionsToDisk();
});

// Focus or reopen the main window from a tray or overlay button
ipcMain.on('open-main', () => {
  if (mainWindow) mainWindow.focus();
  else createMainWindow();
});

// ─── App Init ─────────────────────────────────────────────────────────────────

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

  // Global shortcut to manually toggle the MMR overlay visibility
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    if (!overlayWindow) return;
    if (overlayWindow.isVisible()) overlayWindow.hide();
    else overlayWindow.showInactive();
  });
});

app.on('window-all-closed', () => app.quit());

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (client)                client.destroy();
  if (rlCheckProcess)        rlCheckProcess.kill();
  if (altKeyProcess)         altKeyProcess.kill();
  if (fullscreenCursorWindow) fullscreenCursorWindow.destroy();
});
