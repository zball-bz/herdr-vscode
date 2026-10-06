#!/usr/bin/env bash
# ttybench.sh — terminal-emulator benchmark you run *inside* the terminal under test.
#
# Throughput: cat a corpus, then send DA1 (ESC[c) and wait for the reply. A terminal answers DA1
# only after parsing everything before it, so the timing covers pty → emulator parse, regardless of
# how much the emulator buffers internally (VS Code flow control, webview postMessage queues, ...).
# Rendering is decoupled from parsing in every engine, so measure paint cost separately
# (DevTools Performance panel / Process Explorer — see README.md).
#
# Round trip: N empty DA1 queries; each is shell → pty → emulator → pty → shell, i.e. the output
# path latency plus the reply path, without any rendering.
#
# Usage: bench/ttybench.sh [label]      env: SIZE_MB=16 RUNS=5 RTT_N=200
# Results are appended to ~/.cache/ttybench/results.tsv (label, test, value).
set -euo pipefail

LABEL=${1:-${TERM_PROGRAM:-unknown}}
SIZE_MB=${SIZE_MB:-16}
RUNS=${RUNS:-5}
RTT_N=${RTT_N:-200}
DIR=${XDG_CACHE_HOME:-$HOME/.cache}/ttybench
mkdir -p "$DIR"

[[ -t 0 && -t 1 ]] || { echo "ttybench: run this in an interactive terminal" >&2; exit 1; }
read -r COLS ROWS < <(stty size | awk '{print $2, $1}')

# Deterministic corpora, shared by every terminal under test.
python3 - "$DIR" "$SIZE_MB" "$ROWS" "$COLS" <<'PY'
import os, random, sys
out, size_mb, rows, cols = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
target = size_mb * 1024 * 1024
words = "const let return function import export async await if else for while class new this".split()
cjk, emoji = "终端性能测试渲染解析吞吐延迟字符宽度表情符号", ["😀", "🚀", "👍🏽", "🇨🇳", "👨‍👩‍👧"]
def ascii_(r):  return " ".join(r.choice(words) for _ in range(12)) + "\r\n"
def sgr(r):     return " ".join(f"\x1b[38;2;{r.randrange(256)};{r.randrange(256)};{r.randrange(256)}m{r.choice(words)}\x1b[0m" for _ in range(10)) + "\r\n"
def tui(r):     return "".join(f"\x1b[{1+r.randrange(rows)};{1+r.randrange(max(1, cols-20))}H\x1b[3{r.randrange(8)};4{r.randrange(8)}m{r.choice(words)}\x1b[K" for _ in range(8)) + "\x1b[0m"
def unicode(r): return "".join(r.choice(emoji) if r.randrange(5) == 0 else r.choice(cjk) for _ in range(25)) + "\r\n"
def cells(r):   # every cell gets its own fg×bg pair: worst case for glyph-atlas renderers
    return "\x1b[H" + "\r\n".join("".join(f"\x1b[38;5;{r.randrange(256)};48;5;{r.randrange(256)}m{chr(33 + r.randrange(94))}" for _ in range(cols)) for _ in range(rows)) + "\x1b[0m"
for name, gen in [("ascii", ascii_), ("sgr", sgr), ("tui", tui), ("unicode", unicode), ("cells", cells)]:
    path = f"{out}/{name}-{size_mb}m-{cols}x{rows}.txt"
    if os.path.exists(path): continue
    r, parts, n = random.Random(42), [], 0
    while n < target:
        s = gen(r); parts.append(s); n += len(s.encode())
    with open(path + ".tmp", "w") as f: f.write("".join(parts))
    os.replace(path + ".tmp", path)
PY

saved=$(stty -g)
trap 'stty "$saved"; printf "\e[0m\e[?25h"' EXIT
stty -echo -icanon min 1 time 0

now_us() { local t=${EPOCHREALTIME/./}; echo "$t"; }
da1() {  # reply: ESC [ ? … c
  local _r
  printf '\e[c'
  IFS= read -r -t 10 -d c _r || { echo "ttybench: no DA1 reply from this terminal" >&2; exit 1; }
}

median() { sort -n | awk '{a[NR]=$1} END {print a[int((NR+1)/2)]}'; }
results=()

for name in ascii sgr tui unicode cells; do
  f="$DIR/$name-$SIZE_MB""m-${COLS}x${ROWS}.txt"
  bytes=$(stat -c %s "$f")
  samples=()
  for ((i = 0; i < RUNS; i++)); do
    printf '\e[0m\e[H\e[2J'; da1
    t0=$(now_us); cat "$f"; da1; t1=$(now_us)
    samples+=("$(( bytes / (t1 - t0) ))")   # bytes per µs == MB/s
  done
  results+=("$name"$'\t'"$(printf '%s\n' "${samples[@]}" | median)")
done

printf '\e[0m\e[H\e[2J'
rtts=()
for ((i = 0; i < RTT_N; i++)); do t0=$(now_us); da1; t1=$(now_us); rtts+=("$((t1 - t0))"); done
sorted=$(printf '%s\n' "${rtts[@]}" | sort -n)
p50=$(awk -v n="$RTT_N" 'NR==int(n*0.50)+1' <<<"$sorted")
p95=$(awk -v n="$RTT_N" 'NR==int(n*0.95)' <<<"$sorted")

{
  printf 'ttybench  label=%s  grid=%sx%s  corpus=%sMB  runs=%s (median)\n' "$LABEL" "$COLS" "$ROWS" "$SIZE_MB" "$RUNS"
  for r in "${results[@]}"; do printf '  %-8s %6s MB/s\n' "${r%%$'\t'*}" "${r#*$'\t'}"; done
  printf '  DA1 round trip  p50 %s us  p95 %s us\n' "$p50" "$p95"
} | tee "$DIR/last-$LABEL.txt"
for r in "${results[@]}"; do printf '%s\t%s\t%s\n' "$LABEL" "${r%%$'\t'*}" "${r#*$'\t'}" >>"$DIR/results.tsv"; done
printf '%s\trtt_p50_us\t%s\n%s\trtt_p95_us\t%s\n' "$LABEL" "$p50" "$LABEL" "$p95" >>"$DIR/results.tsv"
