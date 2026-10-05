# Engine API contract (Rust/WASM ⇄ web)

This is the single source of truth between the three work streams:

| Stream | Owns |
|---|---|
| **Codec** | `crates/codec/**`, `crates/wasm/src/codec_api.rs` |
| **Card** | `crates/card/**`, `crates/wasm/src/card_api.rs` |
| **Web** | `web/**` |

`crates/codec/src/step.rs`, `crates/wasm/src/lib.rs` and this file are shared and frozen. Change them only with
coordination, and only additively.

Build: `npm run wasm` (in `web/`) runs `cargo build -p refragmenter-wasm --target wasm32-unknown-unknown --release`
then `wasm-bindgen --target web --out-dir web/src/wasm/pkg`. The web app loads the module **inside a Web Worker only**
(`web/src/engine/worker.ts`); the main thread talks to the worker through `web/src/engine/client.ts`.

## Core model

* The working representation of an image is always **JPEG bytes** (`Uint8Array`). Non-JPEG uploads are decoded by
  the browser (createImageBitmap → canvas → RGBA), downscaled to the chosen camera profile size (unless "keep
  original"), and encoded with `encode_rgba`. JPEG uploads keep their original bytes as step 0, downscaled only if
  the user asks (then re-encoded with `encode_like`).
* A **step** = JPEG bytes in → JPEG bytes out, `apply_step(id, paramsJson, input, seed, pool)`. Broken output is
  normal and expected; steps only throw for invalid parameters or completely unusable input (e.g. not a JPEG at all
  when the step needs to parse it). Steps that need to parse a broken input should be as forgiving as the decoder.
* Pixel- and coefficient-level steps decode, operate and re-encode **with the input's own settings** (quant tables,
  subsampling, Huffman tables, restart interval, progressive or not) unless the step changes them. If the input is too
  broken to read its header, they use the default profile.
* **Determinism:** same input + params + seed ⇒ identical bytes in every browser. Integer maths in codec paths, PCG32
  (`step::Pcg32`) for randomness, no HashMap iteration order, no float where it changes output bits.

## Shared entry points (`crates/wasm/src/lib.rs`)

```ts
catalog(): string                    // JSON StepInfo[] (see crates/codec/src/step.rs for the exact shape)
apply_step(id: string, paramsJson: string, input: Uint8Array, seed: number /*u32*/, pool: Uint8Array[]): Uint8Array  // throws string
```

StepInfo JSON shape:
```ts
{ id, label, group, layer: "pixel"|"coeff"|"byte"|"card"|"meta", expert: boolean, random: boolean,
  uses_pool: boolean, simulated: boolean, help: string,
  params: Array<{ id, label, kind: "int"|"float"|"bool"|"enum"|"photo"|"table"|"text"|"mask",
                  min?, max?, step?, options?: [value,label][], default: any, expert: boolean, hint: string }> }
```
`photo` params hold a pool index; -1 means "the next pool photo after the current one" (wraps). The UI passes
`pool` = every pool photo's current bytes **except** the image being edited, in pool order, and rewrites photo
indices accordingly. `mask` value: `{ w, h, data: number[] }` in MCU units, 0..255.

## Codec bindings (`codec_api.rs`)

```ts
// Forgiving decode. Never throws for damaged data; returns at least a grey image if the header is unusable
// but dimensions can be guessed, else throws "unreadable".
decode(input: Uint8Array, optsJson: string): Decoded
//   opts: { personality?: "libjpeg"|"gdiplus" ("browser" is read as libjpeg), fill?: "grey"|"repeat"|"black"|"donor",
//           fancy_upsampling?: boolean, max_dim?: number /* downscaled preview, nearest/box */ }
class Decoded { width: number; height: number; rgba(): Uint8Array; events_json(): string; free(): void }
//   events: [{ kind: "truncated"|"bad_marker"|"resync"|"rst_missing"|"dc_jump"|"fill"|"bad_huffman"|"eoi_early"|"header_repaired"|...,
//              mcu: number, byte: number, detail: string,
//              scan: number, comp: number, x: number, y: number }]  — used by the Inspector and by Foldy.
//   mcu = MCU index within the scan (single-component scans: block index of that component), -1 = header-level.
//   (additive) scan = 0-based scan number (-1 outside scans); comp = 0-based component for single-component
//   scans (-1 otherwise); x/y = top-left pixel of the MCU/block in the image (-1 when not tied to a position).
//   Other kinds that can appear: "extra_data", "bogus_progression", "unsupported" (12-bit / lossless),
//   "arithmetic" (info: file is arithmetic-coded, which browsers can't open), "bad_code" (arithmetic decoder
//   hit an impossible value; rest of the restart interval skipped). "resync" is also emitted where picture data
//   resumes after a grey gap; the first invalid Huffman code gets its own "bad_huffman" event with mcu/byte
//   (plus the per-scan summary with mcu -1). dc_jump is reported for sequential and progressive DC scans.
//   Arithmetic-coded (SOF9/SOF10) JPEGs decode bit-exactly like libjpeg-turbo, including damaged files;
//   12-bit files are decoded as 8-bit (event "unsupported"); lossless JPEG stays grey.

decode_with_donor(input: Uint8Array, optsJson: string, donor: Uint8Array): Decoded
//   Same as decode, but `fill: "donor"` paints blocks that never got data with `donor` (any JPEG, decoded and
//   stretched nearest-neighbour to this image's size). Empty donor = same as decode.

encode_rgba(width: number, height: number, rgba: Uint8Array, optsJson: string): Uint8Array
//   opts: { profile?: string /* profile id */, quality?: 1..100, subsampling?: "444"|"422"|"420"|"411"|"440",
//           progressive?: boolean, restart_interval?: number, optimize_huffman?: boolean, keep_exif_from?: never }
encode_like(width: number, height: number, rgba: Uint8Array, like: Uint8Array): Uint8Array  // copy tables/subsampling/etc from a JPEG
profiles(): string     // JSON [{ id, label, kind: "camera"|"phone"|"app"|"generic", year?, width, height, quality_note }]
inspect(input: Uint8Array): string
//   JSON { size, segments: [{ offset, length, marker: number, name, summary }], frame?: { width, height, progressive,
//          components: [{ id, h, v, tq }] }, restart_interval, scans: [{ offset, length, components, ss, se, ah, al }],
//          qtables: [{ id, values: number[64] }], exif?: { ...flat key/values }, eoi_offset?: number, trailing_bytes: number }
mcu_map(input: Uint8Array): Uint32Array
//   Forgiving decode pass; for each MCU (raster order) the BIT offset in the file where it starts, 0xFFFFFFFF if never
//   reached. Also exposes mcu grid size via inspect().frame. Used for click-block ⇄ hex linking.
coeff_heatmap(input: Uint8Array, component: number, mode: string): Float32Array
//   One value per 8x8 block of that component: mode "energy" (AC energy), "dc", "zeros" (count of zeroed coefficients),
//   "bits" (bits spent). Grid = component block dims (from inspect).
strip_private_exif(input: Uint8Array): Uint8Array  // removes GPS, serials, owner names; keeps orientation
// Animation / video containers:
encode_gif(width: number, height: number, frames: Uint8Array[] /*rgba*/, delayCs: number): Uint8Array
avi_write(jpegFrames: Uint8Array[], width: number, height: number, fps: number): Uint8Array   // MJPEG AVI
avi_read(avi: Uint8Array): string   // JSON { width, height, fps, frames: number } ; frames via avi_frame
avi_frame(avi: Uint8Array, index: number): Uint8Array   // the JPEG of frame i (DHT inserted if missing)
```

## Card bindings (`card_api.rs`)

```ts
card_presets(): string   // JSON [{ id, label, fs: "fat16"|"fat32"|"exfat", size_mb, cluster_kb, camera, description }]
card_events(): string    // JSON catalogue of scenario event types with params (same ParamInfo shape)
class Card {
  // scenario: { fs, size_mb, cluster_kb?, camera: "canon2004"|"phone"|"generic",
  //             events: [{ type: "shoot"|"delete"|"quick_format"|"reformat_pc"|"power_loss"|"chkdsk"|"os_junk"|
  //                       "burst"|"flash_fault"|"overwrite"|"video"|..., ...params }] }
  // photos: JPEG bytes, used in order by "shoot" events (cycled if more shots than photos).
  // scenario.camera_thumbs (default true): like a real DCF camera, photos without an EXIF thumbnail get a
  //   160x120 one before being written (false = write the bytes exactly as given).
  // Event types (see card_events() for params): shoot, burst, video (MJPEG AVI + .THM), delete, power_cycle,
  //   advance, quick_format, reformat_pc, power_loss, chkdsk (FOUND.000\FILEnnnn.CHK), fat_glitch,
  //   os_junk (System Volume Information, ._ files, and a real Thumbs.db compound file with 96 px JPEG
  //   thumbnails; param thumbs_of: "all"|"live"), flash_fault, overwrite (new shots into the first free
  //   clusters, i.e. over deleted photos; the log says which deleted file lost how many clusters).
  static simulate(scenarioJson: string, photos: Uint8Array[], seed: number): Card
  info_json(): string        // { fs, size_bytes, cluster_bytes, cluster_count, data_start, files: [{ name, first_cluster, size, deleted, photo_index }], log: string[] }
  cluster_map(): Uint8Array  // one byte per cluster: 0 free, 1 fs metadata, 2 live file, 3 deleted file, 4 overwritten, 5 damaged, 6 video, 7 junk
  cluster_owner(): Int32Array // photo/file index occupying each cluster (-1 none)
  carve(methodJson: string): string
  //   method: { tool: "photorec"|"graft"|"recuva"|"thumbnails"|"undelete_contiguous", ... }
  //   returns JSON [{ index, name, size, source_clusters: number[], note }]
  //   "thumbnails" notes: "embedded EXIF thumbnail" | "small JPEG file (.THM sidecar)" |
  //   "thumbnail from a Windows Thumbs.db cache" | "MJPEG movie frame (no Huffman tables; standard ones inserted)"
  recovered(index: number): Uint8Array
  image_size(): number
  image_chunk(offset: number, length: number): Uint8Array   // stream the raw .img for download
  free(): void
}
```

Card/format steps (`pass_through_card`, `thumbcache`, `heic_tiles`, `raw_preview`, etc.) appear in `catalog()` like any
other step.
