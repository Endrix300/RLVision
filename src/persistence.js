const fs   = require('fs');
const path = require('path');
const { app } = require('electron');

const S = require('./state');

const STATE_FILE = path.join(app.getPath('userData'), 'rlvision-positions.json');
module.exports.STATE_FILE = STATE_FILE;

// ─── Save ─────────────────────────────────────────────────────────────────────

function savePositionsToDisk() {
  let existing = {};
  try {
    if (fs.existsSync(STATE_FILE)) {
      existing = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {}

  const playlist = S.currentPlaylist ?? '2v2';
  existing.overlayX      = S.state.overlayX;
  existing.overlayY      = S.state.overlayY;
  existing.overlayWidth  = S.state.overlayWidth;
  existing.overlayHeight = S.state.overlayHeight;

  existing[`playerOverlayPositions_${playlist}`] = S.gamePlayers.map(p => ({
    teamNum  : p.teamNum,
    teamSlot : p.teamSlot,
    overlayX : p.overlayX ?? null,
    overlayY : p.overlayY ?? null,
  }));

  fs.writeFileSync(STATE_FILE, JSON.stringify(existing), 'utf8');
  console.log(`💾 Positions saved for mode: ${playlist}`);
}

// ─── Load ─────────────────────────────────────────────────────────────────────

function loadPositionsFromDisk() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      S.state.overlayX      = saved.overlayX      ?? null;
      S.state.overlayY      = saved.overlayY      ?? null;
      S.state.overlayWidth  = saved.overlayWidth  ?? 300;
      S.state.overlayHeight = saved.overlayHeight ?? 110;
      console.log('✅ Positions loaded from disk');

      if (saved.boostEnabled !== undefined) {
        S.mainWindow?.webContents.on('did-finish-load', () => {
          const { sendToMain } = require('./ipc-helpers');
          if (saved.boostEnabled !== undefined)
            sendToMain('boost-state', saved.boostEnabled);
        });
        console.log('✅ Boost state loaded — sound:', saved.boostEnabled);
      }
      if (saved.customCookedPath) {
        S.customCookedPath = saved.customCookedPath;
        console.log('✅ Custom cooked path loaded:', saved.customCookedPath);
      }
    }
  } catch (e) {
    console.log('⚠️ Could not load positions');
  }
  loadScoreboardKey();
}

// ─── Scoreboard Key ───────────────────────────────────────────────────────────

function saveScoreboardKey() {
  try {
    let existing = {};
    if (fs.existsSync(STATE_FILE)) {
      existing = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
    existing.scoreboardKey = S.scoreboardKey;
    fs.writeFileSync(STATE_FILE, JSON.stringify(existing), 'utf8');
    console.log('💾 Scoreboard key saved:', S.scoreboardKey);
  } catch (e) {}
}

function loadScoreboardKey() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (saved.scoreboardKey) {
        S.scoreboardKey = saved.scoreboardKey;
        console.log('✅ Scoreboard key loaded:', S.scoreboardKey);
      }
    }
  } catch (e) {}
}

module.exports = {
  STATE_FILE,
  savePositionsToDisk,
  loadPositionsFromDisk,
  saveScoreboardKey,
  loadScoreboardKey,
};
