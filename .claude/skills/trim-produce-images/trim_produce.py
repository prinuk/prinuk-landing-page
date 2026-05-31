#!/usr/bin/env python3
"""Trim built-in whitespace from produce photos so they fill the product cards.

The order page renders product images with object-fit: contain, so any white
border baked into the source image shows as empty space and makes the produce
look small. This crops each image down to its content (keeping aspect ratio),
with guards so already-tight or pale-on-white images are left alone.

Usage (from repo root):
    pip3 install --break-system-packages Pillow   # one-time
    python3 .claude/skills/trim-produce-images/trim_produce.py assets/produce/clementine.jpg
    python3 .claude/skills/trim-produce-images/trim_produce.py assets/produce/*.jpg assets/produce/*.jpeg

Build asserts image filenames and that each produce image is <=120KB, so this
keeps filenames and re-encodes under that limit. Reversible via git.
"""
import glob
import os
import sys

from PIL import Image, ImageChops

MAX_BYTES = 120 * 1024


def trim(path, margin_frac=0.03, bg=(255, 255, 255), thresh=18, max_dim=700):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    diff = ImageChops.difference(im, Image.new("RGB", im.size, bg)).convert("L")
    mask = diff.point(lambda p: 255 if p > thresh else 0)
    bbox = mask.getbbox()
    if not bbox:
        return ("skip-empty", path, None)

    cw, ch = bbox[2] - bbox[0], bbox[3] - bbox[1]
    # Pale subject on a white background: faint detection — don't risk cropping
    # into the produce. Leave it as-is for a human to review.
    if cw * ch < w * h * 0.25:
        return ("skip-faint", path, f"{cw}x{ch}")
    if cw >= w * 0.97 and ch >= h * 0.97:
        return ("skip-tight", path, None)

    m = int(round(max(cw, ch) * margin_frac))
    box = (max(0, bbox[0] - m), max(0, bbox[1] - m),
           min(w, bbox[2] + m), min(h, bbox[3] + m))
    crop = im.crop(box)
    if max(crop.size) > max_dim:
        s = max_dim / max(crop.size)
        crop = crop.resize((round(crop.size[0] * s), round(crop.size[1] * s)), Image.LANCZOS)

    q = 88
    while q >= 60:
        crop.save(path, "JPEG", quality=q, optimize=True)
        if os.path.getsize(path) <= MAX_BYTES:
            break
        q -= 6
    return ("trim", path, f"{w}x{h}->{crop.size[0]}x{crop.size[1]} ({os.path.getsize(path)//1024}KB)")


def main(args):
    paths = []
    for a in args:
        paths.extend(sorted(glob.glob(a)))
    if not paths:
        print("No files matched. Pass image paths, e.g. assets/produce/*.jpg")
        return 1

    counts, notes = {}, []
    for p in paths:
        status, path, info = trim(p)
        counts[status] = counts.get(status, 0) + 1
        if status in ("trim", "skip-faint") and info:
            notes.append(f"  {status:11} {os.path.basename(path)}: {info}")
    print("summary:", counts)
    for n in notes:
        print(n)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
