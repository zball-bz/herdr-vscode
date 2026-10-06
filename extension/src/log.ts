// The "Herdr" output channel. HERDR_VSCODE_LOG_FILE also appends every line to a
// file, which the end-to-end test reads.
import { appendFileSync } from 'node:fs';
import * as vscode from 'vscode';

export class Log implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('Herdr', { log: true });
  private readonly file = process.env.HERDR_VSCODE_LOG_FILE;
  private webviewLines = 0;

  info(text: string): void {
    this.channel.info(text);
    this.append('info', text);
  }

  warn(text: string): void {
    this.channel.warn(text);
    this.append('warn', text);
  }

  error(text: string): void {
    this.channel.error(text);
    this.append('error', text);
  }

  /** Console output of the webview, bounded so a chatty page cannot flood the channel. */
  webview(level: string, text: string): void {
    if (++this.webviewLines > 2000) return;
    const line = `webview: ${text.slice(0, 4000)}`;
    if (level === 'error') this.error(line);
    else if (level === 'warn') this.warn(line);
    else this.info(line);
  }

  dispose(): void {
    this.channel.dispose();
  }

  private append(level: string, text: string): void {
    if (!this.file) return;
    try {
      appendFileSync(this.file, `${new Date().toISOString()} [${level}] ${text}\n`);
    } catch {
      /* diagnostics only */
    }
  }
}
