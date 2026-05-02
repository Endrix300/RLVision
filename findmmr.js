const net = require('net');

// ─── Player State ─────────────────────────────────────────────────────────────

let playerID          = null;  // Primary ID of the local player (platform|id format)
let myTeamNum         = null;  // Team number of the local player (0 = Blue, 1 = Orange)
let currentPlaylist   = null;  // Detected playlist: '1v1', '2v2', or '3v3'
let roundStarted      = false; // True once the first round has started (all players are loaded)
let initialMMRFetched = false; // Prevents fetching the local player's MMR more than once
let playersLogged     = false; // Prevents logging the player list more than once per match
let gamePlayers       = [];    // Array of { name, primaryId, teamNum } for all players in the match

// ─── Connection ───────────────────────────────────────────────────────────────

/**
 * Opens a TCP connection to the Rocket League SOS plugin stats API on port 49123.
 * All incoming JSON messages are forwarded to handleEvent().
 */
function connectToRL() {
  const client = new net.Socket();

  client.connect(49123, '127.0.0.1', () => {
    console.log('✅ Connected to RL Stats API');
  });

  client.on('data', (data) => {
    try {
      const message = JSON.parse(data.toString());

      // The Data field is sometimes a JSON string — parse it if needed
      if (message.Data && typeof message.Data === 'string') {
        message.Data = JSON.parse(message.Data);
      }

      handleEvent(message, client);
    } catch (e) {
      // Silently ignore malformed messages
    }
  });

  client.on('error', (err) => {
    console.error('❌ Connection error:', err.message);
  });
}

// ─── Event Handler ────────────────────────────────────────────────────────────

/**
 * Processes incoming events from the RL Stats API.
 * Handles match lifecycle, player identification, playlist detection, and MMR fetching.
 *
 * @param {object} message - Parsed event object with { Event, Data }
 * @param {net.Socket} client - The active TCP socket (unused here, kept for extensibility)
 */
function handleEvent(message, client) {
  const { Event, Data } = message;

  // ── Match Reset ─────────────────────────────────────────────────────────────
  // Reset all state whenever a new match is created or initialized
  if (Event === 'MatchCreated' || Event === 'MatchInitialized') {
    playerID          = null;
    myTeamNum         = null;
    currentPlaylist   = null;
    roundStarted      = false;
    initialMMRFetched = false;
    playersLogged     = false;
    gamePlayers       = [];
    console.log('🔄 New match detected, resetting state...');
  }

  // ── Round Started ───────────────────────────────────────────────────────────
  // All players are guaranteed to be present in UpdateState after this event
  if (Event === 'RoundStarted') {
    roundStarted = true;
    console.log('🚀 Round started — all players are loaded');
  }

  // ── State Updates ───────────────────────────────────────────────────────────
  if (Event === 'UpdateState' && Data && Data.Players) {

    // Step 1: Log all players once after the first round starts
    if (roundStarted && !playersLogged && Data.Players.length > 0) {
      playersLogged = true;

      // Build the player list, filtering out entries without a Primary ID
      gamePlayers = Data.Players
        .filter(p => p.PrimaryId)
        .map(p => ({ name: p.Name, primaryId: p.PrimaryId, teamNum: p.TeamNum }));

      console.log('─────────────────────────────');
      console.log('👥 Players found:', gamePlayers.length);
      gamePlayers.forEach(p =>
        console.log(`   • [${p.teamNum === 0 ? 'Blue' : 'Orange'}] ${p.name} — ${p.primaryId}`)
      );
      console.log('─────────────────────────────');

      // Fetch MMR for every player in the match
      for (const player of gamePlayers) {
        getMMR(player.primaryId, currentPlaylist ?? '2v2').then(mmr => {
          console.log(`🏆 ${player.name}: ${mmr ?? 'N/A'} MMR`);
        });
      }
    }

    // Step 2: Identify the local player via the camera target (only reliable after RoundStarted)
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

    // Step 3: Detect the playlist by counting players on the local team
    if (playerID && currentPlaylist === null && roundStarted) {
      const myTeamPlayers = Data.Players.filter(p => p.TeamNum === myTeamNum);
      const total = myTeamPlayers.length;
      console.log('👥 Players on my team:', total);

      if      (total === 1) currentPlaylist = '1v1';
      else if (total === 2) currentPlaylist = '2v2';
      else if (total >= 3)  currentPlaylist = '3v3';

      console.log('🎮 Playlist detected:', currentPlaylist);
    }

    // Step 4: Fetch the local player's MMR once both playerID and playlist are known
    if (playerID && currentPlaylist !== null && !initialMMRFetched) {
      initialMMRFetched = true;
      getMMR(playerID, currentPlaylist).then(mmr => {
        console.log('🏆 My MMR:', mmr, `(${currentPlaylist})`);
      });
    }
  }
}

// ─── MMR Fetch ────────────────────────────────────────────────────────────────

/**
 * Fetches a player's ranked MMR by scraping their rlstats.net profile page.
 * Supports Epic, Steam, Xbox, and PS4 platforms.
 *
 * @param {string} primaryId - Player ID in 'platform|id' format (e.g. 'Epic|username')
 * @param {string} [playlist='2v2'] - Target playlist: '1v1', '2v2', or '3v3'
 * @returns {Promise<number|null>} The MMR value, or null if unavailable
 */
async function getMMR(primaryId, playlist = '2v2') {
  try {
    const [platform, id] = primaryId.split('|');

    // Build the profile URL based on the player's platform
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

    console.log('🌐 Fetching:', url);
    const response = await fetch(url);
    const html = await response.text();

    // Extract the MMR array from the embedded chart data in the page
    const dataMatch = html.match(/new Date\(\d+\*1000\),\s*([\d,\s]+)/);
    if (!dataMatch) return null;

    const values = dataMatch[1]
      .split(',')
      .map(v => parseInt(v.trim()))
      .filter(v => !isNaN(v));

    console.log('📊 MMR values (1v1, 2v2, 3v3):', values);

    // Map playlist name to its index in the values array
    const playlistIndex = { '1v1': 0, '2v2': 1, '3v3': 2 };
    return values[playlistIndex[playlist] ?? 1] ?? null;

  } catch (err) {
    console.error('❌ MMR fetch error:', err.message);
    return null;
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

connectToRL();
