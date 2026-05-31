---
name: trim-produce-images
description: Trim built-in whitespace from produce photos in assets/produce so they fill the product cards. Use whenever a product image looks small/floating in the order page, or after adding/replacing photos in assets/produce. The cards use object-fit:contain, so source whitespace shows as empty space.
---

# Trim produce images

The order page product cards display photos with `object-fit: contain`, which
shows the **whole** image. Many source photos have a wide white border baked
in, so the produce renders small and floating. The fix is to crop each image
down to just its content (no forced square), keeping its natural aspect.

> This is the Prinuk-specific guide (paths, the 120KB build limit, the
> `object-fit` rationale) and is self-contained for the repo. A generic,
> project-agnostic version also exists in your personal skills as
> `trim-image-whitespace` (`~/.claude/skills/`) — use that one in other
> projects.

## When to use
- A product image looks too small / lost in whitespace in the catalog.
- New photos were added to `assets/produce/` and should be normalized.

## Constraints (don't break the build)
- `scripts/build.js` asserts specific image **URLs (filenames)** — keep the
  same filenames, only change pixels.
- Each produce image must stay **≤120KB** (the script enforces this).
- Run from the repo root.

## How to run
```bash
# One-time: Pillow is needed and not preinstalled (no ImageMagick on the box)
pip3 install --break-system-packages Pillow

# Trim one image (verify first), or all of them:
python3 .claude/skills/trim-produce-images/trim_produce.py assets/produce/clementine.jpg
python3 .claude/skills/trim-produce-images/trim_produce.py assets/produce/*.jpg assets/produce/*.jpeg

# Then verify and commit
npm run build && npm run lint
git add assets/produce && git commit -m "Trim produce photo whitespace"
```

## How it works / safety
- Finds the content bounding box (pixels differing from white past a
  threshold), crops to it plus a small margin, keeps aspect ratio.
- **Skips** images already tight (≥97% content) and pale-on-white subjects
  whose detected content is <25% of the image (avoids cropping into white
  produce like garlic/cauliflower). Those are left untouched — review by eye.
- Re-encodes JPEG, lowering quality only as needed to stay under 120KB.
- All changes are reversible via `git checkout assets/produce`.

The script is `trim_produce.py` in this folder.
