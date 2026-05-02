const net = require('net');

// ─── Player Data ──────────────────────────────────────────────────────────────
let playerID = null;
let myTeamNum = null;
let currentPlaylist = null;
let roundStarted = false;
let initialMMRFetched = false;
let gamePlayers = []; // tableau {name, primaryId} de tous les joueurs


// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: Connect to Rocket League Stats API
// ─────────────────────────────────────────────────────────────────────────────
function connectToRL() {
  const client = new net.Socket();

  client.connect(49123, '127.0.0.1', () => {
    console.log('✅ Connected to RL Stats API');
  });

  client.on('data', (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.Data && typeof message.Data === 'string') {
        message.Data = JSON.parse(message.Data);
      }
      handleEvent(message, client);
    } catch (e) {}
  });

  client.on('error', (err) => {
    console.error('❌ Connection error:', err.message);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: Handle RL events
// ─────────────────────────────────────────────────────────────────────────────
function handleEvent(message, client) {
  const { Event, Data } = message;

  // Reset on new match
  if (Event === 'MatchCreated' || Event === 'MatchInitialized') {
    playerID = null;
    myTeamNum = null;
    currentPlaylist = null;
    roundStarted = false;
    initialMMRFetched = false;
    playersLogged = false;
    gamePlayers = [];
    console.log('🔄 New match detected, resetting...');
  }

  // All players loaded when round starts
  if (Event === 'RoundStarted') {
    roundStarted = true;
    console.log('🚀 Round started, all players loaded!');
  }

  if (Event === 'UpdateState' && Data && Data.Players) {


        // Log all players once after RoundStarted
    if (roundStarted && !playersLogged && Data.Players.length > 0) {
      playersLogged = true;

      // Construire le tableau
      gamePlayers = Data.Players
        .filter(p => p.PrimaryId)
        .map(p => ({ name: p.Name, primaryId: p.PrimaryId, teamNum: p.TeamNum }));

      console.log('─────────────────────────────');
      console.log('👥 Players found:', gamePlayers.length);
      gamePlayers.forEach(p => console.log(`   • [${p.teamNum === 0 ? 'Blue' : 'Orange'}] ${p.name} — ${p.primaryId}`));
      console.log('─────────────────────────────');

      // Fetch MMR pour chacun
      for (const player of gamePlayers) {
        getMMR(player.primaryId, currentPlaylist ?? '2v2').then(mmr => {
          console.log(`🏆 ${player.name}: ${mmr ?? 'N/A'} MMR`);
        });
      }
    }

    // Step 1: Identify player via camera target AFTER round started (guaranteed to be you)
    if (!playerID && roundStarted && Data.Game && Data.Game.bHasTarget && Data.Game.Target) {
      const targetName = Data.Game.Target.Name;
      const me = Data.Players.find(p => p.Name === targetName);
      if (me && me.PrimaryId) {
        playerID = me.PrimaryId;
        myTeamNum = me.TeamNum;
        console.log('👤 Player identified:', me.Name);
        console.log('👤 Team:', myTeamNum === 0 ? 'Blue' : 'Orange');
      }
    }

    // Step 2: Detect playlist after RoundStarted
    if (playerID && currentPlaylist === null && roundStarted) {
      const myTeamPlayers = Data.Players.filter(p => p.TeamNum === myTeamNum);
      const total = myTeamPlayers.length;
      console.log('👥 Players in my team:', total);

      if (total === 1) currentPlaylist = '1v1';
      else if (total === 2) currentPlaylist = '2v2';
      else if (total >= 3) currentPlaylist = '3v3';
      console.log('🎮 Playlist detected:', currentPlaylist);
    }

    // Step 3: Fetch MMR once ready
    if (playerID && currentPlaylist !== null && !initialMMRFetched) {
      initialMMRFetched = true;
      getMMR(playerID, currentPlaylist).then(mmr => {
        console.log('🏆 Real MMR:', mmr, '(' + currentPlaylist + ')');
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3: Fetch real MMR from rlstats.net
// ─────────────────────────────────────────────────────────────────────────────
async function getMMR(primaryId, playlist = '2v2') {
  try {
    const parts = primaryId.split('|');
    const platform = parts[0];
    const id = parts[1];

    let url;
    if (platform.toLowerCase() === 'epic') {
      url = `https://rlstats.net/profile/Epic/${id}`;
    } else if (platform.toLowerCase() === 'steam') {
      url = `https://rlstats.net/profile/Steam/${id}`;
    } else if  (platform.toLowerCase() === 'xboxone'){
      url = `https://rlstats.net/profile/Xbox/${id}`;
    } else if  (platform.toLowerCase() === 'ps4'){
      url = `https://rlstats.net/profile/PS4/${id}`;
    } else if (platform.toLowerCase() === 'switch') {
      console.log('⚠️ Switch not supported by rlstats.net, skipping:', id);
      return null;
    }
    else {
      console.log('⚠️ Unknown platform:', platform);
      return null;
    }

    console.log('🌐 Fetching:', url);
    const response = await fetch(url);
    const html = await response.text();
    const dataMatch = html.match(/new Date\(\d+\*1000\),\s*([\d,\s]+)/);
    if (!dataMatch) return null;

    const values = dataMatch[1].split(',').map(v => parseInt(v.trim())).filter(v => !isNaN(v));
    console.log('📊 MMR values:', values);

    // Index: 0=Duel(1v1), 1=Doubles(2v2), 2=Standard(3v3)
    const index = { '1v1': 0, '2v2': 1, '3v3': 2 };
    return values[index[playlist] ?? 1] ?? null;

  } catch (err) {
    console.error('❌ MMR fetch error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
connectToRL();