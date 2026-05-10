const { ipcRenderer } = require('electron');

// ─── State ────────────────────────────────────────────────────────────────────

// Track the previous MMR value to detect changes and trigger animations
let prevMMR = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

// Request the initial state from the main process on load
ipcRenderer.send('get-state');

// ─── IPC Listeners ────────────────────────────────────────────────────────────

// Listen for state updates pushed from the main process and refresh the overlay
ipcRenderer.on('state-update', (event, state) => {
  updateOverlay(state);
});

// ─── UI Update ────────────────────────────────────────────────────────────────

/**
 * Refreshes all overlay elements with the latest game state.
 * Handles MMR change animations, streak display, and session tracking.
 *
 * @param {object} state - The global state object from the main process
 * @param {number} state.mmr        - Current MMR value
 * @param {number} state.wins       - Wins this session
 * @param {number} state.losses     - Losses this session
 * @param {number} state.streak     - Current win/loss streak (positive = wins, negative = losses)
 * @param {number} state.mmrGained  - Net MMR gained or lost this session
 */
function updateOverlay(state) {
  const mmrEl     = document.getElementById('ovMMR');
  const streakEl  = document.getElementById('ovStreak');
  const winsEl    = document.getElementById('ovWins');
  const lossesEl  = document.getElementById('ovLosses');
  const changeEl  = document.getElementById('mmrChange');
  const sessionEl = document.getElementById('ovMMRSession');

  // ── MMR Change Badge ────────────────────────────────────────────────────────
  // Show a colored +/- badge and trigger the pop animation when MMR changes
  if (prevMMR !== null && prevMMR !== state.mmr) {
    const diff = state.mmr - prevMMR;

    // Set badge text and apply the appropriate color class
    changeEl.textContent = diff > 0 ? `+${diff}` : `${diff}`;
    changeEl.className = `ov-mmr-change show ${diff > 0 ? 'up' : 'down'}`;

    // Force a reflow to restart the CSS pop animation from scratch
    mmrEl.classList.remove('pop');
    void mmrEl.offsetWidth;
    mmrEl.classList.add('pop');

    // Hide the change badge after 2 seconds
    setTimeout(() => changeEl.classList.remove('show'), 2000);
  }

  // Store current MMR for comparison on the next update
  prevMMR = state.mmr;

  // ── Core Stats ──────────────────────────────────────────────────────────────

  // Update the main MMR number display
  mmrEl.textContent = state.mmr;

  const rk = document.getElementById('ovRankImg');
  if (rk) {
    if (state.rankImageUrl) {
      rk.onerror = () => { rk.style.display = 'none'; rk.removeAttribute('src'); };
      rk.onload  = () => { rk.style.display = 'block'; };
      if (rk.getAttribute('data-src-active') !== state.rankImageUrl) {
        rk.setAttribute('data-src-active', state.rankImageUrl);
        rk.style.display = 'block'; // ← force AVANT src (cache ou pas)
        rk.src = state.rankImageUrl;
      } else {
        rk.style.display = 'block'; // ← déjà chargée, force l'affichage
      }
    } else {
      rk.removeAttribute('data-src-active');
      rk.removeAttribute('src');
      rk.style.display = 'none';
    }
  }

  // Update wins and losses counters
  winsEl.textContent   = state.wins;
  lossesEl.textContent = state.losses;

  // ── Streak Display ──────────────────────────────────────────────────────────
  // Color and label differ depending on whether the player is on a win or loss streak
  if (state.streak > 0) {
    streakEl.className   = 'ov-streak win';
    streakEl.textContent = `🔥 ${state.streak} Win streak`;
  } else if (state.streak < 0) {
    streakEl.className   = 'ov-streak loss';
    streakEl.textContent = `❄️ ${Math.abs(state.streak)} Loss streak`;
  } else {
    streakEl.className   = 'ov-streak neutral';
    streakEl.textContent = '— No streak';
  }

  // ── Session MMR Delta ───────────────────────────────────────────────────────
  // Show the net MMR change for the current session with color-coded arrows
  const gained = state.mmrGained || 0;

  if (gained > 0) {
    sessionEl.className   = 'ov-mmr-session positive';
    sessionEl.textContent = `📈 +${gained} MMR`;
  } else if (gained < 0) {
    sessionEl.className   = 'ov-mmr-session negative';
    sessionEl.textContent = `📉 ${gained} MMR`;
  } else {
    sessionEl.className   = 'ov-mmr-session neutral';
    sessionEl.textContent = `Δ 0 MMR`;
  }
}
