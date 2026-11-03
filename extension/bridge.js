// Isolated-world bridge: page.js (MAIN world) can't use chrome.* APIs, so it talks to us via postMessage
// and we forward to the service worker (lyrics lookups + the desktop overlay relay).
let port = null;

function connectPort() {
  try {
    port = chrome.runtime.connect({ name: 'sfl-tab' });
  } catch {
    port = null; // extension was reloaded; this tab needs a refresh
    return;
  }
  port.onMessage.addListener((cmd) => window.postMessage({ __sfl: 'cmd', cmd }, location.origin));
  port.onDisconnect.addListener(() => {
    port = null;
  });
  // Fresh port (first load or service worker restart): resend the full state.
  window.postMessage({ __sfl: 'cmd', cmd: { action: 'resync' } }, location.origin);
}

window.addEventListener('message', (e) => {
  const d = e.data;
  if (e.source !== window || !d) return;

  if (d.__sfl === 'overlay') {
    if (!port) connectPort();
    try {
      port?.postMessage(d.msg);
    } catch {
      port = null;
    }
    return;
  }

  if (d.__sfl !== 'req') return;
  const reply = (result) => window.postMessage({ __sfl: 'res', id: d.id, result }, location.origin);
  try {
    chrome.runtime.sendMessage({ type: 'lyrics', query: d.query }, (res) => {
      if (chrome.runtime.lastError) reply({ error: chrome.runtime.lastError.message });
      else reply(res);
    });
  } catch {
    reply({ error: 'The extension was reloaded, please refresh the Spotify tab.' });
  }
});
