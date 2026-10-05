# File Refragmenter 98 Gold (formerly JpegIt): revision plan (v2)

Status: **built (v0.18, 2026-10-05).** Written 2026-10-04 after the user's review of v1. The target later moved from
Windows XP to **Windows 98**; the XP wording below is kept as the original record. Still open: phones (to discuss),
the user's own Foldy art and lines.

Goal, in the user's words: *it should feel exactly like Windows XP, be intuitive and fluid, and be as fast as XP
would be on current hardware.* Fewer features, done properly.

## 1. Verdict: keep the engine, rebuild the front end

- **The engine stays.** The Rust codec, card simulator and WASM bindings work. The decoder behaves like
  libjpeg-turbo, so it is not the cause of the grey images. The grey comes from preset and step bugs, listed in
  §2. The "displacement" look can already be made as real byte damage: one test stack reproduces the user's
  examples (wrap seam, colour cast, garbage strip at the top, a different photo at the bottom). No preset uses it
  yet.
- **The web UI is rebuilt.** Most complaints are about the shell: window manager, desktop, chrome, popups,
  cursors, clutter. Patching v1's `ui/`, `shell/` and `apps/` would keep its structure (Bayer fades, busy wash,
  hand-made widgets everywhere).
  - New shell: an accurate XP Luna layer (windows, desktop, taskbar, Start menu, menus, context menus, message
    boxes, controls), built first and tested on its own.
  - The apps that survive the cuts are then moved onto it.
  - `engine/` (worker, client, stack, cache, storage, recipe) and `state.ts` are kept and slimmed down.
- **Ponytail.** A third-party Claude Code plugin by DietrichGebert. It makes the agent ask "does this need to
  exist?" before writing code. In an independent test it cut code by about 15% and cost by about 10%, with no loss
  of quality. It works only as a plugin: a SessionStart hook injects its rules into every session. It helps most
  where agents over-build, which is exactly the v1 problem; it gives no special help with UI work.
  - Recommendation: install it for this repo during the rebuild.
  - The user installs it (it's their account and it injects text into every session); read its rules first.

## 2. Findings per complaint (root causes)

| # | Complaint | Root cause | Fix |
|---|---|---|---|
| 1 | Foldy | Art and behaviour not wanted | The user draws Foldy (see §5). The code keeps a sprite slot plus the speech balloon. |
| 2 | Before/after doesn't overlap after a size change | Panes are drawn at their own pixel size and centred (`viewer.ts:149-154`). These steps change size: MMS, re-encode profile, resave crop/resize, MPF ghost, thumbnail-only, wrong-size. | Always draw Before stretched into After's display rectangle, and say so in the status bar ("640×480, was 1024×768"). |
| 3 | Slider flashes the screen | Each slider input re-runs the pipeline, and its start calls `setBusy(true)`. That puts a full-window checkerboard wash over everything, about 3× a second. Before/after canvases are also recreated on every result. | No wash for live runs. The old frame stays until the new one is ready. Runs are coalesced to the latest value (at most one in flight). After about 0.5 s, show the XP "working in background" cursor over the image only. |
| 4 | Cursor scales with zoom | PNG cursors use `image-set` with `dpr`, and Chrome's `dpr` includes page zoom. Some cursors fall back to native ones. | Real XP cursor files (see §4: licence question). Make every cursor kind consistent. The cursor must not change size with Ctrl+/−. The animated hourglass is faked by swapping frames (browsers don't play `.ani`). |
| 5 | Presets give grey | **Ransomware:** grafts without `skip`, so marker bytes end up in the data and libjpeg stops: always 100% grey. **PhotoRec:** junk size is fixed in KB, so small photos are completely overwritten, and the fallback output starts with raw junk. **Header graft:** the donor is bigger than the body. **Intensity ignored:** wrong units in Cosmic ray (always 1 bit flip), Wrong size (always +16 px), FTP (2nd pass does nothing). | Fix each one. Neutralise stray markers as header-graft recovery scripts do. Scale junk to the photo. Choose a donor with matching size and tables. Add a test that every preset is <20% grey and changes visibly between 0, 0.5 and 1. |
| 6 | Too many options, cluttered | 20+ features, many 2–6 clicks deep (inventory in §3) | Cut list in §3. One editor, one way to work. |
| 7 | Clouds too realistic | Procedural soft clouds | Cartoon clouds: flat fill, 2–3 shade bands, dark outline. Still low frame rate. |
| 8 | Foldy look | — | 3/4 view; eyes float above the folder; the folder itself is the mouth (lid opens to talk); no drawn smile. The user makes the art (§5). |
| 9 | No displacement | No preset or simple step produces it, though the parts exist | New step **Displace** (byte layer), plus a preset. Details in §6. |
| 10 | Resize from sides, XP animation | Only a 14 px corner grip. Max/restore are instant. Open/close/minimise use a dither fade, which XP doesn't have. | 8 resize handles (4 px edges, corners). XP's caption-rectangle animation (~200 ms) for minimise/maximise/restore to and from the taskbar button. Open and close are instant, as in XP. Drag with `transform` and commit on release. Contents show while dragging (XP default). *Superseded by the 98 rules: open and close dissolve through an 8×8 Bayer screen door, and dragging or sizing moves a halftone outline frame; the window follows on release (docs/WIN98_METRICS.md).* |
| 11 | Reorder desktop icons | Fixed flex column | Free placement on XP's grid (75×75 cells, snap). Right-click > Arrange Icons By (Name/Type). Positions are saved. |
| 12 | Drag-select | Missing | XP rubber band: translucent blue fill with a solid border. Ctrl/Shift multi-select. Keyboard: arrows, Enter, F2, Delete. |
| 13 | Windows are mockups | Caption 22 px (XP ~29), buttons 17 px (XP 21), flat 3 px frame (XP ~4 px shaded), 5 px top corners (XP ~8), pixel font in captions, checkerboard shadows (XP has none), submenus that replace the parent instead of cascading. | Rebuild every piece against XP SP2 Luna screenshots at 1:1, one at a time: frame, caption (active/inactive), caption buttons (normal/hover/pressed/inactive), menu bar, cascading menus, buttons, checkboxes, radio buttons, text boxes, dropdowns, sliders with ticks, tabs, group boxes, scrollbars, progress bar, status bar, tooltips, balloon tips, message boxes. |
| 14 | Native popups break immersion | The **open** list of every `<select>`; native `title` tooltips everywhere; unstyled scrollbars; native spinners on number inputs; browser right-click menu; drag ghosts on thumbnails; system text-selection colour; message boxes that aren't modal; canvas text in `sans-serif`. | Custom XP dropdown list, XP tooltip, XP scrollbars, XP spin buttons, global context menu, `draggable=false`, XP selection colour, modal message boxes with the XP icons; clicking outside a modal box flashes its caption, as XP does. The OS **file open dialog** and the **download bubble** can't be replaced by a website. Lean on drag-and-drop and our own "Save As" window. |
| 15 | Exactly XP, and fast | Sky `putImageData` at 8 fps repaints the **whole page**, windows included (nothing is on its own layer). A MutationObserver rescans all text on every DOM change. | Sky on its own compositor layer; paused when a maximised window covers it. No global observers. Budget: 60 fps drag, no long tasks while idle, first paint <300 ms. |
| 16 | Right-click everywhere | Nothing exists; the browser menu shows | One global `contextmenu` dispatcher with XP menus per surface (table below). |

### Right-click menus (what XP shows; plan to match)

| Surface | Menu |
|---|---|
| Desktop | Arrange Icons By ▸ (Name, Type, Auto Arrange, Align to Grid) · Refresh · Paste · New ▸ · Properties |
| Desktop icon | **Open** · (Explore) · Delete · Rename · Properties |
| Recycle Bin | **Open** · Empty Recycle Bin · Properties |
| Title bar / taskbar button / Alt+Space | Restore · Move · Size · Minimize · Maximize · Close (Alt+F4) |
| Empty taskbar | Toolbars ▸ · Cascade Windows · Tile ▸ · Show the Desktop · Task Manager · Lock the Taskbar · Properties |
| Image in editor | Copy · Save As… · Zoom ▸ · Compare ▸ · Set as Desktop Background |
| My Pictures file | **Open** · Edit · Set as Desktop Background · Rename · Delete · Properties |
| Recycle Bin item | Restore · Delete · Properties |
| Clock / tray | Adjust Date/Time · (Foldy: Hide, Sleep) |
| Text fields | Undo · Cut · Copy · Paste · Delete · Select All (Paste needs clipboard permission; it falls back to Ctrl+V) |

## 3. Scope: proposed cuts (user decides)

| Feature | Proposal | Why |
|---|---|---|
| Simple + Expert modes | **Merge into one editor**: a preset list, the "How bad?" slider, and a "Steps" list that shows what the preset did and can be edited. No mode switch. | One way to work |
| Story presets (16) | Keep about 10 good ones, each tested non-grey and intensity-responsive. Add **Displaced**. | Quality over count |
| Hex Doctor | Keep, as a View menu item (not on the desktop) | Nerd value, low clutter |
| Disk Doctor (card workspace) | Keep as "Removable Disk (E:)", simplified to one window: shoot → damage → recover, no 4-tab wizard | Core to the recovery idea |
| Export | One XP "Save As" window: JPG / PNG, plus a "Save all" ZIP | Fewer tabs |
| GIF / AVI / MP4 export, Video Lab, webcam | **Cut** | Overdone |
| Contact sheet, recipe files, share links | Cut the recipe/share UI; keep the project file | Overdone |
| Screensaver | **Cut** (or one: Starfield, XP's) | Overdone |
| Display Properties | Keep a small one: wallpaper and cloud speed | XP feel |
| Classic theme | **Cut** | Two looks double the work |
| Fake progress dialogs | **Cut**; real work shows real progress only | Slows the user down |
| Y2K presets page and Y2K help page | **Cut**; Help becomes an XP Help window | Mixed era |
| Recycle Bin | Keep (holds deleted photos) | XP feel |
| Start menu | Keep, XP two-column layout with All Programs ▸ | XP feel |
| Dithering everywhere | **Question**: XP itself isn't dithered. Keep it only for the sky/wallpaper? | Conflicts with "exactly XP" |

## 4. Questions for the user

**Answers (2026-10-04):**
1. Cursors: redraw them by hand as close to XP as possible.
2. Fonts: keep our pixel fonts. Fix the popups and dropdown lists that still use the system font.
3. Icons: Windows 98/ME style instead of XP's soft icons.
4. Dithering stays. The overall feel is a transition between XP and ME/98.
5. Phones: later.
6. Cuts: later.
7. Ponytail: installed (local scope, this repo only).
8. Foldy: I make a mockup now and ask the user about him; the user's own art replaces it later.
9. Window chrome, taskbar and Start menu are exact XP Luna. Only the icons (and Foldy) are 98/ME-style pixel art.
10. Cursors: the XP set, with its drop shadow.
11. Foldy:
    - Look: manila yellow folder, cartoon oval eyes that don't follow the cursor.
    - Place: lives in the editor's side panel, 64–96 px.
    - Personality: kept but toned down; glitches are very rare.
    - Speaks: after each preset, first-run tips, when clicked, and reactions.
    - Lines: the user writes them all in `docs/foldy-lines.xlsx`.
    - Mockup: `docs/foldy-mockup.png`.
12. Foldy, second round:
    - Body: only eyes and the folder. The eyes need rework.
    - Paper inside the folder: shown only in some moods.
    - Idle: blinks and bobs slowly up and down.
    - Animation style: as close as possible to the characters of the game *Endacopia* (how they talk, mouth
      animation, timing, idles). Research is pending.
    - Talking: the lid flaps at a constant, not-too-fast pace.
    - Text: plain text in the panel, no bubble.
    - Glitch: the sprite tears like a damaged JPEG and his eyes look like he is in pain.
    - Place: in every app window, never on the desktop, and never leaves his panel. Like McZee, the helper in
      3D Movie Maker.

Original questions:

1. **Real XP assets and licences.** Microsoft owns the XP cursors, sounds and theme bitmaps. Shipping them in a
   public open-source repo on Cloudflare is a copyright risk; many XP fan sites do it anyway. Options:
   - (a) ship the real files;
   - (b) the user places the files locally and the app loads them, with lookalikes for everyone else;
   - (c) redraw everything by hand at 1:1 from screenshots, as v1 did with the theme.
2. **Fonts.** XP uses Tahoma 8 pt (UI) and Trebuchet MS Bold (captions). These are Microsoft fonts, present on
   Windows but not on Mac or phones, and not freely redistributable. Options: use them when installed and fall
   back to our pixel font; or keep our pixel font, redrawn to match Tahoma's metrics.
3. **Antialiasing.** In XP, small text is aliased (default "Standard" smoothing), but icons have soft alpha edges.
   Should Foldy and the icons get soft edges (true XP) or stay hard-edged (v1 rule)?
4. **Dithering.** Keep it only for the sky and wallpaper, or drop it?
5. **Phones.** XP had no phone mode. Keep v1's approach (each window full-screen, bigger touch targets) or
   something else?
6. **Cuts.** Confirm or change the §3 table.
7. **Ponytail.** Install it for the rebuild?

## 5. Foldy: art handoff

Look: 3/4 view; the eyes float above the folder; the folder is the mouth (talking = the lid opening and closing);
no drawn face on the folder.

Recommended tools, all used to make 2000s-style semi-3D art:
- **Affinity** (free since Oct 2025; Vector, Pixel and Layout in one app). XP icons were drawn exactly like this:
  vector shapes with gradients and highlights, then exported at fixed sizes. This is the most direct way to the XP
  icon look. **Inkscape** (free) is the open-source alternative.
- **Blender** (free), if Foldy should be real 3D: model once, render each frame (lid angles, blinks, reactions)
  from the same 3/4 camera with soft studio lighting, which is the Office-assistant/Bonzi look. Render large, then
  downscale.
- **Aseprite** (paid, or free to build from source): final pixel cleanup, frame timing and onion-skinning for the
  lid and blink animation.
- Era-authentic but not recommended now: Poser, Bryce, Swift 3D, Xara 3D (dated, hard to get).

Delivery spec for the code:
- PNG frames.
- Sizes: 48×48 and 96×96 (2× for high-DPI).
- Separate layers or frames for eyes and folder, so blinking and talking combine freely.
- Mouth frames: closed, ¼, ½ and fully open.
- Eye frames: open, half, closed, looking left/right/up.
- Reactions: worried, shocked, asleep, happy.

Until the user's art exists, the app uses the mockup (`test-local/foldy_mock.py` draws it).

### Foldy animation spec (draft, from the Endacopia research)

Endacopia (ANDYLAND, 2026) was built in Adventure Game Studio. That engine's default speech animation runs at
8 fps with a constant mouth cycle (not lip sync). Its exact frame counts aren't published. The numbers below
follow that engine default and the user's answers; check them against Let's Play footage later.

- **Clock:** stepped, never eased. Talking runs at ~10 fps (100 ms, measured from the clips). Idle bob and blinks
  run at 8 fps; glitches at 12 fps.
- **Talking:** follows the user's description, plus Endacopia clips measured frame by frame. The clips are Tip's talk
  loop, Clockey and the Surgeon, from Tenor, which re-times uploads, so timings are approximate.
  - No bob while he talks.
  - The lid steps every ~100 ms through Tip's 3-frame loop: wide open, half, closed. The whole sprite jolts 1 px on
    the closed frame, as Tip's sign does.
  - Mouth steps per word: about one per two letters, minimum 3.
  - Between words he **freezes** on the exact frame he was on, even open: ~300 ms between words, ~500 ms after a
    comma, ~1 s at a sentence end. Measured freezes were 300–1100 ms.
  - The bob resumes only when he is completely idle. Plain text in the panel types out at about 40 chars/s,
  pausing 250 ms at `,` and 400 ms at `. ! ?` (Ctrl+Shift+F tunes all three). The text runs ahead of the
  mouth, and the line ends when the last letter is typed: the mouth stops there too. A click finishes the line.
  No sound.
- **Size:** 64×64, drawn after the user's sketch (v2 mockup). The eyes are tall capsules with pupils looking left.
  The folder is a rounded front cover (the mouth) with the back panel and tab receding to the right. Shading is
  Bayer-dithered, light at the top and dark at the bottom.
- **Idle (and only when completely idle):** bobs 1 px up and down over 2 s, stepped at 8 fps; the eyes float one
  beat behind the folder. There is no bob during talking, reactions or the pain glitch. Blinks every 2.5–6 s as half, closed, closed, half
  (~0.5 s), with a 15% chance of a double blink. The eyes never follow the cursor.
- **Paper inside:** only in the happy, shocked and proud moods.
- **Pain glitch:** ~0.8 s at 12 fps.
  - The sprite tears like a damaged JPEG: horizontal slices shifted 4–12 px, 8×8 blocks displaced, red channel
    smeared.
  - The eyes go to pain: squeezed shut `> <`, or one eye wide with a pinprick pupil and one squeezed.
  - It then snaps back with no easing and holds a 1 s wince before returning to idle.
- **Presence:** a fixed panel in every app window, never on the desktop. Like McZee in 3D Movie Maker, he belongs
  to each room; unlike McZee, he never walks around.
- **Previews:**
  - `docs/foldy-mockup.png`: moods and talking frames.
  - `docs/foldy-anim.gif`: idle, then talking, then the pain glitch.

## 6. Displace: the new step

How real recovered photos look, and why:
- **Wrap seam:** a body that starts K MCUs into the real stream; Huffman resyncs, and every MCU lands K places
  early. That wraps content to the next row and makes a vertical seam.
- **Cast:** DC predictors start at 0, so the region carries a constant offset.
- **Top strip:** up to 8 KB of stale cluster data is decoded as garbage rows.
- **Several shifts and a different photo at the bottom:** the run crosses into another photo's fragment.
- **Grey band at the bottom:** the MCUs lost at the start are missing at the end.

Step (byte layer, real bytes only, uses the MCU bit map):
- `shifts`: 1–4 shifts.
- Per shift: position (% of rows), lost/gained data (KB or MCUs), source (same photo or a pool photo).
- `seam_x`: computes the cut that puts the first seam where asked.
- `top_garbage_kb` (0–8).
- `foreign_bottom` (photo, from row %).
- `natural_cast` (on).
- `neutralise_markers` (on, so it never goes grey by accident).
- `drop_orientation`.
- "How bad?" scales the number of shifts, the lost data and the foreign share.

A test stack already gives this look (wrap seam, cast, top strip, foreign photo with its own seam). It is kept
locally as a reference, outside the repo.

## 7. Order of work

1. **Engine fixes:** grey presets, intensity units, the Displace step and preset, and a test that every preset is
   non-grey and intensity-responsive. Small, independent, fast win.
2. **XP shell rebuild:** window manager, controls, menus, context menus, message boxes, tooltips, scrollbars,
   dropdowns, cursors, desktop (grid, drag, rubber band), taskbar, Start menu, cartoon sky on its own layer.
   Each piece is checked side by side against XP screenshots at 1:1.
3. **Editor rebuild on the new shell:** a single editor; the compare fix; the no-flash live preview; context menus.
4. **Kept apps ported:** My Pictures, Removable Disk, Hex Doctor, Save As, Recycle Bin, Display, Help.
5. **Delete** the cut code.
6. **Performance pass and QA**, desktop and phone, against the budgets in §2 #15.
7. **Foldy** goes in when the user's art arrives.
