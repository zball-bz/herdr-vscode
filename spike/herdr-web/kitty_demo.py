#!/usr/bin/env python3
"""Shows images with the Kitty graphics protocol (TGP), as an app inside a herdr pane would.

1. A PNG file, transmitted directly in base64 chunks (f=100, t=d, a=T), sized to 16x8 cells.
2. A raw RGBA gradient generated here (f=32, s/v pixel size), sized to 24x6 cells.
Usage: kitty_demo.py [png-path]
"""
import base64, os, sys

PNG = sys.argv[1] if len(sys.argv) > 1 else "/usr/share/code/resources/app/resources/linux/code.png"


def send(control: str, payload: bytes) -> None:
    data = base64.standard_b64encode(payload)
    chunks = [data[i:i + 4096] for i in range(0, len(data), 4096)] or [b""]
    for n, chunk in enumerate(chunks):
        more = 1 if n < len(chunks) - 1 else 0
        head = f"{control},m={more}" if n == 0 else f"m={more}"
        sys.stdout.buffer.write(b"\x1b_G" + head.encode() + b";" + chunk + b"\x1b\\")
    sys.stdout.buffer.flush()


print("PNG via Kitty graphics (16x8 cells):")
send("a=T,f=100,t=d,c=16,r=8,q=2", open(PNG, "rb").read())
print()

w, h = 256, 64
pixels = bytearray()
for y in range(h):
    for x in range(w):
        pixels += bytes((x, (y * 4) % 256, 255 - x, 255))
print("RGBA gradient (24x6 cells):")
send(f"a=T,f=32,s={w},v={h},t=d,c=24,r=6,q=2", bytes(pixels))
print()
print("done")
