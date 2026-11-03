// Service worker: looks up lyrics on LRCLIB (free, no API key) on behalf of the Spotify tab.
const API = 'https://lrclib.net/api';
const CLIENT = 'SpotifyLyricsOverlay/1.0.0 (https://github.com/firdausmego/spotify-lyrics-overlay)';
const MAX_DURATION_DIFF = 10; // seconds
const cache = new Map();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'lyrics') return;
  findLyrics(msg.query).then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
  return true;
});

// ---------------------------------------------------------------------------
// Desktop overlay relay: Spotify tab <-> port <-> here <-> WebSocket <-> lyrics-overlay app
// ---------------------------------------------------------------------------
const OVERLAY_URL = 'ws://127.0.0.1:47823';
const ports = new Set();
let activePort = null;
let ws = null;
let retryTimer = null;
let retryDelay = 2000;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sfl-tab') return;
  ports.add(port);
  activePort = port;
  port.onMessage.addListener((msg) => {
    activePort = port;
    sendOverlay(msg);
    ensureSocket();
  });
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    if (activePort !== port) return;
    activePort = [...ports].pop() || null;
    if (activePort) {
      activePort.postMessage({ action: 'resync' });
    } else {
      sendOverlay({ type: 'track', key: '', track: null });
      sendOverlay({ type: 'lyrics', key: '', lyrics: { status: 'idle' } });
    }
  });
});

function sendOverlay(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function ensureSocket() {
  if (ws || retryTimer || !ports.size) return;
  const sock = new WebSocket(OVERLAY_URL);
  ws = sock;
  sock.onopen = () => {
    retryDelay = 2000;
    activePort?.postMessage({ action: 'resync' });
  };
  sock.onmessage = (e) => {
    let cmd;
    try {
      cmd = JSON.parse(e.data);
    } catch {
      return;
    }
    if (cmd?.type === 'command') activePort?.postMessage(cmd);
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    if (!ports.size) return;
    // Overlay app not running: back off so we don't hammer localhost.
    retryTimer = setTimeout(() => {
      retryTimer = null;
      ensureSocket();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 10000);
  };
}

async function api(path, params, retries = 1) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: { 'Lrclib-Client': CLIENT } });
  if (res.status === 404) return null;
  if (res.status >= 500 && retries > 0) {
    await new Promise((r) => setTimeout(r, 800));
    return api(path, params, retries - 1);
  }
  if (!res.ok) throw new Error(`LRCLIB ${res.status}`);
  return res.json();
}

async function findLyrics(q) {
  const query = {
    title: String(q?.title || ''),
    artist: String(q?.artist || ''),
    album: String(q?.album || ''),
    duration: Number(q?.duration) || 0,
  };
  if (!query.title) return { found: false };
  const key = JSON.stringify([query.title, query.artist, Math.round(query.duration)]);
  if (cache.has(key)) return cache.get(key);
  const result = await lookup(query);
  cache.set(key, result);
  return result;
}

async function lookup({ title, artist, album, duration }) {
  const dur = duration > 0 ? Math.round(duration) : undefined;

  // 1. Exact match (LRCLIB needs the duration for this endpoint).
  if (dur) {
    const exact = await api('/get', { track_name: title, artist_name: artist, album_name: album, duration: dur }).catch(() => null);
    if (hasLyrics(exact)) return pack(exact);
  }

  // 2. Fuzzy search with a cleaned-up title and the main artist only.
  const t = cleanTitle(title);
  const a = mainArtist(artist);
  let list = (await api('/search', { track_name: t, artist_name: a })) || [];
  // The free-text search tends to answer 503 instead of an empty list when nothing matches.
  if (!list.length) list = (await api('/search', { q: `${t} ${a}` }, 0).catch(() => null)) || [];
  const best = pickBest(list, dur);
  return best ? pack(best) : { found: false };
}

function hasLyrics(r) {
  return !!(r && (r.syncedLyrics || r.plainLyrics || r.instrumental));
}

function pack(r) {
  return {
    found: true,
    id: r.id,
    synced: r.syncedLyrics || null,
    plain: r.plainLyrics || null,
    instrumental: !!r.instrumental && !r.syncedLyrics && !r.plainLyrics,
  };
}

function pickBest(list, dur) {
  const scored = [];
  for (const c of list) {
    if (!hasLyrics(c)) continue;
    const diff = dur && c.duration ? Math.abs(c.duration - dur) : 0;
    if (dur && diff > MAX_DURATION_DIFF) continue;
    scored.push({ c, score: diff + (c.syncedLyrics ? 0 : 5) });
  }
  scored.sort((x, y) => x.score - y.score);
  return scored[0]?.c || null;
}

function cleanTitle(s) {
  const cleaned = s
    .replace(/\s+-\s+.*\b(remaster(ed)?|version|live|edit|mix|mono|stereo|demo|acoustic|from|feat\.?|with)\b.*$/i, '')
    .replace(/\s*[([](feat\.?|ft\.?|with|remaster(ed)?|[^)\]]*version|[^)\]]*edit|[^)\]]*mix)[^)\]]*[)\]]/gi, '')
    .trim();
  return cleaned || s;
}

function mainArtist(s) {
  return (s || '').split(/\s*(?:,|&|;|\bfeat\.?|\bft\.?|\bx\b)\s*/i)[0].trim();
}
