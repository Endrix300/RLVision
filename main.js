const { app, BrowserWindow, screen, globalShortcut, ipcMain } = require('electron');
const net = require('net');
const { exec, spawn } = require('child_process');

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

// ─────────────────────────────────────────────────────────────────────────────
// ROCKET LEAGUE DETECTION
// ─────────────────────────────────────────────────────────────────────────────
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
    const lastLine = lines[lines.length - 1];
    const isRLFocused = lastLine.includes('RL_OPEN');

    // Skip if the overlay window itself is in the foreground to avoid flicker
    if (overlayWindow && overlayWindow.isFocused()) return;

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
          // Re-check that the overlay itself is not focused before hiding
          if (overlayWindow && overlayWindow.isFocused()) return;
          rlWasActive = false;
          hideOverlay();
          hideTimeout = null;
        }, 200);
      }
    }
  });

  ps.stderr.on('data', () => {
    // Silently ignore PowerShell errors
  });
}

function showOverlay() {
  if (overlayWindow) {
    overlayWindow.showInactive();
    overlayWindow.setAlwaysOnTop(true, 'pop-up-menu');
    sendToOverlay('state-update', state);
  }
}

function hideOverlay() {
  if (overlayWindow) {
    overlayWindow.hide();
  }
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
      // The Data field is sometimes double-encoded as a JSON string
      if (message.Data && typeof message.Data === 'string') {
        message.Data = JSON.parse(message.Data);
      }
      handleRLEvent(message);
    } catch (e) {}
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

  // Reset match state on new game
  if (Event === 'MatchCreated' || Event === 'MatchInitialized') {
    matchEnded = false;
    myTeamNum = null;
    currentPlaylist = null;
  }

  if (Event === 'UpdateState' && Data && Data.Players) {
    // Detect playlist first based on player count, before fetching MMR
    if (currentPlaylist === null) {
      if (Data.Game && Data.Game.Playlist) {
        const p = Data.Game.Playlist;
        // SOS playlist IDs: 10 = Duel, 11 = Doubles, 13 = Standard
        if (p === 10) currentPlaylist = '1v1';
        else if (p === 11) currentPlaylist = '2v2';
        else if (p === 13) currentPlaylist = '3v3';
        console.log('🎮 Playlist detected via ID:', currentPlaylist, '| Raw:', p);
      }

      // Fallback: count players on one team only (not total)
      if (currentPlaylist === null) {
        const teamPlayers = Data.Players.filter(p => p.TeamNum === 0);
        const count = teamPlayers.length;
        if (count === 1) currentPlaylist = '1v1';
        else if (count === 2) currentPlaylist = '2v2';
        else if (count >= 3) currentPlaylist = '3v3';
        console.log('🎮 Playlist detected via team count:', currentPlaylist);
      }
    }

    // Find the local player by their ID, fallback to first player if ID not yet known
    let player = playerID
      ? Data.Players.find(p => p.PrimaryId === playerID)
      : Data.Players[0];

    if (!player) return;

    // Assign team number using the correct player reference
    if (myTeamNum === null) {
      myTeamNum = player.TeamNum;
      console.log('👤 Team detected:', myTeamNum === 0 ? 'Blue' : 'Orange');
    }

    // Detect player ID and assign team at the same time to avoid mismatch
    if (!playerID && player.PrimaryId) {
      playerID = player.PrimaryId;
      myTeamNum = player.TeamNum; // Ensure team is set from the correct player
      console.log('👤 Player ID detected:', playerID);
      sendToMain('mmr-source', 'fetching');
      fetchRealMMR(); // Playlist is already detected at this point
    }
  }

  if (Event === 'MatchEnded' && !matchEnded) {
    matchEnded = true;
    const playerTeam = myTeamNum !== null ? myTeamNum : 0;
    // Compare winner team number against the player's team to determine outcome
    const won = Data.WinnerTeamNum === playerTeam;

    console.log(`🏁 Match ended | ${won ? 'WIN' : 'LOSS'}`);

    if (won) {
      state.wins++;
      // Continue win streak or reset to 1 if coming from a loss streak
      state.streak = state.streak > 0 ? state.streak + 1 : 1;
    } else {
      state.losses++;
      // Continue loss streak or reset to -1 if coming from a win streak
      state.streak = state.streak < 0 ? state.streak - 1 : -1;
    }

    broadcastState();

    // Wait 45s for rlstats.net to update before fetching new MMR
    console.log('⏳ Waiting 45s before fetching real MMR...');
    sendToMain('mmr-source', 'fetching');
    setTimeout(() => fetchRealMMR(true), 50000); // fromMatch = true
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REAL MMR FETCH VIA RLSTATS.NET
// ─────────────────────────────────────────────────────────────────────────────
async function fetchRealMMR(fromMatch = false) {
  if (!playerID) return;

  try {
    const parts = playerID.split('|');
    const platform = parts[0];
    const id = parts[1];

    console.log('🔍 Platform:', platform, '| ID:', id);

    let url;
    if (platform.toLowerCase() === 'epic') {
      url = `https://rlstats.net/profile/Epic/${id}`;
    } else if (platform.toLowerCase() === 'steam') {
      url = `https://rlstats.net/profile/Steam/${id}`;
    } else {
      console.log('⚠️ Unknown platform:', platform);
      sendToMain('mmr-source', 'estimated');
      return;
    }

    console.log('🌐 Fetching URL:', url);

    const response = await fetch(url);
    const html = await response.text();
    // Extract the MMR array embedded in the rlstats.net chart data script
    const dataMatch = html.match(/new Date\(\d+\*1000\),\s*([\d,\s]+)/);

    if (dataMatch) {
      const values = dataMatch[1].split(',').map(v => parseInt(v.trim())).filter(v => !isNaN(v));
      console.log('📊 MMR values:', values);
      // Index: 0 = Duel (1v1), 1 = Doubles (2v2), 2 = Standard (3v3)

      let realMMR = null;
      if (currentPlaylist === '1v1') realMMR = values[0];
      else if (currentPlaylist === '2v2') realMMR = values[1];
      else if (currentPlaylist === '3v3') realMMR = values[2];
      else realMMR = values[1]; // Default to Doubles if playlist unknown

      if (realMMR) {
        console.log('✅ Real MMR found:', realMMR, '(' + (currentPlaylist || '2v2') + ')');

        // Only compute the MMR diff when called after a match, not on initial fetch
        if (fromMatch && state.mmr !== 0) {
          const diff = realMMR - state.mmr;
          state.mmrGained += diff;
          console.log('📈 MMR diff:', diff > 0 ? `+${diff}` : diff);
        }

        state.mmr = realMMR;
        broadcastState();
        sendToMain('mmr-source', 'real');
      } else {
        console.log('⚠️ MMR not found in parsed values');
        sendToMain('mmr-source', 'estimated');
      }
    } else {
      console.log('⚠️ MMR pattern not found in HTML');
      sendToMain('mmr-source', 'estimated');
    }
  } catch (err) {
    console.error('❌ MMR fetch error:', err.message);
    sendToMain('mmr-source', 'estimated');
  }
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

ipcMain.on('get-state', (event) => { event.reply('state-update', state); });
ipcMain.on('set-mmr', (event, value) => { state.mmr = parseInt(value) || 0; broadcastState(); });
ipcMain.on('reset-stats', () => { state.wins = 0; state.losses = 0; state.streak = 0; state.mmrGained = 0; broadcastState(); });
ipcMain.on('refresh-mmr', () => {
  console.log('🔄 Manual MMR refresh');
  fetchRealMMR();
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
});

ipcMain.on('open-main', () => {
  if (mainWindow) { mainWindow.focus(); } else { createMainWindow(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// APP INIT
// ─────────────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createMainWindow();
  createOverlayWindow();
  connectToRL();
  startRLDetection();

  // Global shortcut to toggle overlay visibility
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
});