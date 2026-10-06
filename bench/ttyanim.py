#!/usr/bin/env python3
"""ttyanim.py — full-screen redraw capacity, run *inside* the terminal under test.

Each frame repaints the whole grid, then sends DA1 (ESC[c) and waits for the reply before the next
frame. When an emulator parses and paints on the same thread (xterm.js in the VS Code window, a
webview terminal without a worker), slow paints delay the reply, so frames/s reflects parse + render
capacity. With an off-thread renderer it reflects parsing only — pair it with Process Explorer.

Usage: bench/ttyanim.py [label]   env: SECONDS_PER_TEST=5
"""
import os, select, sys, termios, time, tty

LABEL = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("TERM_PROGRAM", "unknown")
DURATION = float(os.environ.get("SECONDS_PER_TEST", "5"))
WORDS = "const let return function import export async await if else for while class new this".split()
cols, rows = os.get_terminal_size()

def tui(f):     # ink/TUI-style repaint: one color per line
    out = []
    for y in range(rows):
        line = ""
        while len(line) < cols - 12:
            line += WORDS[(y * 13 + f + len(line)) % len(WORDS)] + " "
        out.append(f"\x1b[{y + 1};1H\x1b[3{(y + f) % 8}m{line}\x1b[0m\x1b[K")
    return "".join(out)

def scroll(f):  # a screenful of new log lines
    return "".join(f"\x1b[3{(y + f) % 8}m[{f:06d}]\x1b[0m " + " ".join(WORDS[(y + f + i) % len(WORDS)] for i in range(10)) + "\r\n" for y in range(rows))

def fg(f):      # every cell: new glyph + 256-color fg
    return "\x1b[H" + "\r\n".join("".join(f"\x1b[38;5;{(x + y + f) & 255}m{chr(33 + (x + y * 7 + f) % 94)}" for x in range(cols)) for y in range(rows)) + "\x1b[0m"

def cells(f):   # every cell: new glyph + its own fg×bg pair (glyph-atlas worst case)
    return "\x1b[H" + "\r\n".join("".join(f"\x1b[38;5;{(x + y + f) & 255};48;5;{(x * 3 + y * 7 + f) & 255}m{chr(33 + (x + y * 7 + f) % 94)}" for x in range(cols)) for y in range(rows)) + "\x1b[0m"

fd_in, fd_out = sys.stdin.fileno(), sys.stdout.fileno()

def write(s):
    b = s.encode()
    while b:
        b = b[os.write(fd_out, b):]

def da1():
    write("\x1b[c")
    buf = b""
    while not buf.endswith(b"c"):
        if not select.select([fd_in], [], [], 10)[0]:
            raise SystemExit("ttyanim: no DA1 reply from this terminal")
        buf += os.read(fd_in, 64)

saved = termios.tcgetattr(fd_in)
results = []
try:
    tty.setraw(fd_in)
    write("\x1b[?25l\x1b[2J")
    for name, gen in [("tui", tui), ("scroll", scroll), ("fg", fg), ("cells", cells)]:
        frames = [gen(f) for f in range(240)]  # pre-generate so Python string building isn't timed
        da1()
        n, t0 = 0, time.perf_counter()
        while (elapsed := time.perf_counter() - t0) < DURATION:
            write(frames[n % len(frames)])
            da1()
            n += 1
        results.append((name, n / elapsed, len(frames[0].encode())))
finally:
    termios.tcsetattr(fd_in, termios.TCSADRAIN, saved)
    write("\x1b[0m\x1b[?25h\x1b[2J\x1b[H")

report = [f"ttyanim  label={LABEL}  grid={cols}x{rows}  {DURATION:g}s per test (frames acked/s)"]
report += [f"  {name:<7} {fps:7.1f} fps   ({size / 1024:.0f} KB/frame)" for name, fps, size in results]
print("\n".join(report))
cache = os.path.join(os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache")), "ttybench")
os.makedirs(cache, exist_ok=True)
with open(os.path.join(cache, "results.tsv"), "a") as f:
    f.writelines(f"{LABEL}\tanim_{name}_fps\t{fps:.1f}\n" for name, fps, _ in results)
