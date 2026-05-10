const net = require('net');

const S = require('./state');
const { sendToMain, broadcastState } = require('./ipc-helpers');
const { fetchRealMMR, fetchRealMMRWithRetry } = require('./mmr');
const { createPlayerOverlays } = require('./windows');
const prodServer = require('./production/server');

// ─── Connection ───────────────────────────────────────────────────────────────

function connectToRL() {
  if (S.client) { S.client.destroy(); S.client = null; }

  S.client = new net.Socket();

  S.client.connect(49123, '127.0.0.1', () => {
    console.log('✅ Connected to RL Stats API');
    sendToMain('rl-connected', true);
    const { sendToOverlay } = require('./ipc-helpers');
    sendToOverlay('rl-connected', true);
    if (S.reconnectInterval) { clearInterval(S.reconnectInterval); S.reconnectInterval = null; }
  });

  S.client.on('data', (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.Data && typeof message.Data === 'string') {
        message.Data = JSON.parse(message.Data);
      }
      handleRLEvent(message);
    } catch (e) {}
  });

  S.client.on('error', () => { sendToMain('rl-connected', false); startReconnect(); });
  S.client.on('close',  () => { sendToMain('rl-connected', false); startReconnect(); });
}

function startReconnect() {
  if (S.reconnectInterval) return;
  S.reconnectInterval = setInterval(connectToRL, 5000);
}

// ─── Event Handler ────────────────────────────────────────────────────────────

function handleRLEvent(message) {
  const { Event, Data } = message;

  // ── Match Start ─────────────────────────────────────────────────────────────
  if (Event === 'MatchCreated' || Event === 'MatchInitialized') {
    if (S.recapHideTimer) { clearTimeout(S.recapHideTimer); S.recapHideTimer = null; }
    S.recapPending = false;
    if (S.recapOverlayWindow && !S.recapOverlayWindow.isDestroyed()) S.recapOverlayWindow.hide();
    S.matchEnded        = false;
    S.myTeamNum         = null;
    S.currentPlaylist   = null;
    S.initialMMRFetched = false;
    S.roundStarted      = false;
    S.playerID          = null;
    S.gamePlayers       = [];
    S.playersLogged     = false;
    S.playerOverlayWindows.forEach(w => { if (w && !w.isDestroyed()) w.destroy(); });
    S.playerOverlayWindows = [];
    S.previousOrder     = {};
  }

  // ── Round Started ────────────────────────────────────────────────────────────
  if (Event === 'RoundStarted') {
    S.roundStarted = true;
    console.log('🚀 Round started — all players loaded');
  }

  // ── State Updates ────────────────────────────────────────────────────────────
  if (Event === 'UpdateState' && Data && Data.Players) {
    if (Data.Game) S.lastTimeSeconds = Data.Game.TimeSeconds ?? null;

    // Detect observer mode: all players have Boost field (SPECTATOR fields)
    const allHaveBoost = Data.Players.length > 0 && Data.Players.every(p => p.Boost !== undefined);
    if (allHaveBoost && !S.playerID && S.roundStarted) {
      // Observer mode: set a dummy playerID so the rest of the logic can proceed
      S.playerID  = '__observer__';
      S.myTeamNum = null;
      console.log('🎥 Observer mode — skipping player identification');
    }

    // Step 1: Log players once
    if (S.roundStarted && !S.playersLogged && Data.Players.length > 0) {
      S.playersLogged = true;
      S.gamePlayers = Data.Players.map(p => ({
        name      : p.Name,
        primaryId : p.PrimaryId && !p.PrimaryId.startsWith('Unknown') ? p.PrimaryId : null,
        teamNum   : p.TeamNum,
      }));
      S.gamePlayers.sort((a, b) => a.teamNum - b.teamNum);

      console.log('─────────────────────────────');
      console.log('👥 Players found:', S.gamePlayers.length);
      S.gamePlayers.forEach(p =>
        console.log(`   • [${p.teamNum === 0 ? 'Blue' : 'Orange'}] ${p.name} — ${p.primaryId}`)
      );
      console.log('─────────────────────────────');

    }

    // Step 2: Identify local player
    if (!S.playerID && S.roundStarted && Data.Game?.bHasTarget && Data.Game?.Target) {
      const targetName = Data.Game.Target.Name;
      const me = Data.Players.find(p => p.Name === targetName);
      if (me && me.PrimaryId) {
        S.playerID  = me.PrimaryId;
        S.myTeamNum = me.TeamNum;
        console.log('👤 Player identified:', me.Name);
        console.log('👤 Team:', S.myTeamNum === 0 ? 'Blue' : 'Orange');
      }
    }

    // Step 3: Detect playlist
    if (S.playerID && S.currentPlaylist === null && !S.matchEnded && S.roundStarted) {
      const total = Data.Players.length;
      if      (total === 2) S.currentPlaylist = '1v1';
      else if (total === 4) S.currentPlaylist = '2v2';
      else if (total === 6) S.currentPlaylist = '3v3';
      else return;

      S.lastPlaylist = S.currentPlaylist;
      console.log('🎮 Playlist detected:', S.currentPlaylist);

      if (S.playerOverlaysEnabled) createPlayerOverlays();

      // ← Fetch MMR des autres joueurs ICI avec la bonne playlist
      for (const player of S.gamePlayers) {
        if (player.primaryId === S.playerID || !player.primaryId) continue;
        fetchRealMMR(false, player.primaryId, S.currentPlaylist).then(mmr => {
          player.mmr = mmr;
          prodServer.updatePlayerMMR(player.name, mmr);
          const idx = S.gamePlayers.indexOf(player);
          const win = S.playerOverlayWindows[idx];
          if (win && !win.isDestroyed()) {
            win.webContents.send('player-data', {
              name: player.name, mmr,
              teamNum: player.teamNum, teamSlot: player.teamSlot,
            });
          }
        });
      }
    }

    // Step 4: Fetch initial MMR (skip in observer mode)
    if (S.playerID && S.playerID !== '__observer__' && S.currentPlaylist !== null && !S.initialMMRFetched) {
      S.initialMMRFetched = true;
      console.log('🎮 Fetching initial MMR...');
      sendToMain('mmr-source', 'fetching');
      fetchRealMMR();
    }

    // Step 5: Re-sort player overlays by live score
    if (S.roundStarted && S.gamePlayers.length > 0 && S.playerOverlayWindows.length > 0) {
      const blueTeam   = S.gamePlayers.filter(p => p.teamNum === 0);
      const orangeTeam = S.gamePlayers.filter(p => p.teamNum === 1);

      for (const team of [blueTeam, orangeTeam]) {
        const teamKey = team[0].teamNum === 0 ? 'blue' : 'orange';

        team.forEach(p => {
          const live = Data.Players.find(lp => lp.Name === p.name);
          if (live) p.liveScore = live.Score ?? 0;
        });

        const sorted    = [...team].sort((a, b) => b.liveScore - a.liveScore);
        const newOrder  = sorted.map(p => p.name);
        const prevOrder = S.previousOrder[teamKey] ?? [];

        if (newOrder.every((name, i) => name === prevOrder[i])) continue;
        S.previousOrder[teamKey] = newOrder;

        sorted.forEach((player, i) => {
          const targetSlot = i + 1;
          const slotIndex  = S.gamePlayers.findIndex(
            p => p.teamNum === team[0].teamNum && p.teamSlot === targetSlot
          );
          const win = S.playerOverlayWindows[slotIndex];
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

    if (Data.Game?.bOvertime) S.lastBOvertime = true;

    if (Data.Game && !S.matchEnded) {
      if (Data.Game.TimeSeconds === 0 || S.lastBOvertime) {
        const teams = Data.Game.Teams;
        if (teams && teams.length >= 2) {
          const blueScore   = teams.find(t => t.TeamNum === 0)?.Score ?? 0;
          const orangeScore = teams.find(t => t.TeamNum === 1)?.Score ?? 0;
          const winnerTeam  = blueScore > orangeScore ? 0 : 1;
          S.playerWon = winnerTeam === S.myTeamNum;
        }
      }
    }
  }

  // ── Match Ended ──────────────────────────────────────────────────────────────
  if (Event === 'MatchEnded' && !S.matchEnded) {
    S.matchEnded = true;
    const won = Data.WinnerTeamNum === (S.myTeamNum ?? 0);
    console.log(`🏁 Match ended | ${won ? 'WIN' : 'LOSS'}`);

    if (S.recapAutoEnabled && S.recapOverlayWindow && !S.recapOverlayWindow.isDestroyed()) {
      if (S.recapHideTimer) clearTimeout(S.recapHideTimer);
      S.recapHideTimer = setTimeout(() => {
        S.recapHideTimer = null;
        if (!S.recapOverlayWindow || S.recapOverlayWindow.isDestroyed()) return;
        if (S.rlFocused) {
          S.recapOverlayWindow.showInactive();
          S.recapOverlayWindow.setIgnoreMouseEvents(true, { forward: true });
        } else {
          S.recapPending = true;
        }
      }, 10000);
    }

    if (won) { S.state.wins++;   S.state.streak = S.state.streak > 0 ? S.state.streak + 1 : 1;  }
    else      { S.state.losses++; S.state.streak = S.state.streak < 0 ? S.state.streak - 1 : -1; }

    broadcastState();
    S.playerOverlayWindows.forEach(w => { if (w && !w.isDestroyed()) w.destroy(); });
    S.playerOverlayWindows = [];
    const playlistForMMR = S.currentPlaylist;
    S.currentPlaylist = null;
    console.log('⏳ Waiting for rlstats.net to update...');
    sendToMain('mmr-source', 'fetching');
    fetchRealMMRWithRetry(playlistForMMR);
  }

  // ── Match Destroyed ──────────────────────────────────────────────────────────
  if (Event === 'MatchDestroyed') {
    const savedPlaylist = S.currentPlaylist;

    if (S.currentPlaylist !== null) {
      if (S.lastTimeSeconds !== 0 && !S.lastBOvertime) S.playerWon = false;
      if (S.playerWon === null) S.playerWon = false;

      if (S.playerWon) { S.state.wins++;   S.state.streak = S.state.streak > 0 ? S.state.streak + 1 : 1;  }
      else              { S.state.losses++; S.state.streak = S.state.streak < 0 ? S.state.streak - 1 : -1; }

      broadcastState();
      sendToMain('mmr-source', 'fetching');
      fetchRealMMRWithRetry(savedPlaylist);
    }

    S.playerOverlayWindows.forEach(w => { if (w && !w.isDestroyed()) w.destroy(); });
    S.playerOverlayWindows = [];
    S.gamePlayers      = [];
    S.currentPlaylist  = null;
    S.roundStarted     = false;
    S.playersLogged    = false;
    S.previousOrder    = {};
    S.playerWon        = null;
    S.lastTimeSeconds  = null;
    S.lastBOvertime    = null;
    console.log('🚪 Match destroyed — state reset');
  }

  // ── Production server hook ───────────────────────────────────────────────────
  // Doit rester en dernier pour que le state S soit déjà mis à jour ci-dessus
  prodServer.handleRLUpdate(Event, Data);
}

module.exports = { connectToRL, startReconnect };