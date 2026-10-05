# File Refragmenter 98 Gold

An image editor for JPEG artifacts that runs entirely on your device. Nothing is uploaded. (Formerly JpegIt.)

File Refragmenter doesn't imitate damage. It runs your photo through a real JPEG encoder and a forgiving decoder written for
this project, then breaks the actual data at every level:

- **Pixels:** colour conversion and chroma subsampling.
- **Coefficients:** quantisation and frequency damage.
- **Bytes:** truncation, bit flips, desyncs, header grafts and transfer accidents.
- **Virtual SD card:** a simulated FAT16/FAT32/exFAT card where photos are shot, deleted, fragmented and
  overwritten, then recovered with PhotoRec-style, rebuild and undelete tools.

## Layout

| Path | What |
|---|---|
| `crates/codec` | JPEG codec (baseline + progressive), forgiving decoder, all pixel/coefficient/byte steps |
| `crates/card` | Virtual SD card: file systems, camera scenarios, carving tools, card and format steps |
| `crates/wasm` | WebAssembly bindings |
| `web` | The app (Vite + TypeScript): Windows 98-style desktop, step stack, Foldy, hex view, card window |
| `web/src/assets/foldy` | Foldy's sprite sheet (`foldy.png` + `foldy.json`; format at the top of `web/src/foldy/sheet.ts`) |
| `docs/WIN98_METRICS.md` | The Windows 98 colours and sizes the shell is built to |
| `docs/foldy-lines.xlsx` | Everything Foldy says; `npm run lines` (in `web/`) imports it |
| `docs/ENGINE_API.md` | Contract between the engine and the UI |
| `docs/STEP_IDS.md` | Every step id |

## Build

Requires Rust (with the `wasm32-unknown-unknown` target), `wasm-bindgen-cli` 0.2.100 and Node 20+.

```sh
cd web
npm install
npm run wasm     # builds the Rust engine into web/src/wasm/pkg
npm run dev      # local dev server
npm run build    # static site in web/dist (deploy to Cloudflare Pages)
```

On Windows, `server.bat` starts the dev server on port 5734 and `save.bat` commits (stamping the version) and
pushes.

Tests: `cargo test --workspace`, `cd web && npm run test:full` (builds the engine, then runs every preset through
it), and `node scripts/uicheck.mjs` (in `web/`, after `npm run build`: no native popups or system fonts, right-click menus
everywhere, all eight resize edges).

Hidden: Ctrl+Shift+F opens Foldy's timing panel.

## Privacy

The site ships with a Content-Security-Policy that blocks every network request except loading its own files.
Photos never leave the browser.

## License

Code: MIT or Apache-2.0, at your option. Bundled photos have their own licence (see `web/public/bundled/`).
