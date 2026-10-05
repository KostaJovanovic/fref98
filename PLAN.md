# File Refragmenter 98 Gold (formerly JpegIt) — Plan

In-browser image editor specialised in JPEG artifacts. Artifacts are produced by actually running the image
through the JPEG pipeline and damaging the real data (pixels, coefficients, bytes, filesystem), not by
simulating the look. Everything runs on device; nothing is uploaded.

Status (2026-10-05): v2 built (v0.18). The revision in `REVISION.md` is done: Windows 98 shell, Displace step,
no grey presets, Foldy machinery. The v1 notes below are kept as the record.

Status (2026-10-04): v1 built.
- Engine:
  - Codec plus 45 codec steps.
  - Card crate plus 14 card/format steps.
  - WASM bindings.
- Web app: XP-style desktop, editor, Foldy, Hex Doctor, Disk Doctor, export, webcam, video and PWA.
- Open items:
  - The user's bundled photos (placeholders until then).
  - Deploying to Cloudflare Pages.
  - The remaining review questions, which use their defaults for now.

## Guiding principle (overrides everything else)

**Easy to use and user-friendly, on desktop and on mobile.** When a theme, scope or technical decision makes the
app harder to use, the decision gives way. The retro look is the costume, never the obstacle.

Theme decisions this constrains:
- **Text size.** Pixel fonts are drawn at whole-step sizes (2× by default on phones), never below a readable size. Touch targets are at least 44 px.
- **Phones.** No overlapping windows. Each window is a full-screen sheet, and the taskbar becomes a bottom tab bar. Dragging is optional, never required.
- **Cursors and dithering** never hide what is clickable. Buttons, sliders and focus states are clear at a glance.
- **Fake period details are flavour only:**
  - "(Not Responding)" and the fake progress dialogs never block input or hide real progress. There is always a Cancel button.
  - Foldy's glitches never affect help text the user asked for. He never covers controls, and a single click hides him.
- **First run:** drop a photo, choose a preset, see the result, export. Everything else is optional depth.
- **Expert features** (hex view, card timeline, quantisation tables) stay behind "Show me how" / expert mode and never clutter the simple path.
- **Testing:** usability checks on a real phone and a desktop at the end of every phase, not only at the end.

## Reference material

A private set of real recovered SD-card photos (local test material only, never committed).
Artifacts observed in them, and their real causes:

| Artifact | Cause |
|---|---|
| Flat grey below a point | Truncated data; decoder fills missing blocks with zero coefficients = mid-grey (128). |
| Whole-image pastel pink/green/cyan casts | Body starts mid-stream; each component's DC predictor starts at the wrong value and stays off. |
| Sideways wrap with a vertical seam | Decoding starts mid-MCU-row, so everything shifts and wraps. |
| Thin garbage strips at the top | Leftover bytes from the previous file before the decoder resyncs. |
| Colour shift partway down | Bit-flip / marker neutralisation (header-graft recovery) knocks the decoder into a new DC offset. |
| Wrong tables, odd contrast | Header graft: body decoded with another photo's DQT/DHT/SOF. |
| Two scenes in one frame | Clusters from a neighbouring file carved into the body. |

Some small files (~9 KB each) don't open at all (likely broken headers), a good test case.

## Decisions

- **Audience:** artists and nerds equally, so there is a simple mode and an expert mode.
- **Workflow:** a reorderable, non-destructive step stack. It must support bringing in other photos.
- **Codec:** our own, written in Rust and compiled to WASM.
- **Photo pool:** user uploads plus a bundled set. The user supplies the bundled photos.
- **Output:** a single image and a whole "recovered card" (contact sheet + ZIP).
- **Preview decoder:** our forgiving decoder by default, with a switch to see the browser's own rendering.
- **v1 scope:**
  - Encoding stages
  - Bitstream damage
  - Virtual SD card carving
  - Hex view and inspection
- **Card simulation:**
  - FAT16, FAT32 and exFAT
  - Overwrite and quick-format scenarios
- **Encoder profiles:** real cameras, phones and apps.
- **Extras:**
  - Animated generation loss
  - Motion JPEG / AVI
  - Live webcam
  - EXIF/metadata damage
- **Style:** retro 2000s (Windows XP / digicam software).
- **Targets:** desktop and mobile equally easy to use (replaces the earlier "desktop first, usable on phones"), up to about 24 MP.
- **Hosting:** open source, on Cloudflare Pages.

## Theme: 2000s

**Look.** An XP-style shell (rounded blue title bars, green start button, balloon tooltips, taskbar). The About, Help and preset-gallery pages get Y2K web touches: tiled backgrounds, animated GIFs, marquees, "under construction". All art is original; no Microsoft assets (Bliss, Tahoma, icons).

**No antialiasing anywhere. Everything is pixel-exact.**
- **Fonts:** bitmap pixel fonts at fixed sizes. CSS can't turn off ClearType for vector fonts on Windows, so we use fonts whose outlines sit on the pixel grid, or draw text from a glyph atlas.
- **Scaling:** nearest-neighbour everywhere (`image-rendering: pixelated`).
- **Colour:** 256 colours, dithered (the one exception: the smooth 98 caption gradient of title bars and the Start banner, as 98 draws it on 16-bit displays).
- **Cursors:** 1-bit pixel cursors, including an hourglass.
- **UI scale:** whole steps only (1×/2×/3×). We correct for Windows display scaling (125%/150%) so each UI pixel maps to whole screen pixels.

**Dithering is the overall art style.**
- **Palette:** one fixed 256-colour palette (web-safe 216 plus the Windows 98/VGA colours, greys, icon manilas and sky blues). Every UI element is dithered into it.
- **Methods, chosen by purpose:**
  - **Ordered Bayer** for the sky, the wizard panel and the dissolves.
  - **Majority snap to the VGA colours** for icons (drawn 4× and voted down); **Atkinson** for photo thumbnails.
  - **Checkerboard "screen-door"** instead of transparency.
- **Shadows and transparency:** window and menu shadows and Foldy's speech balloon use checkerboard dithers. No alpha blending.
- **Animations and fades:** window open, close and minimise, and screensaver fades, step through dither patterns rather than alpha.
- **Progress and busy states:** a dithered fill sweeps across progress bars, and busy windows get a dithered wash.
- **Thumbnails and icons:** pool photos shown as desktop icons and thumbnails are dithered to the UI palette.
- **Never dithered:** the editor preview of the user's image. It always shows the true decoded pixels so the artifacts stay exact.
- **Implementation:** UI art is pre-dithered at build time. Live elements (the sky, thumbnails, fades) are dithered at runtime in a worker or shader, on the pixel grid.

**Desktop.**
- A fake desktop over a blue sky with clouds.
- Icons:
  - "Removable Disk (E:)" opens the Card project.
  - "My Pictures" opens the photo pool.
  - Also: Recycle Bin, presets, help.
- Tools are draggable windows, with a taskbar and system tray.
- On phones every window opens maximised, and the taskbar becomes a window switcher.

**Sky background.**
- Clouds drift at a deliberately low frame rate (about 8 fps), moving in whole-pixel steps, as parallax layers.
- The sky is itself a low-quality JPEG made by our own codec, so blocks and banding are visible.
- During long operations it gets more damaged, and it recovers afterwards.
- It stops moving when `prefers-reduced-motion` is set.

**Mascot.**
- A small folder with eyes, like an original Clippy.
- It "talks" by opening and closing its lid slightly in time with the text appearing in its speech balloon.
- It is the explain mode: "Why is it pink?", tips, and comments on presets.
- It can be dismissed or turned off.
- **Name:** Foldy.
- **Personality:** helpful and loves explaining.
- **Glitches:**
  - **Nonsense:** sometimes he blurts out complete nonsense.
  - **Jumbled words:** sometimes his words are typed out in a jumbled order. Once the sentence finishes typing, the words glitch into their correct places.
  - These glitches only affect presentation. Explanations always end up readable and correct.
- **Reactions:** worried during long carves, shocked at heavy damage, asleep when idle, and more.

**Desktop extras.**
- **Tray clock.**
- **Working Start menu:** tools, presets, recent projects, help, "Shut Down…" (clears the session).
- **Recycle Bin:** holds deleted stack steps, pool photos and projects; they can be restored or emptied.
- **Display Properties dialog:** wallpaper choice (sky, solid colours, tiles, the user's own JPEG-damaged image) and cloud speed.
- **Screensaver** after inactivity (e.g. a JPEG-damaged starfield or flying folders), with a timeout setting and an off switch.

**Foldy's glitches.**
- **Frequency:** not often, but noticeable.
- **Nonsense source:** both a hand-written list of lines and lines generated from JPEG jargon.
- **Visual glitch:** his sprite glitches while he talks nonsense (8×8 block shifts, colour casts, his lid snapping into the wrong position).
- **On purpose:** clicking him repeatedly makes him glitch. Dragging him onto images does not.

**Fake progress dialogs.**
- Block-style progress bars.
- Messages like "Recovering file 23 of 166…" and "Scanning cluster 41 812…", with the hourglass cursor.
- "(Not Responding)" briefly appears in the title on long runs. The UI must stay responsive regardless: the work runs in Web Workers.

**No sounds.**

## Architecture

- **Rust → WASM codec running in Web Workers.**
  - Supports baseline and progressive JPEG.
  - Keeps all intermediate data:
    - RGB
    - YCbCr planes before and after subsampling
    - DCT coefficients before and after quantisation
    - the entropy-coded bytes, with a map from each 8×8 block / MCU to its byte and bit offset.
- **Forgiving decoder.**
  - Never throws. It fills missing data, keeps going after bad markers and carries DC offsets forward.
  - Tuned until it reproduces the private reference recoveries from the same inputs.
- **Step stack.**
  - An ordered list of steps, each typed as pixel, coefficient or byte. The engine re-encodes or decodes between them automatically.
  - Results are cached at each step, so editing step N only recomputes from step N on.
  - Every random step has its own seed.
- **Photo pool.**
  - Any step can use another pool photo as a source, a header donor, or a neighbour on the card.
- **Front end.**
  - Vite + TypeScript, retro XP-era UI, desktop-first with a simplified phone layout.
- **Privacy.**
  - Offline-installable PWA with a Content Security Policy that blocks all network requests.

## Features

### A. Encoding stages (real compression)
1. **Colour conversion:**
   - correct YCbCr
   - wrong matrix (BT.601 vs BT.709)
   - RGB stored as YCbCr
   - Adobe APP14 transform flag flipped (CMYK/RGB confusion)
2. **Chroma subsampling:**
   - 4:4:4 / 4:2:2 / 4:2:0 / 4:1:1 / 4:4:0
   - nearest vs smooth ("fancy") upsampling
   - chroma planes shifted out of alignment
   - repeated colour bleed
3. **Quantisation:**
   - quality slider
   - paintable 8×8 table editor for each channel
   - killing chosen frequencies
   - swapping the luma and chroma tables
   - encoding with one table and decoding with another
4. **Generation loss:**
   - re-save N times
   - shifts, crops, resizes or quality changes between saves, which move the grid and make the damage worse
5. **Progressive JPEG cut off partway:** only the early, blurry, blocky passes survive.
6. **Painted regions:** a brush that zeroes or exaggerates coefficients.
7. **Camera/app profiles and "encode like this photo":**
   - quantisation tables, subsampling and quirks taken from real cameras, phones and apps (WhatsApp, Facebook, Instagram)
   - or copied from any uploaded JPEG

### B. Bitstream damage and recovery
8. **Truncation** at a byte or a percentage. Fill with grey, repeat the last row, or copy how a specific viewer shows it.
9. **Byte damage** by position or rate:
   - bit flips
   - byte deletion and insertion (these produce the shifts and colour casts)
   - fake markers
10. **Header graft / mixing:**
    - one photo's header (tables and size) with another photo's body
    - different dimensions give shear and wraparound
11. **Wrong SOF dimensions** (diagonal skew).
12. **Colour channel damage:**
    - swap Cb and Cr
    - drop a channel
    - offset a channel's DC predictor (tints)
13. **Restart markers (DRI) on or off:** with them on, damage stays in horizontal strips.
14. **Byte-level splicing:** insert or replace runs of clusters (4/8/32 KB) from other pool photos.

### C. Virtual SD card
15. **Real filesystem images:** FAT16, FAT32 and exFAT, with a real boot sector, FAT table and directory entries.
16. **Writing the roll:** photos are written in shooting order.
17. **Scenarios:**
    - delete
    - quick-format
    - new shots overwriting deleted ones
    - fragmentation
18. **Carving:**
    - PhotoRec-style carving
    - header-graft-style rebuilding (donor header, splitting at EOI, neutralising markers)
    - recovering only the EXIF thumbnail
19. **Output:** cluster-map view, contact sheet, ZIP of the "Rebuilt" folder.

### D. Inspection
20. **Hex view** of the compressed data, linked both ways to the image (click a block to jump to its bytes). Live byte editing.
21. **Overlays:**
    - 8×8 / 16×16 block grids
    - coefficient heatmaps
    - before/after split

### E. Workflow and output
22. **Step stack:** reorderable, with per-step seeds and a dice button.
23. **Presets:**
    - "Dead SD card"
    - "Forwarded 40× on WhatsApp"
    - "2004 digicam"
    - "PhotoRec carve"
    - "Bad header graft"
24. **Export:**
    - the actual broken .jpg (other viewers render it differently)
    - a PNG of the preview
    - batch export
    - the recipe as JSON

### B2. More recovery scenarios (all in v1)

**Card and filesystem**
29. **Interleaved files:** burst shooting, or JPEG+RAW / JPEG+THM written at the same time. Clusters alternate between files, giving bands that switch between two photos.
30. **Cross-linked clusters** (after chkdsk): two photos share an identical middle band.
31. **Repeated or stuck reads:** a cluster is read twice, giving a band that repeats with a colour jump.
32. **Dropped 512-byte sectors:** many small shifts and colour drifts.
33. **Zero-filled runs** (TRIM, ddrescue): smeared, repeating flat blocks, distinct from 0xFF fill.
34. **Recovery-tool fill patterns:** e.g. "BAD SECTOR" text decoded as image data.
35. **Chip-off dumps without descrambling:** periodic XOR noise, pages out of order.

**Inside the JPEG**
36. **Progressive file missing its DC scan:** detail passes only, giving an embossed, edges-only ghost on grey.
37. **Restart-marker strip loss:** the decoder either shifts later strips up (image gets shorter) or places them by RST number (gaps).
38. **MJPEG/AVI frames carved as photos:** frames without DHT tables; the carver fails or inserts standard tables.
39. **Multi-picture JPEG parts carved separately:** Ultra HDR gain map, depth map or MPF preview, giving a grey ghost image.
40. **Lost or wrong ICC profile:** e.g. Adobe RGB shown as sRGB looks dull and desaturated.

**Other formats**
41. **RAW recovery:** only the embedded preview JPEG, or RAW data decoded as JPEG (Bayer garbage).
42. **Thumbnail caches** (thumbs.db, thumbcache, Android .thumbnails, iOS): tiny previews upscaled, with padding bars.
43. **Tiled HEIC partial recovery:** missing 512×512 tiles.

**Damage from people and repair tools**
44. **Partial ransomware encryption:** the first N KB is noise and the body is intact (a rescue by header graft).
45. **Byte-swapped dumps:** 16-bit endianness errors.
46. **"Repair" tool emulation:** DC re-estimation leaves stepped colour bands, average-colour patches, mismatched regions.

### F. Extras
25. **EXIF/metadata damage:**
    - wrong orientation
    - embedded thumbnail that doesn't match the main image
    - broken EXIF
26. **Animated generation loss** (GIF/MP4).
27. **Motion JPEG / AVI** damaged frame by frame.
28. **Live webcam** with effects in real time.

## Phases

1. **Codec core.**
   - Rust encoder, decoder and forgiving decoder.
   - Checked against libjpeg on clean files and against the private reference photos on broken ones.
2. **Editor shell.**
   - Retro UI, step stack, before/after split, block-grid overlay.
   - Simple and expert modes.
   - Export.
3. **Encoding steps:** A1–A7.
4. **Byte damage:** B8–B14.
   - Also the JPEG-internal and repair-tool scenarios: B2 36–40, 44–46.
5. **Virtual SD card:** C15–C19.
   - Also the card/filesystem scenarios: B2 29–35.
   - Also the other-format scenarios: B2 41–43 (RAW, thumbnail caches, HEIC tiles; these need small non-JPEG parsers).
6. **Hex view and inspection:** D20–D21.
7. **Extras:** F25–F28.

## Open questions

- **Name:** keep "JpegIt"?
- **Bundled photos:** how many? Recognisable "roll mates" or anonymous filler?
- **Camera profiles:** which cameras or phones matter most?
- **Mockups:** rough retro UI sketches before phase 2?

## Answered review questions

- **Q1 First release:** ship only when everything in the v1 scope is done (encoding, byte damage, card, hex/inspection).
- **Q11 Card model:** a separate "Card project" workspace with "Open in editor" on recovered files, plus a "Pass through card" step in the single-image stack.
- **Q24 Resolution:** import at the camera profile's size (e.g. 2272×1704 for the IXUS 400) by default, with a "keep original" toggle.
- **Q46 Transfer damage:** in v1 (FTP ASCII, 7-bit mail, broken base64, interrupted download, MMS recompression).

## Review questions (from plan review; others unanswered)

Suggested defaults are in *italics*.

The reference material is private: real people's photos, used locally only.

### A. Scope and phasing
1. What does the first public release include?
   *Phases 1–3 plus truncation and bit flips (B8/B9); then the card, then the hex view.*
2. Are the extras (F) in v1?
   *Animated generation loss yes (it reuses the re-save loop); AVI and webcam after v1.*
3. Can users load their own real card images (.img/.dd), which would make JpegIt a real recovery tool?
   *Not in v1; later, read them in slices rather than loading the whole file.*

### B. Codec and fidelity
4. Is "matches libjpeg" bit-exact? Which IDCT and upsampler is the reference? What counts as "reproduces the reference recoveries"?
   *Bit-exact against libjpeg-turbo islow with fancy upsampling on clean files. On broken files, the same structural events (grey-start MCU, DC offsets, wrap column) plus a PSNR threshold.*
5. Which viewers' handling of broken files should we emulate?
   *Two "decoder personalities": libjpeg-turbo and Windows GDI+/WIC. (A third, "browser-style grey fill", decoded exactly like libjpeg and was dropped in v0.24; the editor's three-way compare shows the real browser instead.)*
6. Which JPEG variants are in scope (arithmetic coding, 12-bit, lossless, CMYK)?
   *The decoder forgivingly handles CMYK/YCCK and arithmetic coding; the encoder writes 8-bit baseline and progressive Huffman only (`encoder::write_arith` makes arithmetic-coded files for the decoder's tests and the dev example, never for the app).*
7. Which Huffman tables do we encode with?
   *The profile's tables, falling back to the standard Annex K ones.*
8. What is the determinism contract?
   *Identical output across browsers (integer maths, PCG32); recipes store the engine version.*
9. Do JPEG inputs keep their original bytes as step 0? What about HEIC, RAW and AVIF?
   *Keep the original bytes. Other formats are decoded by the browser, then encoded with the chosen profile. No RAW.*

### C. Step-stack model
10. Is the stack a linear list or a graph? Can donor photos have their own steps?
    *A linear main stack; each pool photo gets an optional one-level stack.*
11. Where does the card fit?
    *A separate "Card project" workspace with "Open in editor" for any recovered file, plus a single-image step "Pass through card".*
12. When a pixel step follows a byte step, which settings are used for the hidden re-encode?
    *The most recent encode settings and the forgiving decoder; each automatic re-encode shows as a visible marker in the stack.*
13. What happens to painted masks and hex edits when earlier steps change?
    *Masks are stored in MCU coordinates and clipped. Hex patches are marked "stale", never silently reapplied.*
14. Should there be a generic "Repeat N times" group step?
    *Yes, and the generation-loss preset is built from it.*
15. Undo and history?
    *Unlimited undo, slider drags merged into one step, and pinned snapshots for A/B comparison.*
16. What is the project save format?
    *A `.jpegit` ZIP (recipe + pool photos), autosave to OPFS/IndexedDB, and plain JSON only when the recipe uses bundled photos alone.*

### D. Virtual SD card
17. Card sizes and memory?
    *A sparse cluster store that keeps only written clusters. Presets: 32 MB FAT16, 512 MB FAT16, 8 GB FAT32, 64 GB exFAT.*
18. Can users download the simulated .img to run real PhotoRec on it?
    *Yes, in expert mode.*
19. How detailed is the camera model (DCIM naming, .THM files, allocation policy, 0xE5 deletion marks)?
    *Part of each camera profile. v1: a 2004 Canon, a modern phone, a generic camera.*
20. Card scenarios as presets or a timeline? Should we add power loss, chkdsk FOUND.000, reformatting on a PC, and OS junk files?
    *Presets in simple mode, a timeline in expert mode. Power loss, chkdsk and PC reformat in v1.*
21. Should we emulate undelete tools like Recuva (start cluster + size, assumed contiguous), the main cause of "the bottom half is another photo"?
    *Yes.*
22. Should cards contain MJPEG AVIs that fragment the photos and can be carved?
    *Yes, once the AVI code exists.*
23. Should we add flash-memory faults (0xFF erased pages, page-sized bursts, stuck bits)?
    *Yes, as a "Flash fault" step.*

### E. Performance and devices
24. Native resolution or a smaller "camera size"? (8×8 blocks vanish when a 24 MP image is shrunk to fit the screen.)
    *Import at the profile's size (about 3–4 MP), with a "keep original" toggle and a 1:1 zoom.*
25. Memory budget?
    *1 GB on desktop and 400 MB on phones, an LRU cache for step results, and phones warn above 12 MP.*
26. Latency targets? WASM threads (which need COOP/COEP headers)?
    *Under 150 ms for a 4 MP preview. Threads + SIMD with headers set via `_headers`, falling back to a single thread.*
27. Minimum browsers?
    *The last two versions of the major browsers, iOS 16.4 or later, SIMD required.*
28. Webcam resolution, frame rate and allowed steps?
    *640×480 at 15 fps or better, only cheap steps, recording to MJPEG AVI.*

### F. Privacy, licensing, open source
29. What licence and consent apply to the bundled photos (no faces or IDs without consent)?
    *CC0/CC-BY, licensed separately from the code, in a separate assets folder.*
30. Is a private local test suite against the reference photos plus public synthetic tests acceptable?
    *Yes. Publish only derived expectations, never the images.*
31. Which code licence?
    *MIT or Apache-2.0. Camera tables are measured ourselves, not taken from JPEGsnoop (GPL).*
32. Strip GPS, serial number and owner EXIF from exports by default?
    *Yes.*
33. Embed the recipe in exported files?
    *Opt-in, off by default.*
34. Zero telemetry?
    *Yes, with a "Network: blocked" badge. The CSP needs `wasm-unsafe-eval`.*
35. Download budget?
    *App + WASM under 3 MB gzipped. Bundled photos at most 8 MB each and 40 MB total, cached lazily.*

### G. UI and modes
36. What exactly is simple mode?
    *A story picker ("what happened, how bad") that builds a real stack, plus a "Show me how" button that opens it in expert mode.*
37. Retro look vs Microsoft trademarks?
    *An original XP-like homage with no Microsoft assets, and window names like "Disk Doctor" and "Camera Wizard".*
38. Accessibility?
    *100–200% UI scale, keyboard control of the stack, ARIA labels, a high-contrast "Classic grey" theme, reduced motion.*
39. Which features exist on phones?
    *Presets, the stack, before/after, export. Read-only hex view. Card mode with presets only.*
40. Languages?
    *English, ready for translation; Serbian next.*
41. Should the browser-rendering switch become a three-way split (ours | browser | emulated viewer)?
    *A three-way split in expert mode.*

### H. Export and sharing
42. Sharing without a server?
    *Recipes in the URL fragment (bundled photos only) and Web Share.*
43. Animated export formats?
    *GIF and MJPEG AVI from WASM, plus MP4 via WebCodecs where available.*
44. Batch export?
    *One recipe with seed = base + index, output as a ZIP with IMG_0001.JPG-style names.*
45. Contact-sheet styles?
    *The recovery-script layout, an XP "Thumbnails" view, and a Kodak-style index print.*

### I. New feature proposals
46. Should we add a "Transfer damage" group: FTP ASCII mode (LF→CRLF), 7-bit mail, a broken base64 line, an interrupted progressive download, MMS recompression?
    *Yes.*
47. Should there be a "Sensor" group (noise, oversharpening, purple fringing, date stamp), clearly labelled as simulated?
    *Yes, small and labelled.*
48. Explain mode ("Why is it pink?" tooltips, a block inspector showing the DC prediction chain)?
    *Yes, in expert mode.*
49. A "Diagnose" mode for real broken JPEGs?
    *After v1, but the forgiving decoder logs events (resyncs, bad markers, fills) from day one.*
50. Monetisation and accounts?
    *Free, no accounts, a donation link in the About box.*
