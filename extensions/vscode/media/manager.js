// Device Manager webview. Receives {type:'state'} messages and renders with DOM APIs.
(function () {
  const vscode = acquireVsCodeApi();
  const { icon, h } = window.AC;
  const app = document.getElementById('app');

  const send = (msg) => vscode.postMessage(msg);
  const action = (a) => () => send({ type: 'action', action: a });
  const op = (o, id) => () => send({ type: 'device', op: o, id });

  const STATUS = {
    connected: ['Connected', 'ok'],
    connecting: ['Connecting', 'warn'],
    unauthorized: ['Unauthorized — allow on phone', 'warn'],
    offline: ['Offline', 'err'],
    available: ['Available', ''],
    disconnected: ['Disconnected', ''],
    other: ['', ''],
  };
  const ACTIVITY = { searching: 'Searching…', reconnecting: 'Reconnecting…', pairing: 'Pairing…', starting: 'Starting…' };

  function tile(label, ic, a, primary) {
    return h('button', { class: primary ? 'primary' : '', onclick: action(a), title: label }, icon(ic), h('span', {}, label));
  }

  function deviceCard(e) {
    const [statusLabel, statusCls] = STATUS[e.status] || ['', ''];
    const transport = e.transport === 'wifi' ? 'Wi-Fi' : 'USB';
    const where = e.endpoint || e.serial || '';
    const badges = h('div', { class: 'badges' },
      h('span', { class: 'pill ' + statusCls }, statusLabel || e.adbState || e.status),
      e.paired ? h('span', { class: 'pill plain' }, 'Paired') : null,
      h('span', { class: 'pill plain' }, transport),
    );

    const actions = h('div', { class: 'actions' });
    const btn = (label, ic, o, primary) => h('button', { class: primary ? 'primary' : 'icon', onclick: op(o, e.id), title: label, 'aria-label': `${label} ${e.name}` }, icon(ic), primary ? label : null);
    if (e.status === 'connected' && e.transport === 'wifi') actions.append(btn('Disconnect', 'unplug', 'disconnect'));
    if ((e.status === 'available' || e.status === 'disconnected' || e.status === 'offline') && e.transport === 'wifi') {
      actions.append(btn(e.known ? 'Reconnect' : 'Connect', 'sync', e.known ? 'reconnect' : 'connect', true));
    }
    if (e.status === 'connected') actions.append(btn(e.preferred ? 'Unset preferred' : 'Set as preferred', 'star', 'prefer'));
    if (e.serial || e.endpoint) {
      actions.append(btn('Copy serial', 'copy', 'copySerial'));
      actions.append(btn('Copy adb command', 'terminal', 'copyCommands'));
    }
    if (e.known) {
      const auto = e.autoReconnect !== false;
      actions.append(h('button', {
        class: 'icon', onclick: op('toggleAuto', e.id), role: 'switch', 'aria-checked': String(auto),
        title: auto ? 'Auto-reconnect on (click to turn off)' : 'Auto-reconnect off (click to turn on)',
      }, icon('sync'), h('span', { class: 'muted' }, auto ? 'Auto' : 'Manual')));
      actions.append(btn('Forget device', 'trash', 'forget'));
    }

    const metaParts = [where, transport];
    if (e.serial && e.serial !== where) metaParts.push(e.serial);
    if (e.userDisconnected) metaParts.push('disconnected by you');
    return h('article', { class: `card device ${e.status}${e.preferred ? ' preferred' : ''}`, 'aria-label': `${e.name}, ${statusLabel}` },
      icon('phone', 'dicon'),
      h('div', { class: 'info' },
        h('div', { class: 'name' }, e.name, e.preferred ? icon('star', 'star') : null),
        h('div', { class: 'meta mono' }, metaParts.join(' · ')),
        e.advertisedName ? h('div', { class: 'meta' }, 'Discovered on the network. Connecting works only if it was paired with this computer.') : null,
      ),
      badges,
      actions,
    );
  }

  function render(state) {
    app.replaceChildren();
    const busy = ACTIVITY[state.activity];
    app.append(
      h('header', { class: 'top' },
        icon('phone', 'logo'),
        h('div', { class: 'titles' },
          h('h1', {}, 'ADB Connect'),
          h('p', { class: 'muted' }, state.adb || 'Wireless Android Debugging'),
        ),
        busy ? h('span', { class: 'activity', role: 'status' }, h('span', { class: 'spinner' }), busy) : null,
      ),
    );
    if (state.error) {
      app.append(h('div', { class: 'banner', role: 'alert' },
        h('div', {}, h('strong', {}, 'adb unavailable. '), state.error, ' ',
          h('button', { class: 'link', onclick: action('settings') }, 'Set adb path'))));
    }
    app.append(h('nav', { class: 'tiles', 'aria-label': 'Actions' },
      tile('Pair via QR Code', 'qr', 'pairQr', true),
      tile('Pair with Code', 'key', 'pairCode'),
      tile('Connect IP:Port', 'plug', 'connect'),
      tile('Discover Devices', 'search', 'discover'),
      tile('Reconnect', 'sync', 'reconnectAll'),
      tile('Settings', 'gear', 'settings'),
      tile('Logs', 'log', 'logs'),
    ));

    const entries = state.entries || [];
    const connected = entries.filter((e) => e.status === 'connected').length;
    app.append(h('h2', {}, `Devices (${connected} connected)`));
    if (!entries.length) {
      app.append(h('div', { class: 'empty' },
        h('strong', {}, 'No devices yet.'),
        h('ol', {},
          h('li', {}, 'On the phone (Android 11+): Settings › Developer options › Wireless debugging — turn it on.'),
          h('li', {}, 'Make sure the phone and this computer are on the same Wi-Fi.'),
          h('li', {}, 'Click “Pair via QR Code” above and scan from “Pair device with QR code”.'),
        )));
    } else {
      app.append(h('div', { class: 'list' }, entries.map(deviceCard)));
    }
    app.append(h('footer', {}, 'Remembered devices reconnect automatically only when they are advertising on your network. Disconnecting a device stops its auto-reconnect until you connect it again.'));
  }

  window.addEventListener('message', (ev) => {
    if (ev.data && ev.data.type === 'state') render(ev.data.state);
  });
  send({ type: 'ready' });
})();
