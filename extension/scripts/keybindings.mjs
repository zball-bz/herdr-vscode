// Regenerates contributes.keybindings in package.json.
//
// VS Code forwards every keydown inside a webview to the workbench, after the
// pane has already handled it (sent it to the terminal, or acted on it itself:
// herdr-web copies on Ctrl+Shift+C, asks for a paste on Ctrl+Shift+V / Cmd+V,
// opens find on Ctrl+Shift+F). While the pane has focus (`herdr.paneFocused`),
// every Ctrl/Alt/Ctrl+Shift letter is bound to the no-op `herdr.noop`, so the
// workbench drops the forwarded copy. Keys in the `herdr.editorKeys` setting
// never get that far: the webview intercepts them and the extension runs their
// command (Quick Open, Command Palette, terminal toggle).
//
// Ctrl+Shift+F runs `herdr.find` instead of a no-op: herdr-web opens its find
// bar on that key itself and opening it again is a no-op, while the binding
// shows the shortcut in the Command Palette and keeps VS Code's Search closed.
// (A display-only binding shadowed by a later no-op would not work: VS Code
// drops a binding from its shortcut lookup when a later one with the same
// `when` overrides it.)
import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(path, 'utf8'));
const when = 'herdr.paneFocused';
const commands = [{ key: 'ctrl+shift+f', mac: 'cmd+f', command: 'herdr.find', when }];
const swallowed = [];
for (const prefix of ['ctrl+', 'alt+', 'ctrl+shift+']) {
  for (let code = 97; code <= 122; code++) {
    const key = prefix + String.fromCharCode(code);
    if (!commands.some((binding) => binding.key === key)) swallowed.push({ key, command: 'herdr.noop', when });
  }
}
// macOS: herdr-web handles Cmd+C / Cmd+V itself; VS Code's own copy/paste would
// run execCommand in the webview and paste a second time. (Untested on macOS.)
for (const key of ['cmd+c', 'cmd+v']) swallowed.push({ key, command: 'herdr.noop', when: `${when} && isMac` });
pkg.contributes.keybindings = [...commands, ...swallowed];
writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
console.log(`keybindings: ${commands.length} command, ${swallowed.length} swallowed keys`);
