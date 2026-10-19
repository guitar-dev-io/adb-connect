import QRCode from 'qrcode';

/** SVG markup for a pairing payload. Error correction M, matching typical phone scanners. */
export function renderQrSvg(payload: string): Promise<string> {
  return QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#000000', light: '#ffffff' } });
}

/** Block-character QR for terminals (CLI). */
export function renderQrTerminal(payload: string): Promise<string> {
  return QRCode.toString(payload, { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
}
