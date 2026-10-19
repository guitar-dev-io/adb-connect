import * as vscode from 'vscode';
import { AdbEngine, PairingResult, PairingUpdate, QrPairingSession, renderQrSvg } from '@adb-connect/core';
import { webviewHtml, localResourceRoots } from './html';

export interface QrPanelCallbacks {
  onResult(r: PairingResult): void | Promise<void>;
  useCode(): void;
  setActivity(pairing: boolean): void;
}

const SCAN_TIMEOUT_MS = 120_000;

/**
 * Real Android Wireless Debugging QR pairing view. Each attempt uses fresh one-time credentials;
 * the password only lives in memory for the duration of the attempt.
 */
export class QrPairingPanel implements vscode.Disposable {
  private static current?: QrPairingPanel;
  private session?: QrPairingSession;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private queued: unknown[] = [];

  static show(extensionUri: vscode.Uri, engine: AdbEngine, cb: QrPanelCallbacks) {
    if (QrPairingPanel.current) {
      QrPairingPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('adbConnect.qrPairing', 'Pair via QR Code', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true, // keep the attempt and countdown while the user switches tabs
      localResourceRoots: localResourceRoots(extensionUri),
    });
    QrPairingPanel.current = new QrPairingPanel(panel, extensionUri, engine, cb);
    void QrPairingPanel.current.start();
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly engine: AdbEngine,
    private readonly cb: QrPanelCallbacks,
  ) {
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
    panel.webview.html = webviewHtml(panel.webview, extensionUri, {
      title: 'Pair via QR Code',
      styles: ['common.css', 'qr.css'],
      scripts: ['icons.js', 'qr.js'],
      body: '<main id="app" aria-live="polite"></main>',
    });
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: unknown) => {
        const type = (m as { type?: string })?.type;
        if (type === 'ready') {
          this.ready = true;
          for (const q of this.queued) void this.panel.webview.postMessage(q);
          this.queued = [];
        } else if (type === 'cancel') {
          this.session?.cancel();
        } else if (type === 'retry') {
          void this.start();
        } else if (type === 'useCode') {
          this.session?.cancel();
          this.panel.dispose();
          this.cb.useCode();
        } else if (type === 'close') {
          this.panel.dispose();
        }
      }),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  private post(msg: unknown) {
    if (this.ready) void this.panel.webview.postMessage(msg);
    else this.queued.push(msg);
  }

  private async start() {
    this.session?.cancel();
    const session = this.engine.createQrSession({ scanTimeoutMs: SCAN_TIMEOUT_MS });
    this.session = session;
    const svg = await renderQrSvg(session.payload);
    this.post({ type: 'qr', svg, expiresAt: Date.now() + SCAN_TIMEOUT_MS });
    session.on('update', (u: PairingUpdate) => {
      if (this.session === session) this.post({ type: 'update', update: { state: u.state, message: u.message, endpoint: u.endpoint, device: u.device ? { model: u.device.model, serial: u.device.serial } : undefined } });
    });
    this.cb.setActivity(true);
    try {
      const r = await session.run();
      if (this.session !== session) return; // superseded by retry
      await this.cb.onResult(r);
    } finally {
      if (this.session === session) this.cb.setActivity(false);
    }
  }

  dispose() {
    this.session?.cancel();
    this.session = undefined;
    this.cb.setActivity(false);
    QrPairingPanel.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
