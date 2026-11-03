// Runs in the MAIN world of open.spotify.com: reads the now-playing track + playback position
// and renders synced lyrics into a Document Picture-in-Picture window (always on top of the desktop).
(() => {
  if (window.__sflLoaded) return;
  window.__sflLoaded = true;

  const SETTINGS_KEY = 'sfl:settings';
  const OFFSETS_KEY = 'sfl:offsets';
  const settings = Object.assign({ fontSize: 22, width: 380, height: 520 }, readJson(SETTINGS_KEY));
  const offsets = readJson(OFFSETS_KEY) || {};

  function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key)) || null; } catch { return null; }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  // ---------------------------------------------------------------------------
  // Playback clock: synced from mediaSession.setPositionState, the <video>/<audio>
  // element Spotify plays through, or the progress-bar text as a last resort.
  // ---------------------------------------------------------------------------
  const now = () => performance.now();
  const clock = { pos: 0, at: now(), playing: false };
  const clockTime = () => (clock.playing ? clock.pos + (now() - clock.at) / 1000 : clock.pos);
  function clockSync(pos) {
    clock.pos = pos;
    clock.at = now();
  }
  function clockSetPlaying(playing) {
    if (playing === clock.playing) return;
    clock.pos = clockTime();
    clock.at = now();
    clock.playing = playing;
  }

  const ms = navigator.mediaSession;
  let hookDuration = 0;
  let lastHookAt = -1e9;
  if (ms && typeof ms.setPositionState === 'function') {
    const orig = ms.setPositionState;
    ms.setPositionState = function (state) {
      try {
        if (state && Number.isFinite(state.position)) {
          hookDuration = state.duration || 0;
          clockSync(state.position);
          if (state.playbackRate === 0) clockSetPlaying(false);
          lastHookAt = now();
        }
      } catch {}
      return orig.apply(this, arguments);
    };
  }

  const mediaEls = new Set();
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    mediaEls.add(this);
    if (mediaEls.size > 8) mediaEls.delete(mediaEls.values().next().value);
    return origPlay.apply(this, arguments);
  };

  function pickMedia(expectedDuration) {
    document.querySelectorAll('video, audio').forEach((el) => mediaEls.add(el));
    let best = null;
    for (const el of mediaEls) {
      const d = el.duration;
      if (!Number.isFinite(d) || d <= 0) continue;
      if (expectedDuration && Math.abs(d - expectedDuration) > 3) continue;
      if (!best || (best.paused && !el.paused)) best = el;
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Now-playing track
  // ---------------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const textOf = (sel) => ($(sel)?.textContent || '').trim();

  function parseClock(s) {
    if (!s) return NaN;
    const parts = s.split(':').map(Number);
    if (parts.some(Number.isNaN)) return NaN;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }

  function readTrack() {
    const md = ms?.metadata;
    if (md?.title) {
      const artwork = [...(md.artwork || [])].sort((a, b) => (parseInt(b.sizes) || 0) - (parseInt(a.sizes) || 0));
      return { title: md.title, artist: md.artist || '', album: md.album || '', art: artwork[0]?.src || '' };
    }
    const title = textOf('[data-testid="context-item-info-title"]');
    if (!title) return null;
    const artists = [...document.querySelectorAll('[data-testid="context-item-info-artist"]')].map((a) => a.textContent.trim());
    return {
      title,
      artist: artists.join(', ') || textOf('[data-testid="context-item-info-subtitles"]'),
      album: '',
      art: $('[data-testid="now-playing-widget"] img')?.src || '',
    };
  }

  let track = null;
  let trackKey = '';
  let trackDuration = 0;
  let lyrics = { status: 'idle' };
  let prevDomPos = NaN;
  let autoPipRegistered = false;

  function tick() {
    mountButton();
    if (!autoPipRegistered) autoPipRegistered = registerAutoPip();

    const t = readTrack();
    const key = t ? `${t.artist} — ${t.title}` : '';

    const domPos = parseClock(textOf('[data-testid="playback-position"]'));
    const durText = textOf('[data-testid="playback-duration"]');
    let domDur = parseClock(durText.replace(/^[-−]/, ''));
    if (/^[-−]/.test(durText) && Number.isFinite(domPos)) domDur += domPos; // "remaining time" mode
    trackDuration = hookDuration || (Number.isFinite(domDur) ? domDur : 0);

    if (key !== trackKey) {
      trackKey = key;
      track = t;
      if (now() - lastHookAt > 1500) clockSync(0);
      overlayTrack();
      loadLyrics();
      ui?.setTrack();
    } else if (t && track && t.art !== track.art) {
      track = t;
      overlayTrack();
      ui?.setTrack();
    }

    const media = pickMedia(trackDuration);
    let playing;
    if (media) playing = !media.paused;
    else if (ms?.playbackState === 'playing') playing = true;
    else if (ms?.playbackState === 'paused') playing = false;
    else playing = Number.isFinite(domPos) && domPos !== prevDomPos ? true : clock.playing;
    clockSetPlaying(playing);

    if (media) {
      clockSync(media.currentTime);
    } else if (!document.hidden && Number.isFinite(domPos) && domPos !== prevDomPos && Math.abs(domPos - clockTime()) > 1.5) {
      clockSync(domPos);
    }
    prevDomPos = domPos;
    overlayClock(false);
  }

  // ---------------------------------------------------------------------------
  // Desktop overlay app: page -> bridge.js -> service worker -> ws://127.0.0.1
  // ---------------------------------------------------------------------------
  const lastClockSent = { pos: 0, at: 0, playing: false };

  function sendOverlay(msg) {
    window.postMessage({ __sfl: 'overlay', msg }, location.origin);
  }
  function overlayTrack() {
    sendOverlay({ type: 'track', key: trackKey, track });
  }
  function overlayLyrics() {
    sendOverlay({ type: 'lyrics', key: trackKey, lyrics });
  }
  function overlayClock(force) {
    const pos = clockTime();
    const elapsed = (now() - lastClockSent.at) / 1000;
    const predicted = lastClockSent.playing ? lastClockSent.pos + elapsed : lastClockSent.pos;
    // Only send when the overlay's own extrapolation would drift; the 2s heartbeat also keeps the service worker alive.
    if (!force && clock.playing === lastClockSent.playing && Math.abs(pos - predicted) < 0.3 && elapsed < 2) return;
    Object.assign(lastClockSent, { pos, at: now(), playing: clock.playing });
    sendOverlay({ type: 'clock', key: trackKey, pos, playing: clock.playing, offset: offsets[trackKey] || 0 });
  }
  function overlaySync() {
    overlayTrack();
    overlayLyrics();
    overlayClock(true);
  }

  function handleCommand(cmd) {
    switch (cmd?.action) {
      case 'resync': return overlaySync();
      case 'prev': return clickSpotify('control-button-skip-back');
      case 'playpause': return clickSpotify('control-button-playpause');
      case 'next': return clickSpotify('control-button-skip-forward');
      case 'offset': return shiftOffset(Number(cmd.delta) || 0);
    }
  }

  function shiftOffset(delta) {
    if (!trackKey || !delta) return;
    const value = Math.round(((offsets[trackKey] || 0) + delta) * 10) / 10;
    if (value) offsets[trackKey] = value;
    else delete offsets[trackKey];
    writeJson(OFFSETS_KEY, offsets);
    ui?.refreshOffset();
    overlayClock(true);
  }

  // ---------------------------------------------------------------------------
  // Lyrics
  // ---------------------------------------------------------------------------
  const lyricCache = new Map();
  const pending = new Map();
  let reqSeq = 0;

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d) return;
    if (d.__sfl === 'cmd') return handleCommand(d.cmd);
    if (d.__sfl !== 'res') return;
    pending.get(d.id)?.(d.result);
    pending.delete(d.id);
  });

  function requestLyrics(query) {
    return new Promise((resolve) => {
      const id = ++reqSeq;
      pending.set(id, resolve);
      window.postMessage({ __sfl: 'req', id, query }, location.origin);
      setTimeout(() => {
        if (pending.delete(id)) resolve({ error: 'Timed out while contacting LRCLIB.' });
      }, 20000);
    });
  }

  function loadLyrics() {
    const key = trackKey;
    const t = track;
    if (!t) return setLyrics({ status: 'idle' });
    if (lyricCache.has(key)) return setLyrics(lyricCache.get(key));
    setLyrics({ status: 'loading' });
    // Give Spotify a moment to publish the new track's duration before looking it up.
    setTimeout(async () => {
      if (key !== trackKey) return;
      const res = await requestLyrics({ title: t.title, artist: t.artist, album: t.album, duration: trackDuration });
      const result = toLyrics(res);
      if (result.status !== 'error') lyricCache.set(key, result);
      if (key === trackKey) setLyrics(result);
    }, 700);
  }

  function setLyrics(next) {
    lyrics = next;
    ui?.renderLyrics();
    overlayLyrics();
  }

  function toLyrics(res) {
    if (!res || res.error) return { status: 'error', message: res?.error || '' };
    if (!res.found) return { status: 'none' };
    if (res.synced) {
      const lines = parseLrc(res.synced);
      if (lines.length) return { status: 'synced', lines };
    }
    if (res.plain) return { status: 'plain', text: res.plain };
    if (res.instrumental) return { status: 'instrumental' };
    return { status: 'none' };
  }

  function parseLrc(lrc) {
    const lines = [];
    let offset = 0;
    for (const raw of lrc.split(/\r?\n/)) {
      const off = raw.match(/^\[offset:\s*([+-]?\d+)\s*\]/i);
      if (off) {
        offset = Number(off[1]) / 1000;
        continue;
      }
      const stamp = /^\[(\d+):(\d+(?:[.:]\d+)?)\]/;
      const times = [];
      let rest = raw.trim();
      let m;
      while ((m = rest.match(stamp))) {
        times.push(Number(m[1]) * 60 + parseFloat(m[2].replace(':', '.')));
        rest = rest.slice(m[0].length);
      }
      const text = rest.trim();
      for (const time of times) lines.push({ t: Math.max(0, time - offset), text });
    }
    return lines.sort((a, b) => a.t - b.t);
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

  // ---------------------------------------------------------------------------
  // Floating window (Document Picture-in-Picture)
  // ---------------------------------------------------------------------------
  let pip = null;
  let ui = null;

  async function openPip(toggle) {
    if (pip) {
      if (toggle) pip.close();
      else pip.focus();
      return;
    }
    if (!window.documentPictureInPicture) {
      alert('This browser does not support Document Picture-in-Picture. Use Chrome or Edge 116 or newer.');
      return;
    }
    try {
      pip = await documentPictureInPicture.requestWindow({ width: settings.width, height: settings.height });
    } catch (err) {
      console.warn('[Spotify Lyrics Overlay] could not open the window:', err);
      pip = null;
      return;
    }
    const win = pip;
    ui = createUi(win);
    win.addEventListener('pagehide', () => {
      settings.width = win.innerWidth || settings.width;
      settings.height = win.innerHeight || settings.height;
      writeJson(SETTINGS_KEY, settings);
      if (pip === win) {
        pip = null;
        ui = null;
      }
      updateButton();
    });
    updateButton();
  }

  function registerAutoPip() {
    // Lets Chrome open the lyrics window by itself when you switch away from the Spotify tab
    // (only where Chrome supports automatic picture-in-picture for media sites).
    try {
      ms?.setActionHandler('enterpictureinpicture', () => openPip(false));
      return true;
    } catch {
      return false;
    }
  }

  function clickSpotify(testId) {
    $(`[data-testid="${testId}"]`)?.click();
    setTimeout(tick, 150);
  }

  const CSS = `
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; overflow: hidden; background: #0d0d0f; color: #fff;
      font-family: "Segoe UI", system-ui, -apple-system, sans-serif; }
    .app { --fs: 22px; position: relative; height: 100%; display: flex; flex-direction: column;
      background: radial-gradient(120% 70% at 50% 0%, #1c3a28 0%, #0d0d0f 65%); }
    .head { display: flex; gap: 10px; align-items: center; padding: 10px 12px;
      border-bottom: 1px solid rgba(255,255,255,.06); }
    .art { width: 40px; height: 40px; border-radius: 6px; object-fit: cover; flex: none; background: #222; }
    .art[hidden] { display: none; }
    .meta { min-width: 0; }
    .title, .artist { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .title { font-weight: 700; font-size: 14px; }
    .artist { font-size: 12px; color: #b3b3b3; margin-top: 2px; }
    .lyrics { position: relative; flex: 1; overflow-y: auto; padding: 0 18px; scrollbar-width: none;
      -webkit-mask-image: linear-gradient(transparent, #000 14%, #000 86%, transparent);
      mask-image: linear-gradient(transparent, #000 14%, #000 86%, transparent); }
    .lyrics::-webkit-scrollbar { display: none; }
    .pad { height: 42vh; }
    .line { margin: 0; padding: .3em 0; font-size: var(--fs); font-weight: 700; line-height: 1.3;
      color: rgba(255,255,255,.32); transform-origin: left center;
      transition: color .3s, transform .3s, text-shadow .3s; }
    .line.past { color: rgba(255,255,255,.55); }
    .line.active { color: #fff; transform: scale(1.04); text-shadow: 0 0 18px rgba(30,215,96,.45); }
    .line.plain { color: rgba(255,255,255,.88); font-size: calc(var(--fs) * .8); font-weight: 600; }
    .status { height: 100%; display: grid; place-items: center; text-align: center; padding: 20px;
      color: #b3b3b3; font-size: 15px; }
    .note { margin: 14px 0 6px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: #1ed760; }
    .bar { position: absolute; left: 0; right: 0; bottom: 0; display: flex; align-items: center;
      justify-content: center; gap: 2px; padding: 6px 8px; background: rgba(10,10,12,.85);
      backdrop-filter: blur(8px); opacity: 0; transition: opacity .2s; }
    .app:hover .bar { opacity: 1; }
    .btn { background: transparent; color: #fff; border: 0; border-radius: 6px; padding: 6px 7px;
      font: 600 12px/1 inherit; cursor: pointer; }
    .btn:hover { background: rgba(255,255,255,.12); }
    .sep { width: 1px; height: 16px; margin: 0 4px; background: rgba(255,255,255,.15); }
    .off { min-width: 38px; text-align: center; font-size: 11px; color: #b3b3b3; font-variant-numeric: tabular-nums; }
  `;

  function createUi(win) {
    const doc = win.document;
    try {
      const sheet = new win.CSSStyleSheet();
      sheet.replaceSync(CSS);
      doc.adoptedStyleSheets = [sheet];
    } catch {
      const style = doc.createElement('style');
      style.textContent = CSS;
      doc.head.append(style);
    }

    // Spotify enforces Trusted Types, so everything is built with createElement/textContent.
    const el = (tag, cls, text) => {
      const node = doc.createElement(tag);
      if (cls) node.className = cls;
      if (text != null) node.textContent = text;
      return node;
    };

    const root = el('div', 'app');
    root.style.setProperty('--fs', `${settings.fontSize}px`);
    const head = el('header', 'head');
    const art = el('img', 'art');
    art.alt = '';
    const meta = el('div', 'meta');
    const title = el('div', 'title');
    const artist = el('div', 'artist');
    meta.append(title, artist);
    head.append(art, meta);
    const list = el('main', 'lyrics');
    const bar = el('footer', 'bar');

    const button = (label, tip, onClick) => {
      const b = el('button', 'btn', label);
      b.title = tip;
      b.addEventListener('click', onClick);
      bar.append(b);
    };
    button('⏮', 'Previous track', () => clickSpotify('control-button-skip-back'));
    button('⏯', 'Play / Pause', () => clickSpotify('control-button-playpause'));
    button('⏭', 'Next track', () => clickSpotify('control-button-skip-forward'));
    bar.append(el('span', 'sep'));
    button('A−', 'Smaller text', () => setFont(-2));
    button('A+', 'Larger text', () => setFont(2));
    bar.append(el('span', 'sep'));
    button('−½s', 'Lyrics are early (delay them)', () => shiftOffset(-0.5));
    const offLabel = el('span', 'off');
    offLabel.title = 'Lyrics offset for this track';
    bar.append(offLabel);
    button('+½s', 'Lyrics are late (advance them)', () => shiftOffset(0.5));

    root.append(head, list, bar);
    doc.body.append(root);

    let lineEls = [];
    let current = -2;
    let holdScrollUntil = 0;
    const holdScroll = () => { holdScrollUntil = now() + 3000; };
    list.addEventListener('wheel', holdScroll, { passive: true });
    list.addEventListener('touchmove', holdScroll, { passive: true });
    win.addEventListener('resize', () => scrollToCurrent(false));

    function setFont(delta) {
      settings.fontSize = Math.min(48, Math.max(12, settings.fontSize + delta));
      root.style.setProperty('--fs', `${settings.fontSize}px`);
      writeJson(SETTINGS_KEY, settings);
      scrollToCurrent(false);
    }

    function refreshOffset() {
      updateOffset();
      current = -2;
    }

    function updateOffset() {
      const v = offsets[trackKey] || 0;
      offLabel.textContent = `${v > 0 ? '+' : ''}${v.toFixed(1)}s`;
    }

    function scrollToCurrent(smooth) {
      const target = lineEls[current] || lineEls[0];
      if (!target) return;
      list.scrollTo({
        top: target.offsetTop - list.clientHeight / 2 + target.offsetHeight / 2,
        behavior: smooth ? 'smooth' : 'auto',
      });
    }

    function showStatus(message) {
      lineEls = [];
      current = -2;
      list.replaceChildren(el('div', 'status', message));
    }

    function setTrack() {
      title.textContent = track?.title || 'Spotify Lyrics Overlay';
      artist.textContent = track?.artist || 'Play something on Spotify';
      art.hidden = !track?.art;
      if (track?.art) art.src = track.art;
      doc.title = track ? `${track.title} — ${track.artist}` : 'Lyrics';
      updateOffset();
    }

    function renderLyrics() {
      switch (lyrics.status) {
        case 'idle':
          return showStatus('Play something on Spotify to start.');
        case 'loading':
          return showStatus('Looking for lyrics…');
        case 'none':
          return showStatus('No lyrics found for this track.');
        case 'instrumental':
          return showStatus('♪ Instrumental ♪');
        case 'error':
          return showStatus(`Could not load lyrics. ${lyrics.message || ''}`);
        case 'plain':
          lineEls = [];
          current = -2;
          list.replaceChildren(
            el('div', 'note', 'Unsynced lyrics'),
            ...lyrics.text.split(/\r?\n/).map((l) => el('p', 'line plain', l || ' ')),
            el('div', 'pad'),
          );
          list.scrollTop = 0;
          return;
        case 'synced':
          lineEls = lyrics.lines.map((l) => el('p', 'line', l.text || '♪'));
          current = -2;
          list.replaceChildren(el('div', 'pad'), ...lineEls, el('div', 'pad'));
          list.scrollTop = 0;
          return;
      }
    }

    function frame() {
      if (win.closed) return;
      if (lyrics.status === 'synced' && lineEls.length) {
        const idx = findLine(lyrics.lines, clockTime() + (offsets[trackKey] || 0));
        if (idx !== current) {
          lineEls.forEach((p, i) => {
            p.classList.toggle('past', i < idx);
            p.classList.toggle('active', i === idx);
          });
          const jumped = Math.abs(idx - current) > 1;
          current = idx;
          if (now() > holdScrollUntil) scrollToCurrent(!jumped);
        }
      }
      win.requestAnimationFrame(frame);
    }

    setTrack();
    renderLyrics();
    win.requestAnimationFrame(frame);
    return { setTrack, renderLyrics, refreshOffset };
  }

  // ---------------------------------------------------------------------------
  // Launcher button inside the Spotify page + Alt+L shortcut
  // ---------------------------------------------------------------------------
  let fab = null;

  function mountButton() {
    if (fab?.isConnected || !document.body) return;
    fab = document.createElement('button');
    fab.type = 'button';
    fab.title = 'Floating lyrics window (Alt+L)';
    fab.textContent = '♪';
    Object.assign(fab.style, {
      position: 'fixed', right: '18px', bottom: '104px', zIndex: '2147483647',
      width: '44px', height: '44px', borderRadius: '50%', border: '0',
      color: '#000', fontSize: '20px', fontWeight: '700', cursor: 'pointer',
      boxShadow: '0 4px 14px rgba(0,0,0,.45)', opacity: '.9',
    });
    fab.addEventListener('click', () => openPip(true));
    document.body.append(fab);
    updateButton();
  }

  function updateButton() {
    if (fab) fab.style.background = pip ? '#ffffff' : '#1ed760';
  }

  window.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyL') {
      e.preventDefault();
      openPip(true);
    }
  }, true);

  setInterval(tick, 250);
})();
