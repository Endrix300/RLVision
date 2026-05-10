const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const WebSocket = require('ws');
const https = require('https');

const S = require('../state');

// ─── Production State ──────────────────────────────────────────────────────────

let prodConfig = {
  eventName  : '',
  round      : 'Quarterfinal',
  format     : 'BO5',
  blueTeam   : '',
  blueLogo   : '',
  orangeTeam : '',
  orangeLogo : '',
};

let liveData = {
  scoreBlue      : 0,
  scoreOrange    : 0,
  time           : '5:00',
  isOvertime     : false,
  seriesBlue     : 0,
  seriesOrange   : 0,
  players        : [],
  focusedPlayer  : null,
};

let isObserverMode = false;

// ─── HTTP Server ───────────────────────────────────────────────────────────────

let server = null;
let wss    = null;
let sendToMainFn = null;

function start(sendToMain) {
  sendToMainFn = sendToMain;

  server = http.createServer((req, res) => {
    if (req.url === '/overlay' || req.url === '/overlay/') {
      const filePath = path.join(__dirname, 'overlay.html');
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('overlay.html not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      });
      return;
    }
    if (req.url === '/player' || req.url === '/player/') {
      const playerPath = path.join(__dirname, 'player.html');
      fs.readFile(playerPath, (err, data) => {
        if (err) { res.writeHead(404); res.end('player.html not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      });
      return;
    }
    if (req.url === '/recap' || req.url === '/recap/') {
      const filePath = path.join(__dirname, 'recap.html');
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('recap.html not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      });
      return;
    }
    if (req.url === '/ping') { res.writeHead(200); res.end('ok'); return; }

    if (req.url.startsWith('/assets/')) {
      const filePath = path.join(__dirname, req.url);
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        const ext = path.extname(filePath).slice(1);
        const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', webp: 'image/webp' };
        res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
        res.end(data);
      });
      return;
    }

    if (req.url.startsWith('/download-logo?')) {
      const urlObj   = new URL(req.url, 'http://127.0.0.1:3000');
      const imageUrl = urlObj.searchParams.get('url');
      const team     = urlObj.searchParams.get('team');

      if (!imageUrl) { res.writeHead(400); res.end('Missing url param'); return; }

      const fileName = `logo-${team}-${Date.now()}.png`;
      const destDir  = path.join(__dirname, 'assets');
      const destPath = path.join(destDir, fileName);

      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

      const file     = fs.createWriteStream(destPath);
      const protocol = imageUrl.startsWith('https') ? require('https') : require('http');

      protocol.get(imageUrl, (imgRes) => {
        imgRes.pipe(file);
        file.on('finish', () => {
          file.close();
          const localUrl = `http://localhost:3000/assets/${fileName}`;
          if (team === 'blue')   prodConfig.blueLogo   = localUrl;
          if (team === 'orange') prodConfig.orangeLogo = localUrl;
          broadcast({ type: 'config', prodConfig });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, url: localUrl }));
        });
      }).on('error', (err) => {
        res.writeHead(500); res.end('Download failed: ' + err.message);
      });
      return;
    }

    res.writeHead(404); res.end();
  });

  wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'init', prodConfig, liveData }));
  });

  server.listen(3000, '127.0.0.1', () => {
    console.log('🎬 Production server running on http://localhost:3000');
    if (sendToMainFn) sendToMainFn('prod-server-status', true);
  });

  server.on('error', (err) => {
    console.error('❌ Production server error:', err.message);
    if (sendToMainFn) sendToMainFn('prod-server-status', false);
  });
}

function stop() {
  if (wss)    { wss.close(); wss = null; }
  if (server) { server.close(); server = null; }
  if (sendToMainFn) sendToMainFn('prod-server-status', false);
}

// ─── Broadcast ─────────────────────────────────────────────────────────────────

function broadcast(payload) {
  if (!wss) return;
  const msg = JSON.stringify(payload);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// ─── Config Update ─────────────────────────────────────────────────────────────

function updateProdConfig(config) {
  Object.assign(prodConfig, config);
  broadcast({ type: 'config', prodConfig });
}

// ─── RL Event Hook ─────────────────────────────────────────────────────────────

function handleRLUpdate(event, data) {

  if (event === 'UpdateState' && data?.Game) {
    const game = data.Game;
    let changed = false;

    // Timer
    if (game.TimeSeconds !== undefined && game.TimeSeconds !== null) {
      const secs    = Math.max(0, Math.ceil(game.TimeSeconds));
      const minutes = Math.floor(secs / 60);
      const seconds = secs % 60;
      const newTime = `${minutes}:${seconds.toString().padStart(2, '0')}`;
      if (newTime !== liveData.time) { liveData.time = newTime; changed = true; }

      const newOT = !!game.bOvertime;
      if (newOT !== liveData.isOvertime) { liveData.isOvertime = newOT; changed = true; }
    }

    // Focused player — set/clear based on bHasTarget
    // Focused player
    if (game.bHasTarget && game.Target?.Name) {
        if (game.Target.Name !== liveData.focusedPlayer) {
            liveData.focusedPlayer = game.Target.Name;
            changed = true;
        }
        } else {
        if (liveData.focusedPlayer !== null) {
            liveData.focusedPlayer = null;
            changed = true;
        }
    }

    // If focusedPlayer not yet in players list, add a placeholder so overlay can display it
    if (liveData.focusedPlayer && !liveData.players.find(lp => lp.name === liveData.focusedPlayer)) {
      const t = game.Target;
      liveData.players.push({
        name    : t.Name,
        teamNum : t.TeamNum ?? 0,
        boost   : 0,
        score   : 0,
        goals   : 0,
        shots   : 0,
        assists : 0,
        saves   : 0,
        mmr     : null,
      });
      changed = true;
    }

    // Score
    if (game.Teams && game.Teams.length >= 2) {
      const newBlue   = game.Teams.find(t => t.TeamNum === 0)?.Score ?? liveData.scoreBlue;
      const newOrange = game.Teams.find(t => t.TeamNum === 1)?.Score ?? liveData.scoreOrange;
      if (newBlue !== liveData.scoreBlue)     { liveData.scoreBlue   = newBlue;   changed = true; }
      if (newOrange !== liveData.scoreOrange) { liveData.scoreOrange = newOrange; changed = true; }
    }

    // Players
    if (data.Players) {
      // Convertir l'objet data.Players (qui est souvent un dictionnaire/objet) en tableau si nécessaire
      const playerArray = Array.isArray(data.Players) ? data.Players : Object.values(data.Players);
      
      playerArray.forEach(p => {
        let existing = liveData.players.find(lp => lp.name === p.Name);

        if (!existing) {
          existing = { name: p.Name };
          liveData.players.push(existing);
        }

        // Mise à jour systématique des stats
        existing.teamNum = p.TeamNum;
        existing.boost   = p.Boost   ?? existing.boost   ?? 0;
        existing.score   = p.Score   ?? existing.score   ?? 0;
        existing.goals   = p.Goals   ?? existing.goals   ?? 0;
        existing.shots   = p.Shots   ?? existing.shots   ?? 0;
        existing.assists = p.Assists ?? existing.assists ?? 0;
        existing.saves   = p.Saves   ?? existing.saves   ?? 0;
        existing.demos   = p.Demos   ?? existing.demos   ?? 0;
        changed = true;
      });

      // On ne filtre les joueurs QUE s'il y a un changement majeur pour éviter de vider la liste par erreur
      const currentNames = playerArray.map(p => p.Name);
      if (currentNames.length > 0) {
          liveData.players = liveData.players.filter(lp => currentNames.includes(lp.name));
      }
    }

    if (changed) broadcast({ type: 'live', liveData });
  }

  if (event === 'MatchCreated' || event === 'MatchInitialized') {
    liveData.scoreBlue     = 0;
    liveData.scoreOrange   = 0;
    liveData.time          = '5:00';
    liveData.isOvertime    = false;
    liveData.players       = [];
    liveData.focusedPlayer = null;
    broadcast({ type: 'live', liveData });
    broadcast({ type: 'hide-recap' });
  }

  // Dans server.js, MatchEnded — ajoutez un log pour débugger
  if (event === 'MatchEnded') {
      const winner = data?.WinnerTeamNum;
      if (winner === 0) liveData.seriesBlue++;
      else              liveData.seriesOrange++;
      console.log('🏆 MatchEnded — seriesBlue:', liveData.seriesBlue, 'seriesOrange:', liveData.seriesOrange);
      broadcast({ type: 'live', liveData });
      broadcast({ type: 'hide-overlay' });
      broadcast({
        type: 'recap',
        data: {
          scoreBlue   : liveData.scoreBlue,
          scoreOrange : liveData.scoreOrange,
          seriesBlue  : liveData.seriesBlue,
          seriesOrange: liveData.seriesOrange,
          players     : liveData.players.map(p => ({
            name    : p.name,
            teamNum : p.teamNum,
            score   : p.score   ?? 0,
            goals   : p.goals   ?? 0,
            assists : p.assists ?? 0,
            shots   : p.shots   ?? 0,
            saves   : p.saves   ?? 0,
            demos   : p.demos   ?? 0,
          })),
          eventName  : prodConfig.eventName,
          round      : prodConfig.round,
          format     : prodConfig.format,
          blueTeam   : prodConfig.blueTeam,
          orangeTeam : prodConfig.orangeTeam,
          blueLogo   : prodConfig.blueLogo,
          orangeLogo : prodConfig.orangeLogo,
        },
      });
  }

  if (event === 'MatchDestroyed') {
      isObserverMode = false;
      liveData.scoreBlue     = 0;
      liveData.scoreOrange   = 0;
      liveData.time          = '5:00';
      liveData.isOvertime    = false;
      liveData.players       = [];
      liveData.focusedPlayer = null;
      broadcast({ type: 'live', liveData });
  }
}



function setManualSeries(blue, orange) {
  liveData.seriesBlue   = blue;
  liveData.seriesOrange = orange;
  broadcast({ type: 'live', liveData });
}


// ─── MMR update ────────────────────────────────────────────────────────────────

function updatePlayerMMR(name, mmr) {
  const p = liveData.players.find(p => p.name === name);
  if (p && p.mmr !== mmr) {
    p.mmr = mmr;
    broadcast({ type: 'live', liveData });
  }
}

// Dans module.exports :
module.exports = { start, stop, updateProdConfig, handleRLUpdate, updatePlayerMMR, setManualSeries };