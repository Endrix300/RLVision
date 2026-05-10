const { BrowserWindow, app } = require('electron');

const S = require('./state');
const { sendToMain, broadcastState } = require('./ipc-helpers');

// rlstats.net is behind Cloudflare; plain fetch() often gets a challenge page (no MMR chart).
// We retry by loading the profile in a hidden Chromium window (same engine as Electron).

let chromiumRlstatsChain = Promise.resolve();
let warnedCloudflare = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failEstimatedMMR(isMe) {
  if (!isMe) return;
  S.state.rankImageUrl = null;
  broadcastState();
  sendToMain('mmr-source', 'estimated');
}

function isLikelyCloudflareChallenge(html) {
  if (!html || typeof html !== 'string') return true;
  if (html.length < 400) return true;
  const h = html.toLowerCase();
  return (
    h.includes('just a moment') ||
    h.includes('_cf_chl_opt') ||
    h.includes('/cdn-cgi/challenge-platform/') ||
    h.includes('cf-challenge') ||
    h.includes('checking your browser')
  );
}

function extractNumericMmrFromRlstatsHtml(html, playlist) {
  const dataMatch = html.match(/new Date\(\d+\*1000\),\s*([\d,\s]+)/);
  if (!dataMatch) return null;

  const values = dataMatch[1]
    .split(',')
    .map((v) => parseInt(v.trim(), 10))
    .filter((v) => !Number.isNaN(v));

  if (!values.length) return null;

  let idx = 1;
  if (playlist === '1v1') idx = 0;
  else if (playlist === '3v3') idx = 2;

  const mmr = values[idx];
  return Number.isFinite(mmr) ? mmr : null;
}

function decodeHtmlAttrUrl(s) {
  return String(s || '').replace(/&amp;/g, '&');
}

/** Slice HTML roughly around ranked playlists to reduce unrelated images */
function narrowHtmlForRankImages(html) {
  const low = html.toLowerCase();
  const markers = [
    'ranked playlists',
    'competitive playlists',
    'playlist ratings',
    'ranked duel',
    'playlist mmr',
    'playlist rating',
    'rank icons',
    'rated playlists',
  ];
  let start = -1;
  for (const mk of markers) {
    const i = low.indexOf(mk);
    if (i !== -1 && (start === -1 || i < start)) start = i;
  }
  let slice = html;
  if (start !== -1) {
    let end = low.indexOf('match history', start + 900);
    if (end === -1) end = low.indexOf('recent mat', start + 900);
    if (end === -1) end = low.indexOf('game history', start + 900);
    if (end === -1) end = Math.min(low.length, start + 200000);
    slice = html.slice(start, Math.max(start + 1, end));
  }
  return slice.slice(0, 220000);
}

function extractHttpsImageUrls(fragment) {
  const out = [];
  const attrs = /\b(?:src|data-src|data-original-src)=["'](https?:\/\/[^"']+)/gi;
  let m;
  while ((m = attrs.exec(fragment)) !== null)
    out.push(decodeHtmlAttrUrl(m[1]));

  const cssUrl =
    /url\(\s*["']?(https:\/\/[^"')]+\.(?:png|webp|jpg|jpeg|svg)(?:\?[^"'())]*)?)["']?\s*\)/gi;
  while ((m = cssUrl.exec(fragment)) !== null)
    out.push(decodeHtmlAttrUrl(m[1]));

  return out.filter((u) => /^https:\/\//i.test(u.trim()));
}

function rankBadgeScore(url) {
  const u = url.toLowerCase();
  let s = 0;
  if (!/^https:\/\//i.test(url)) return -100;

  if (/rlstats\.(net|io)|cdn[^\s"',]*rlstats/i.test(u)) s += 3;
  if (/(?:rank|competitive|playlist|rated|tier|division|badge|grandchamp|c\d|ssl)/i.test(u))
    s += 3;

  if (/(?:logo(?![^/]*rank)|banner|avatar|profile-photo|steamcommunity|discord|twitter|tiktok|footer|header|payment|premium|reward|battlepass)/i.test(
    u
  ))
    s -= 7;
  if (/(?:favicon|spinner|loading|placeholder)/i.test(u)) s -= 10;

  if (/\.(?:png|webp)(?:\?|$)/i.test(u)) s += 1;

  return s;
}

function isRankBadgeCandidate(url) {
  return rankBadgeScore(url) >= 4 && /\.(?:png|webp|jpe?g|svg)(?:\?|$)/i.test(url);
}

function playlistRankImageIndex(playlist) {
  if (playlist === '1v1') return 0;
  if (playlist === '3v3') return 2;
  return 1;
}

/** Slice HTML roughly around ranked playlists to reduce unrelated images */
function narrowHtmlForRankImages(html) {
  const low = html.toLowerCase();
  const markers = [
    'ranked playlists',
    'competitive playlists',
    'playlist ratings',
    'ranked duel',
    'playlist mmr',
    'playlist rating',
    'rank icons',
    'rated playlists',
    // Ajouts pour couvrir plus de layouts rlstats
    '1v1 duel',
    '2v2 doubles',
    '3v3 standard',
    'duel</th>',
    'doubles</th>',
    'standard</th>',
  ];
  let start = -1;
  for (const mk of markers) {
    const i = low.indexOf(mk);
    if (i !== -1 && (start === -1 || i < start)) start = i;
  }
  let slice = html;
  if (start !== -1) {
    let end = low.indexOf('match history', start + 900);
    if (end === -1) end = low.indexOf('recent mat', start + 900);
    if (end === -1) end = low.indexOf('game history', start + 900);
    if (end === -1) end = Math.min(low.length, start + 200000);
    slice = html.slice(start, Math.max(start + 1, end));
  }
  return slice.slice(0, 220000);
}

function parseRankImageUrlFromRlstatsHtml(html, playlist) {
  const chunk = narrowHtmlForRankImages(html);

  console.log('[rank-img] chunk length:', chunk.length);
  console.log('[rank-img] chunk preview (first 300):', chunk.substring(0, 300));

  // Regex qui accepte guillemets ET apostrophes
  const re = /src=["']([^"']*s32rank(\d+)[^"']*\.png)["'][^>]*alt=["']([^"']*)["']/gi;
  const matches = [];
  let m;
  while ((m = re.exec(chunk)) !== null) {
    const src = m[1], num = m[2], alt = m[3];
    const ctx = chunk.slice(Math.max(0, m.index - 100), m.index);
    if (ctx.includes('unranked-estimate')) {
      console.log('[rank-img] SKIP unranked-estimate:', num, alt);
      continue;
    }

    let url;
    if (src.startsWith('http')) {
      url = src;
    } else if (src.startsWith('/images/')) {
      url = 'https://rlstats.net' + src;
    } else {
      // Chemin local Chrome → reconstruit depuis le numéro
      url = `https://rlstats.net/images/ranks/s32rank${num}.png`;
    }

    console.log('[rank-img] MATCH num:', num, '| alt:', alt, '| url:', url);
    matches.push(url);
  }

  console.log('[rank-img] Total matches:', matches.length, '| playlist:', playlist);

  if (!matches.length) {
    console.log('[rank-img] No matches → fallback');
    return parseRankImageUrlFallback(chunk, playlist);
  }

  const idx = playlistRankImageIndex(playlist);
  const picked = matches[idx] ?? matches[Math.min(idx, matches.length - 1)] ?? matches[0];
  console.log('[rank-img] idx:', idx, '| picked:', picked);
  return picked;
}

// Renomme l'ancienne fonction en fallback
function parseRankImageUrlFallback(chunk, playlist) {
  const raw = extractHttpsImageUrls(chunk);
  const ordered = [];
  const seen = new Set();
  for (const url of raw) {
    const u = url.trim();
    if (seen.has(u)) continue;
    if (!isRankBadgeCandidate(u)) continue;
    seen.add(u);
    ordered.push(u);
  }
  if (!ordered.length) return null;
  const idx = playlistRankImageIndex(playlist);
  return ordered[idx] || ordered[Math.min(idx, ordered.length - 1)] || ordered[0];
}

function parseRlstatsFromHtml(html, playlist) {
  const mmr = extractNumericMmrFromRlstatsHtml(html, playlist);
  console.log('[rlstats] MMR extracted:', mmr, '| playlist:', playlist);
  
  let rankImageUrl = null;
  if (Number.isFinite(mmr)) {
    rankImageUrl = parseRankImageUrlFromRlstatsHtml(html, playlist);
    console.log('[rlstats] rankImageUrl:', rankImageUrl);
  } else {
    console.log('[rlstats] MMR not found → skipping rank image');
  }
  return { mmr, rankImageUrl };
}

/**
 * SOS PrimaryId often has extra "|..." segments (e.g. Epic|uuid|0).
 * rlstats.net Epic URLs use compact 32-hex (no hyphens).
 */
function normalizeRlstatsId(platformLower, idJoined) {
  const raw = String(idJoined || '').trim();
  if (!raw) return '';
  const first = raw.split('|')[0].trim();

  if (platformLower === 'epic') {
    const compactHex = first.replace(/-/g, '');
    if (/^[a-fA-F0-9]{32}$/.test(compactHex)) return compactHex.toLowerCase();
    return first;
  }

  return first;
}

function buildRlstatsProfileUrls(platformLower, pathId) {
  const urls = [];
  switch (platformLower) {
    case 'epic':
      urls.push(`https://rlstats.net/profile/Epic/${encodeURIComponent(pathId)}`);
      break;
    case 'steam':
      urls.push(`https://rlstats.net/profile/Steam/${encodeURIComponent(pathId)}`);
      break;
    case 'xboxone':
      urls.push(`https://rlstats.net/profile/Xbox/${encodeURIComponent(pathId)}`);
      break;
    case 'ps4':
    case 'ps5':
      urls.push(`https://rlstats.net/profile/PS4/${encodeURIComponent(pathId)}`);
      break;
    default:
      break;
  }
  return urls;
}

let chromiumBypassAnnounced = false;

function enqueueRlstatsHtmlThroughChromium(url) {
  const task = chromiumRlstatsChain
    .then(() => rlstatsHtmlThroughHiddenWindow(url))
    .catch(() => null);

  chromiumRlstatsChain = task.then(() => {}, () => {});
  return task;
}

async function rlstatsHtmlThroughHiddenWindow(url) {
  if (!app?.isReady?.()) return null;

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      offscreen: true,          // ← rendu offscreen, pas de GPU
      backgroundThrottling: false,
    },
  });

  const close = () => {
    try {
      win.close();
    } catch (_) {}
  };

  let lastLen = 0;
  let lastCfLike = false;
  let lastChartHint = false;

  try {
    await win.loadURL(url).catch(() => null);
    const deadline = Date.now() + 32000;

    while (Date.now() < deadline) {
      await sleep(1000);

      try {
        const html = await win.webContents.executeJavaScript(
          'document.documentElement ? document.documentElement.outerHTML : ""',
          true
        );

        if (!html || html.length < 800) {
          lastLen = html?.length ?? 0;
          lastCfLike = true;
          continue;
        }

        lastLen = html.length;
        lastCfLike = isLikelyCloudflareChallenge(html);
        lastChartHint = /new Date\(\d+\*1000\)/.test(html);

        if (lastCfLike) continue;
        if (!lastChartHint) continue;

        close();
        return html;
      } catch (_) {
        continue;
      }
    }
  } finally {
    close();
  }

  console.log(
    'rlstats Chromium: no chart after ~32s | lastHtmlLen:',
    lastLen,
    '| cf-like:',
    lastCfLike,
    '| chart-snippet:',
    lastChartHint
  );
  return null;
}

function warnCloudflareOnce() {
  if (warnedCloudflare) return;
  warnedCloudflare = true;
  console.log('');
  console.log(
    'rlstats.net uses Cloudflare. RLVision will load profiles via a hidden Chromium window',
    '(may fail if Turnstile still blocks). Each URL is fetched one after another.'
  );
  console.log('');
}

function applyFetchedMMR(isMe, fromMatch, realMMR, sourceLabel, rankImageUrl = null, playlist = null) {
  console.log(`MMR OK (${sourceLabel}):`, realMMR);

  if (isMe) {
    // Met à jour mmrGained seulement si même playlist
    if (fromMatch && S.state.mmr !== 0) {
      S.state.mmrGained += realMMR - S.state.mmr;
    } else if (!fromMatch && S.state.mmr !== 0 && playlist && S.state.lastMmrPlaylist === playlist) {
      // Fetch initial en début de match : même playlist → update session
      const diff = realMMR - S.state.mmr;
      S.state.mmrGained += diff;
      console.log(`MMR session updated (same playlist ${playlist}): ${diff > 0 ? '+' : ''}${diff}`);
    }

    S.state.mmr = realMMR;
    S.state.lastMmrPlaylist = playlist; // ← mémorise la playlist du MMR actuel
    S.state.rankImageUrl = rankImageUrl || null;
    broadcastState();
    sendToMain('mmr-source', 'real');

    const meIdx = S.gamePlayers.findIndex((p) => p.primaryId === S.playerID);
    if (meIdx !== -1) {
      S.gamePlayers[meIdx].mmr = realMMR;
      const win = S.playerOverlayWindows[meIdx];
      if (win && !win.isDestroyed()) {
        win.webContents.send('player-data', {
          name: S.gamePlayers[meIdx].name,
          mmr: realMMR,
          teamNum: S.gamePlayers[meIdx].teamNum,
          teamSlot: S.gamePlayers[meIdx].teamSlot,
        });
      }
    }
  }

  return realMMR;
}

// ─── Fetch MMR ────────────────────────────────────────────────────────────────

async function fetchRealMMR(fromMatch = false, primaryId = S.playerID, playlist = S.currentPlaylist) {
  const isMe = primaryId === S.playerID;
  if (!primaryId || primaryId === '__observer__') return null;

  const playlistResolved = playlist || '2v2';

  try {
    const parts = primaryId.split('|');
    const platform = parts.shift();
    const id = parts.join('|');
    const platformLower = String(platform || '').toLowerCase();

    const pathId = normalizeRlstatsId(platformLower, id);

    if (!platform || id === '') {
      console.log('Invalid PrimaryId:', primaryId);
      failEstimatedMMR(isMe);
      return null;
    }

    if (!pathId) {
      console.log('Empty path id after normalize:', primaryId);
      failEstimatedMMR(isMe);
      return null;
    }

    console.log('Platform:', platform, '| raw:', id);
    console.log('rlstats account id:', pathId);

    const rlPlatforms = ['epic', 'steam', 'xboxone', 'ps4', 'ps5'];
    if (!rlPlatforms.includes(platformLower)) {
      if (platformLower === 'switch') console.log('Switch not supported:', pathId);
      else console.log('Unknown platform:', platform);
      failEstimatedMMR(isMe);
      return null;
    }

    const profileUrls = buildRlstatsProfileUrls(platformLower, pathId);
    if (!profileUrls.length) {
      failEstimatedMMR(isMe);
      return null;
    }

    for (let u = 0; u < profileUrls.length; u++) {
      const url = profileUrls[u];
      if (profileUrls.length > 1)
        console.log(`RLStats URL (${u + 1}/${profileUrls.length}):`, url);
      else console.log('RLStats URL:', url);

      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        },
      });

      let htmlFetched = await response.text();
      let htmlForParse = htmlFetched;

      let { mmr: realMMR, rankImageUrl } = parseRlstatsFromHtml(
        htmlForParse,
        playlistResolved
      );

      if (Number.isFinite(realMMR))
        return applyFetchedMMR(isMe, fromMatch, realMMR, 'rlstats.net', rankImageUrl);

      if (isLikelyCloudflareChallenge(htmlFetched)) {
        warnCloudflareOnce();
        if (!chromiumBypassAnnounced) {
          chromiumBypassAnnounced = true;
          console.log('Hidden Chromium bypass started (~10-32s per profile URL in queue)...');
        }

        const htmlRendered = await enqueueRlstatsHtmlThroughChromium(url);
        if (htmlRendered) {
          htmlForParse = htmlRendered;
          ({ mmr: realMMR, rankImageUrl } = parseRlstatsFromHtml(htmlForParse, playlistResolved));

          if (Number.isFinite(realMMR))
            return applyFetchedMMR(isMe, fromMatch, realMMR, 'rlstats.net', rankImageUrl, playlistResolved);

          console.log(
            'rlstats Chromium: got HTML (~',
            htmlRendered.length,
            'chars) but MMR snippet missing (site layout changed or wrong profile).'
          );
        } else console.log('rlstats Chromium: no usable HTML.');
      } else {
        console.log(
          'RLStats HTTP',
          response.status,
          '| no MMR pattern (not cf-like). Next variant if any.'
        );
      }
    }

    console.log(
      'MMR not available (Cloudflare/rlstats blocking, HTML pattern drift, or no valid profile URLs).'
    );
    failEstimatedMMR(isMe);
    return null;
  } catch (err) {
    console.error('MMR fetch error:', err.message);
    failEstimatedMMR(isMe);
    return null;
  }
}

// ─── Retry Logic ───────────────────────────────────────────────────────────────

async function fetchRealMMRWithRetry(playlist, retries = 3, delay = 20000) {
  const mmrBeforeMatch = S.state.mmr;

  for (let i = 0; i < retries; i++) {
    await new Promise((res) => setTimeout(res, i === 0 ? 10000 : delay));
    await fetchRealMMR(true, S.playerID, playlist); // ← fromMatch = true

    if (S.state.mmr !== mmrBeforeMatch) {
      console.log('MMR delta:', S.state.mmr - mmrBeforeMatch > 0 ? `+${S.state.mmr - mmrBeforeMatch}` : S.state.mmr - mmrBeforeMatch);
      console.log(`MMR updated after ${i + 1} retry(ies)`);
      return;
    }

    console.log(`MMR unchanged, retry (${i + 1}/${retries})...`);
  }

  console.log('MMR did not change after all retries');
}

module.exports = { fetchRealMMR, fetchRealMMRWithRetry };
