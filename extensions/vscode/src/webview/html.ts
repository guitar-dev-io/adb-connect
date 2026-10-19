import * as vscode from 'vscode';
import { randomBytes } from 'crypto';

export function nonce(): string {
  return randomBytes(18).toString('base64');
}

/**
 * HTML shell for a webview: strict CSP with a per-render nonce, only local styles/scripts
 * from media/, and no inline event handlers.
 */
export function webviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  opts: { title: string; styles: string[]; scripts: string[]; body: string },
): string {
  const n = nonce();
  const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', f)).toString();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${n}'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
  return `<!doctype html>
<html lang="${vscode.env.language || 'en'}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${opts.title}</title>
${opts.styles.map(s => `<link rel="stylesheet" href="${uri(s)}">`).join('\n')}
</head>
<body>
${opts.body}
${opts.scripts.map(js => `<script nonce="${n}" src="${uri(js)}"></script>`).join('\n')}
</body>
</html>`;
}

export function localResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [vscode.Uri.joinPath(extensionUri, 'media')];
}
