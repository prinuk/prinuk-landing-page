#!/usr/bin/env python3
"""Generate the tracked-QR images (SVG + PNG) for the buying/marketing QR.

The QR encodes the tracked redirect  https://order.prinuk.co.il/api/qr?c=<code>
(api/qr.js logs each scan → audit_log, then 302s to the order site). Scan counts
show in the team dashboard (📱 QR — סריקות).

One-off asset generator (NOT a runtime dependency). Needs `segno`:
    pip3 install --break-system-packages segno
    python3 scripts/gen-qr.py            # regenerate assets/qr/qr-main.*

To add another campaign QR:  python3 scripts/gen-qr.py flyer
"""
import sys
import os
import segno

CODE = (sys.argv[1] if len(sys.argv) > 1 else "main").strip().lower()
URL = f"https://order.prinuk.co.il/api/qr?c={CODE}"
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "assets", "qr")
os.makedirs(OUT_DIR, exist_ok=True)

# Error correction 'H' (~30% recoverable) — robust for print/scuffs.
qr = segno.make(URL, error="h")

svg_path = os.path.join(OUT_DIR, f"qr-{CODE}.svg")
png_path = os.path.join(OUT_DIR, f"qr-{CODE}.png")

# Vector SVG (scales to any print size), dark on white, generous quiet zone.
qr.save(svg_path, kind="svg", scale=10, border=4, dark="#1b2a20", light="#ffffff")
# High-res PNG for quick sharing/printing.
qr.save(png_path, kind="png", scale=20, border=4, dark="#1b2a20", light="#ffffff")

print(f"encoded: {URL}")
print(f"wrote:   {os.path.relpath(svg_path)}")
print(f"wrote:   {os.path.relpath(png_path)} ({os.path.getsize(png_path)} bytes)")
