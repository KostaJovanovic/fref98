# Asset licences (web/)

Everything visual in the web app is original work made for File Refragmenter. No third-party fonts, icon sets,
or photos are included.

| Asset | Source | Licence |
|---|---|---|
| Refragmenter Pixel font (`src/assets/fonts/refrag-pixel*.ttf`) | Drawn from scratch in `scripts/glyphs.txt`, built by `scripts/build_font.py` | CC0 1.0 |
| Icons, cursors, caption buttons, control sprites (`src/ui/art.ts`, `art-chrome.ts`, `icons98.ts`, `cursors.ts`) | Generated from code at runtime | CC0 1.0 |
| Foldy mockup sprite sheet (`src/assets/foldy/foldy.png` + `foldy.json`) | Original mockup art, drawn by a script of ours that is not in the repo; to be replaced by the author's own art | CC0 1.0 |
| App icons (`public/icons/*.png`) | `scripts/make_icons.py` | CC0 1.0 |
| Desktop sky | Rendered at runtime (`src/engine/skygen.ts`) and passed through the File Refragmenter codec | CC0 1.0 |
| Placeholder photos (`ph:*`) | Procedural, `src/engine/bundled.ts` | CC0 1.0 |

The look imitates a late-90s (Windows 98) desktop. It does not reuse any Microsoft bitmaps, fonts or sounds.
