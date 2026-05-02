const { ipcRenderer } = require('electron');


// Request the current state from the main process on startup
ipcRenderer.send('get-state');

// Refresh the UI whenever the main process pushes a state update
ipcRenderer.on('state-update', (event, state) => {
  updateUI(state);
});

// Update the connection status dot and label in the header
ipcRenderer.on('rl-connected', (event, connected) => {
  const dot = document.getElementById('rlDot');
  const status = document.getElementById('rlStatus');
  if (connected) {
    dot.classList.add('on');
    status.textContent = 'Connected';
  } else {
    dot.classList.remove('on');
    status.textContent = 'Offline';
  }
});

// Detected player name received from the main process
ipcRenderer.on('player-name', (event, name) => {
  const el = document.getElementById('playerName');
  if (el) el.textContent = '👤 ' + name;
});

// MMR source label: 'real' (fetched from rlstats.net), 'fetching', or 'estimated'
ipcRenderer.on('mmr-source', (event, source) => {
  const el = document.getElementById('mmrSource');
  if (!el) return;

  if (source === 'real') {
    el.textContent = '✅ Real MMR';
    el.className = 'mmr-source real';
  } else if (source === 'fetching') {
    el.textContent = '🔄 Fetching real MMR...';
    el.className = 'mmr-source fetching';
  } else {
    el.textContent = '⚠️ Estimated MMR';
    el.className = 'mmr-source estimated';
  }
});

// Refresh all UI elements with the latest state values
function updateUI(state) {
  document.getElementById('mmrBig').textContent = state.mmr;
  document.getElementById('winsVal').textContent = state.wins;
  document.getElementById('lossesVal').textContent = state.losses;

  // Calculate win ratio as a percentage, show dash if no games played
  const total = state.wins + state.losses;
  const ratio = total > 0 ? Math.round((state.wins / total) * 100) + '%' : '—';
  document.getElementById('ratioVal').textContent = ratio;

  // Update streak pill appearance based on current streak direction
  const streakEl = document.getElementById('streakPill');
  if (state.streak > 0) {
    streakEl.className = 'streak-pill win-streak';
    streakEl.textContent = `🔥 ${state.streak} win streak`;
  } else if (state.streak < 0) {
    streakEl.className = 'streak-pill loss-streak';
    streakEl.textContent = `❄️ ${Math.abs(state.streak)} loss streak`;
  } else {
    streakEl.className = 'streak-pill neutral';
    streakEl.textContent = 'No streak';
  }


  const gained = state.mmrGained || 0;
  const gainedEl = document.getElementById('mmrGainedEl');
  if (gainedEl) {
    if (gained > 0) {
      gainedEl.style.color = '#10b981';
      gainedEl.textContent = `📈 +${gained} this session`;
    } else if (gained < 0) {
      gainedEl.style.color = '#ef4444';
      gainedEl.textContent = `📉 ${gained} this session`;
    } else {
      gainedEl.style.color = '#666';
      gainedEl.textContent = `Δ 0 this session`;
    }
  }

  // Keep overlay size inputs in sync with the stored state
  document.getElementById('widthInput').value = state.overlayWidth;
  document.getElementById('heightInput').value = state.overlayHeight;
}

ipcRenderer.on('player-overlays-state', (_, enabled) => {
  playerOverlaysEnabled = enabled;
  const btn = document.getElementById('togglePlayerOverlaysBtn');
  const status = document.getElementById('playerOverlaysStatus');
  btn.textContent = enabled ? 'Disable' : 'Enable';
  btn.className = enabled ? 'btn btn-danger' : 'btn btn-ghost';
  status.textContent = enabled ? 'Enabled' : 'Disabled';
  status.style.color = enabled ? '#10b981' : '#666';
  ipcRenderer.send('toggle-player-overlays', enabled);
});


ipcRenderer.on('boost-state', (_, enabled) => {
  boostEnabled = enabled;
  const btn = document.getElementById('toggleBoostBtn');
  const status = document.getElementById('boostStatus');
  btn.textContent = enabled ? 'Disable' : 'Enable';
  btn.className = enabled ? 'btn btn-danger' : 'btn btn-ghost';
  status.textContent = enabled ? 'Enabled' : 'Disabled';
  status.style.color = enabled ? '#10b981' : '#666';
});

let boostEnabled = false;

function toggleBoost() {
  boostEnabled = !boostEnabled;
  const btn = document.getElementById('toggleBoostBtn');
  const status = document.getElementById('boostStatus');
  const msg = document.getElementById('boostStatusMsg');

  btn.textContent = boostEnabled ? 'Disable' : 'Enable';
  btn.className = boostEnabled ? 'btn btn-danger' : 'btn btn-ghost';
  status.textContent = boostEnabled ? 'Enabled' : 'Disabled';
  status.style.color = boostEnabled ? '#10b981' : '#666';
  msg.textContent = '⏳ Applying...';

  ipcRenderer.send('toggle-boost', boostEnabled);

  // Show restart warning
  document.getElementById('restartWarning').style.display = 'block';
}

ipcRenderer.on('boost-result', (_, result) => {
  const msg = document.getElementById('boostStatusMsg');
  msg.textContent = result.success ? (result.enabled ? '✅ Alpha Boost enabled' : '✅ Original boost restored') : '❌ Error: ' + result.error;
});

// Trigger a fresh MMR fetch from rlstats.net
function refreshMMR() {
  ipcRenderer.send('refresh-mmr');
}

// Send updated overlay dimensions to the main process
function applySize() {
  const width = parseInt(document.getElementById('widthInput').value) || 220;
  const height = parseInt(document.getElementById('heightInput').value) || 160;
  ipcRenderer.send('set-overlay-size', { width, height });
}


let isBinding = false;

function startBinding() {
  isBinding = true;
  document.getElementById('bindStatus').textContent = '⏳ Appuie sur une touche clavier ou bouton manette...';
  document.getElementById('bindBtn').textContent = 'Annuler';
  document.getElementById('bindBtn').onclick = cancelBinding;
  ipcRenderer.send('start-binding');
}

function cancelBinding() {
  isBinding = false;
  document.getElementById('bindStatus').textContent = '';
  document.getElementById('bindBtn').textContent = 'Bind';
  document.getElementById('bindBtn').onclick = startBinding;
  ipcRenderer.send('stop-binding');
}

function clearBinding() {
  ipcRenderer.send('clear-binding');
  document.getElementById('scoreboardKeyDisplay').textContent = 'Non configuré';
}

ipcRenderer.on('binding-captured', (_, key) => {
  isBinding = false;
  document.getElementById('scoreboardKeyDisplay').textContent = key.label;
  document.getElementById('bindStatus').textContent = '✅ Touche enregistrée';
  document.getElementById('bindBtn').textContent = 'Bind';
  document.getElementById('bindBtn').onclick = startBinding;
});

ipcRenderer.on('scoreboard-key', (_, key) => {
  if (key) {
    document.getElementById('scoreboardKeyDisplay').textContent = key.label;
  }
});

let playerOverlaysEnabled = false;

function togglePlayerOverlays() {
  playerOverlaysEnabled = !playerOverlaysEnabled;
  ipcRenderer.send('toggle-player-overlays', playerOverlaysEnabled);
  document.getElementById('togglePlayerOverlaysBtn').textContent = playerOverlaysEnabled ? 'Disable' : 'Enable';
  document.getElementById('togglePlayerOverlaysBtn').className = playerOverlaysEnabled ? 'btn btn-danger' : 'btn btn-ghost';
  document.getElementById('playerOverlaysStatus').textContent = playerOverlaysEnabled ? 'Enabled' : 'Disabled';
  document.getElementById('playerOverlaysStatus').style.color = playerOverlaysEnabled ? '#10b981' : '#666';
}

// Allow pressing Enter to submit a custom MMR value
document.getElementById('mmrInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') setMMR();
});
