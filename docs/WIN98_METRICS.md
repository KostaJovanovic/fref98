# Windows 98 look: metrics and colours

This is the reference the shell is built against: the default "Windows Standard" scheme at 96 DPI, normal fonts.
The values come from the documented system metrics and colours of Windows 98, cross-checked against the
MIT-licensed [98.css](https://github.com/jdan/98.css) project. Everything in the app is redrawn by us. No Microsoft
bitmaps, cursors or fonts are copied. Sizes are in UI pixels, before our integer scale (`ui.k`).

## Colours

| Role | Hex |
|---|---|
| 3D face (windows, buttons, menus, taskbar) | `#C0C0C0` |
| 3D highlight (outer light edge) | `#FFFFFF` |
| 3D light (inner light edge) | `#DFDFDF` |
| 3D shadow (inner dark edge) | `#808080` |
| 3D dark shadow (outer dark edge) | `#000000` (98.css uses `#0A0A0A`) |
| Window background (text boxes, lists) | `#FFFFFF` |
| Active caption | gradient `#000080` → `#1084D0` (left to right), text `#FFFFFF` bold |
| Inactive caption | gradient `#808080` → `#B5B5B5`, text `#C0C0C0` bold |
| Selection / highlight | `#000080`, text `#FFFFFF` |
| Grey (disabled) text | `#808080` with a `#FFFFFF` emboss 1 px down-right |
| Tooltip | background `#FFFFE1`, 1 px `#000000` border, black text |
| Desktop (when no wallpaper) | `#008080` |
| Hyperlink | `#0000FF` |

## Bevels

The frames are drawn as two 1 px rings, outer then inner:

| Kind | Outer ring (top-left / bottom-right) | Inner ring (top-left / bottom-right) |
|---|---|---|
| Raised (buttons, taskbar buttons) | `#FFFFFF` / `#000000` | `#DFDFDF` / `#808080` |
| Pressed button | `#000000` / `#FFFFFF` | `#808080` / `#DFDFDF` |
| Window frame | `#DFDFDF` / `#000000` | `#FFFFFF` / `#808080` |
| Sunken field (text box, list, checkbox) | `#808080` / `#FFFFFF` | `#000000` / `#DFDFDF` |
| Status-bar cell, tray | `#808080` / `#FFFFFF` (1 ring only) | none |
| Default button | an extra 1 px `#000000` ring outside the raised bevel | |

Focus is a 1 px dotted black rectangle inset 4 px on buttons, or around the label on checkboxes and radios.

## Window

| Part | Size |
|---|---|
| Sizing frame (resizable) | 4 px: the 2-ring bevel plus 2 px of face |
| Fixed frame (dialogs) | 3 px |
| Caption | 18 px tall. Small icon 16×16 at the left, 2 px padding, bold text. |
| Caption buttons | 16×14 each. Raised bevel with a black glyph. Minimise and maximise touch; close has 2 px gap. |
| Caption-button glyphs | minimise: 6×2 bar at the bottom. maximise: 9×9 box with a 2 px top. restore: two overlapped 6×6 boxes. close: 8×7 ×. |
| Menu bar | 18 px rows, items padded 6 px left and right, no bevel. The open item is shown sunken (1 px), not highlighted. |
| Status bar | 20 px tall, cells sunken 1 px, 2 px gap between cells. Size grip at the bottom right: 3 diagonal pairs of highlight and shadow lines. |
| Minimise / maximise / restore | A caption-only rectangle (`IDANI_CAPTION`) zooms between the window and its taskbar button in about 200 ms. Open and close dissolve through an 8×8 Bayer screen door (8 steps, about 200 ms; our touch, not 98's). |
| Dragging | Moving and sizing drag an outline (halftone, XOR'd, as thick as the frame); the window jumps there on release. |

## Menus

- **Popup:** raised window-frame bevel, 2 px padding inside.
- **Item:** 18 px tall. 20 px left margin for the check mark or bullet; accelerator text right-aligned.
- **Submenu arrow:** black ▸ at the right.
- **Hover:** `#000080` with white text.
- **Separator:** 1 px `#808080` above 1 px `#FFFFFF`, with 3 px margins.
- **Submenus:** cascade to the right of their item (or flip left at the screen edge) and open after about 400 ms
  of hover.

## Controls

| Control | Metrics |
|---|---|
| Push button | 75×23 minimum, raised bevel, text centred. Pressed: sunken and the text shifts 1 px down-right. |
| Checkbox | 13×13 sunken white box, 7×7 black check |
| Radio | 12×12 round, pixel-stepped circle, 4×4 black dot |
| Text box | sunken field, white, 21 px tall for one line |
| Drop-down | text box plus a 16 px-wide raised button with a ▼. Its list is a white box with a 1 px black border and `#000080` highlight. |
| Scrollbar | 16 px wide. Arrow buttons 16×16 raised. Track is a dither of `#C0C0C0` and `#FFFFFF`. Thumb is raised, at least 8 px. |
| Spin buttons | two 16×10 stacked raised buttons with tiny ▲▼ |
| Slider (trackbar) | 4 px sunken track. The thumb is a raised 11×21 pointed tab. Tick marks are 1 px black lines under it. |
| Tabs | 18 px tall, raised on top and sides. The selected tab is 2 px taller and joins the page. |
| Group box | etched frame: 1 px `#808080` then 1 px `#FFFFFF`, with the label on the line |
| Progress bar | sunken field filled with `#000080` blocks, 8 px wide with a 2 px gap |

## Desktop, taskbar, Start menu

| Part | Metrics |
|---|---|
| Desktop icon | 32×32 icon above a label up to 2 lines. Selected: the icon is dithered with `#000080` and the label is highlighted. Grid spacing 75×75. |
| Rubber band | a 1 px dotted rectangle (XOR), not translucent |
| Taskbar | 28 px tall with a raised top edge |
| Start button | 54×22 raised. Windows-style flag icon replaced by our own, bold "Start". Pressed while the menu is open. |
| Task button | up to 160 px wide, 22 px tall, icon plus text. The active window's button is pressed and its text bold. |
| Tray | sunken 1 px, clock at the right |
| Start menu | raised window bevel. Vertical banner on the left, 21 px wide, gradient `#000080` → `#1084D0` bottom to top, with the product name rotated. Items 32 px tall with 24 px icons (top level) or 20 px tall with 16 px icons (cascaded). |

## Cursors (redrawn, 1-bit with a mask, no shadow)

Arrow (11×19 visible), link hand, I-beam, hourglass (animated), arrow with hourglass (working in background), resize
↕ ↔ ⤡ ⤢, move ✥, unavailable ⊘, help (arrow plus ?), crosshair, pen. They are drawn at device pixels so they
never scale with browser zoom.

## Font

We keep our own pixel font (Refragmenter Pixel), set at 98's MS Sans Serif 8 pt metrics: about 11 px cap
height and 13 px line height, bold for captions and the default button.
