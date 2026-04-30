const { ipcRenderer } = require('electron');

// Track the previous MMR value to detect changes and trigger animations
let prevMMR = null;

// Request the initial state from the main process on load
ipcRenderer.send('get-state');

// Listen for state updates pushed from the main process and refresh the overlay
ipcRenderer.on('state-update', (event, state) => {
  updateOverlay(state);
});

function updateOverlay(state) {
  const mmrEl = document.getElementById('ovMMR');
  const streakEl = document.getElementById('ovStreak');
  const winsEl = document.getElementById('ovWins');
  const lossesEl = document.getElementById('ovLosses');
  const changeEl = document.getElementById('mmrChange');
  const sessionEl = document.getElementById('ovMMRSession');

  // Show a colored +/- change badge and trigger the pop animation when MMR changes
  if (prevMMR !== null && prevMMR !== state.mmr) {
    const diff = state.mmr - prevMMR;
    changeEl.textContent = diff > 0 ? `+${diff}` : `${diff}`;
    changeEl.className = `ov-mmr-change show ${diff > 0 ? 'up' : 'down'}`;
    // Force a reflow to restart the CSS animation
    mmrEl.classList.remove('pop');
    void mmrEl.offsetWidth;
    mmrEl.classList.add('pop');
    // Hide the change badge after 2 seconds
    setTimeout(() => { changeEl.classList.remove('show'); }, 2000);
  }

  prevMMR = state.mmr;

  // Update the main MMR number
  mmrEl.textContent = state.mmr;

  // Update wins and losses counters
  winsEl.textContent = state.wins;
  lossesEl.textContent = state.losses;

  // Update streak display with color based on win/loss direction
  if (state.streak > 0) {
    streakEl.className = 'ov-streak win';
    streakEl.textContent = `🔥 ${state.streak}W streak`;
  } else if (state.streak < 0) {
    streakEl.className = 'ov-streak loss';
    streakEl.textContent = `❄️ ${Math.abs(state.streak)}L streak`;
  } else {
    streakEl.className = 'ov-streak neutral';
    streakEl.textContent = '— No streak';
  }

  // Update session MMR gain/loss with color coding
  const gained = state.mmrGained || 0;
  if (gained > 0) {
    sessionEl.className = 'ov-mmr-session positive';
    sessionEl.textContent = `📈 +${gained} session`;
  } else if (gained < 0) {
    sessionEl.className = 'ov-mmr-session negative';
    sessionEl.textContent = `📉 ${gained} session`;
  } else {
    sessionEl.className = 'ov-mmr-session neutral';
    sessionEl.textContent = `Δ +0 session`;
  }
}
