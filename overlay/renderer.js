const $ = (id) => document.getElementById(id);
const panel = $('panel');
const currentEl = $('current');
const nextEl = $('next');

let connected = false;
let trackKey = '';
let lyrics = { status: 'idle' };
let clock = { pos: 0, at: performance.now(), playing: false, offset: 0 };
let currentIdx = -2;
let fontSize = 34;
let statusTimer = null;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function setText(el, text, cls) {
  const className = `${el.id === 'current' ? 'current' : 'next'}${cls ? ` ${cls}` : ''}`;
  if (el.textContent === text && el.className.replace(' swap', '') === className) return;
  el.textContent = text;
  el.className = className;
  if (text) {
    void el.offsetWidth; // restart the entry animation
    el.classList.add('swap');
  }
}

function setLines(current, next) {
  clearTimeout(statusTimer);
  setText(currentEl, current);
  setText(nextEl, next);
  reportHitRect();
}

// Short notices fade out after a few seconds so nothing lingers on the desktop (hover brings them back).
function setStatus(text, transient = true) {
  clearTimeout(statusTimer);
  currentIdx = -2;
  setText(currentEl, text, 'status');
  setText(nextEl, '');
  if (transient) statusTimer = setTimeout(() => currentEl.classList.add('faded'), 6000);
  reportHitRect();
}

function renderStatus() {
  if (!connected) return setStatus('Waiting for Spotify in Chrome…');
  if (!trackKey) return setStatus('Play something on Spotify');
  switch (lyrics.status) {
    case 'loading': return setStatus('Looking for lyrics…', false);
    case 'none': return setStatus('No lyrics found');
    case 'plain': return setStatus('Lyrics for this track are not synced');
    case 'instrumental': return setStatus('♪ Instrumental ♪');
    case 'error': return setStatus('Could not load lyrics');
    case 'synced': currentIdx = -2; return;
    default: return setStatus('Play something on Spotify');
  }
}

function findLine(lines, t) {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function frame() {
  if (connected && lyrics.status === 'synced' && lyrics.lines?.length) {
    const elapsed = clock.playing ? (performance.now() - clock.at) / 1000 : 0;
    const idx = findLine(lyrics.lines, clock.pos + elapsed + clock.offset);
    if (idx !== currentIdx) {
      currentIdx = idx;
      const line = lyrics.lines[idx];
      const next = lyrics.lines[idx + 1];
      setLines(line ? line.text || '♪' : '', next ? next.text || '♪' : '');
    }
  }
  requestAnimationFrame(frame);
}

let lastRect = '';
function reportHitRect() {
  const r = panel.getBoundingClientRect();
  const rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  const key = JSON.stringify(rect);
  if (key === lastRect) return;
  lastRect = key;
  window.overlay.setHitRect(rect);
}
new ResizeObserver(reportHitRect).observe(panel);

// ---------------------------------------------------------------------------
// Messages from the extension (via main process)
// ---------------------------------------------------------------------------
window.overlay.on('status', (s) => {
  connected = s.connected;
  if (!connected) {
    trackKey = '';
    lyrics = { status: 'idle' };
    setTrackInfo(null);
  }
  renderStatus();
});

window.overlay.on('sfl', (msg) => {
  switch (msg.type) {
    case 'track':
      if (msg.key !== trackKey) {
        trackKey = msg.key || '';
        lyrics = { status: trackKey ? 'loading' : 'idle' };
        clock = { pos: 0, at: performance.now(), playing: clock.playing, offset: 0 };
        renderStatus();
      }
      setTrackInfo(msg.track);
      break;
    case 'lyrics':
      if (msg.key !== trackKey) return;
      lyrics = msg.lyrics || { status: 'idle' };
      renderStatus();
      break;
    case 'clock':
      if (msg.key !== trackKey) return;
      clock = { pos: msg.pos, at: performance.now(), playing: msg.playing, offset: msg.offset || 0 };
      $('offset').textContent = `${clock.offset > 0 ? '+' : ''}${clock.offset.toFixed(1)}s`;
      break;
  }
});

function setTrackInfo(track) {
  $('title').textContent = track?.title || 'Spotify Lyrics Overlay';
  $('artist').textContent = track?.artist || '';
}

window.overlay.on('hover', (hover) => {
  document.body.classList.toggle('hover', hover);
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function applyFont(size) {
  fontSize = Math.min(72, Math.max(16, size));
  document.body.style.setProperty('--fs', `${fontSize}px`);
}

document.querySelector('.bar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.cmd) window.overlay.command({ action: b.dataset.cmd });
  if (b.dataset.offset) window.overlay.command({ action: 'offset', delta: Number(b.dataset.offset) });
  if (b.dataset.font) {
    applyFont(fontSize + Number(b.dataset.font));
    window.overlay.setFont(fontSize);
  }
});

window.overlay.getConfig().then((cfg) => applyFont(cfg.fontSize));
setTrackInfo(null);
renderStatus();
requestAnimationFrame(frame);
