// QR pairing webview. The extension sends {type:'qr', svg, expiresAt} and {type:'update', update}.
(function () {
  const vscode = acquireVsCodeApi();
  const { icon, h } = window.AC;
  const app = document.getElementById('app');
  const send = (type) => () => vscode.postMessage({ type });

  let svgMarkup = '';
  let expiresAt = 0;
  let update = { state: 'waiting-for-scan', message: 'Preparing QR code…' };
  let tick;

  const FINAL = ['connected', 'paired', 'failed', 'timeout', 'cancelled'];
  const BUSY = ['waiting-for-scan', 'pairing', 'connecting'];

  function qrNode() {
    // svgMarkup is produced by the extension's QR encoder (trusted, contains only <svg>/<path>).
    const box = h('div', { class: 'qrbox' + (update.state === 'waiting-for-scan' ? '' : ' dim'), role: 'img', 'aria-label': 'Wireless debugging pairing QR code' });
    const doc = new DOMParser().parseFromString(svgMarkup, 'image/svg+xml');
    const svg = doc.documentElement;
    if (svg && svg.nodeName === 'svg') box.appendChild(document.importNode(svg, true));
    return box;
  }

  function remaining() {
    const s = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function render() {
    app.replaceChildren();
    const st = update.state;
    app.append(h('h1', {}, 'Pair via QR Code'));

    if (st === 'connected') {
      app.append(h('div', { class: 'card result', role: 'status' },
        icon('check', 'big'),
        h('div', { class: 'state ok' }, 'Connected!'),
        h('div', { class: 'name' }, (update.device && update.device.model) || 'Android device'),
        h('div', { class: 'muted mono' }, update.endpoint || ''),
      ));
      app.append(h('div', { class: 'buttons' },
        h('button', { class: 'primary', onclick: send('close') }, 'Done'),
        h('button', { onclick: send('retry') }, 'Pair another device')));
      return;
    }

    if (svgMarkup) app.append(qrNode());
    app.append(h('p', { class: 'steps' },
      'On your Android device open ',
      h('strong', {}, 'Settings › Developer options › Wireless debugging'),
      ' and tap ', h('strong', {}, 'Pair device with QR code'), '.'));

    const cls = st === 'failed' || st === 'timeout' ? 'state err' : st === 'paired' ? 'state' : 'state';
    const stateLine = h('div', { class: cls, role: 'status' },
      BUSY.includes(st) ? h('span', { class: 'spinner' }) : null,
      update.message,
      st === 'waiting-for-scan' && expiresAt ? h('span', { class: 'muted', id: 'countdown' }, ` · ${remaining()}`) : null);
    app.append(stateLine);

    const buttons = h('div', { class: 'buttons' });
    if (FINAL.includes(st)) {
      buttons.append(h('button', { class: 'primary', onclick: send('retry') }, icon('sync'), 'Retry'));
    } else {
      buttons.append(h('button', { onclick: send('cancel') }, 'Cancel'));
    }
    buttons.append(h('button', { class: 'link', onclick: send('useCode') }, 'Use six-digit pairing code instead'));
    app.append(buttons);

    app.append(h('details', {},
      h('summary', {}, 'Having trouble?'),
      h('ul', {},
        h('li', {}, 'Requires Android 11 or newer and Android SDK Platform-Tools 31+.'),
        h('li', {}, 'Phone and computer must be on the same Wi-Fi network; guest networks and “AP/client isolation” block discovery.'),
        h('li', {}, 'Turn off mobile data on the phone if it keeps switching networks.'),
        h('li', {}, 'VPNs or firewalls that block mDNS (UDP 5353) prevent the phone from being found — use the pairing code instead.'),
        h('li', {}, 'The code expires after 2 minutes; press Retry for a new one.'),
      )));
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type === 'qr') {
      svgMarkup = m.svg;
      expiresAt = m.expiresAt;
      update = { state: 'waiting-for-scan', message: 'Waiting for scan…' };
      render();
    } else if (m.type === 'update') {
      update = m.update;
      render();
    }
  });

  clearInterval(tick);
  tick = setInterval(() => {
    const el = document.getElementById('countdown');
    if (el) el.textContent = ` · ${remaining()}`;
  }, 1000);

  render();
  vscode.postMessage({ type: 'ready' });
})();
