import * as vscode from 'vscode';
import { statusText, StatusInput } from './statusText';

export type { Activity, StatusInput } from './statusText';

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('adbConnect.status', vscode.StatusBarAlignment.Left, 50);

  constructor() {
    this.item.name = 'ADB Connect';
    this.item.command = 'adbConnect.menu';
  }

  update(input: StatusInput, visible: boolean) {
    const { text, tooltip } = statusText(input);
    this.item.text = text;
    this.item.tooltip = tooltip;
    this.item.accessibilityInformation = { label: text.replace(/\$\([^)]+\)\s*/g, ''), role: 'button' };
    this.item.backgroundColor = input.activity === 'no-adb' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    if (visible) this.item.show();
    else this.item.hide();
  }

  dispose() {
    this.item.dispose();
  }
}
