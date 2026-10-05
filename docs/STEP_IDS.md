# Step ids (frozen names; presets and recipes reference these)

The owning crate implements each step and documents its params in `catalog()`. The web app builds presets from these
ids, and must read param ids and defaults from `catalog()` at runtime, not hard-code them. The param names below are
the suggested core params. The implementing stream may add more, but must keep these.

## Codec crate

| id | group | what it does (real process) | core params |
|---|---|---|---|
| `requantize` | Quantise | Re-encode at a quality / with custom tables | quality, luma_table?, chroma_table?, swap_tables |
| `qtable_decode_swap` | Quantise | Rewrite DQT only (data untouched), so the decoder dequantises with wrong tables | mode (scale/swap/table), factor |
| `coeff_kill` | Quantise | Zero chosen zigzag frequency range per component | from, to, component |
| `coeff_paint` | Quantise | Masked zero / boost / harsher quantisation of coefficients | mask, mode, strength |
| `color_matrix` | Colour | Encode/decode colour conversion errors | mode: bt709_mismatch / rgb_as_ycc / ycc_as_rgb / adobe_flag_flip |
| `channel_drop` | Colour | Zero or flatten a component's coefficients | component, mode |
| `cbcr_swap` | Header | Swap component ids in SOF/SOS so Cb and Cr trade places | — |
| `chroma_subsample` | Chroma | Re-encode with subsampling, upsampling method, chroma plane offset, repeated passes | mode, upsampling, shift_x, shift_y, passes |
| `resave` | Generation | N generations with jitter (shift, crop, resize, quality, subsampling, profile) | generations, quality, quality_jitter, shift, crop, resize |
| `reencode_profile` | Encode | Encode like a camera/app profile (incl. its size limit) | profile |
| `encode_like_photo` | Encode | Encode with another pool photo's tables/subsampling | photo |
| `progressive_cut` | Progressive | Keep only the first N scans of a progressive encode | scans |
| `progressive_drop_dc` | Progressive | Remove the DC scan(s): AC-only ghost image | — |
| `truncate` | Bytes | Cut the file at a byte / percent | percent |
| `bitflip` | Bytes | Flip random bits in a region of the scan data | rate (flips per 100 KB of scan data, 0.1..200, default 3; at least one flip), start, end |
| `byte_delete` | Bytes | Delete bytes (desync, horizontal shift, DC drift) | count, start, end |
| `byte_insert` | Bytes | Insert random or given bytes | count, start, end, hex |
| `fake_marker` | Bytes | Inject markers (EOI, RSTn, SOS…) into scan data | marker, count |
| `dc_offset` | Bytes | Offset a component's DC predictor from an MCU onward (tint) | component, amount, at |
| `restart_markers` | Bytes | Re-encode with/without a DRI restart interval | interval |
| `rst_strip_loss` | Bytes | Lose restart intervals; decoder collapses strips up or keeps gaps | count, behaviour |
| `zero_run` | Bytes | Zero-filled runs (TRIM / ddrescue) | count, length |
| `byte_swap16` | Bytes | Swap every byte pair in a region (16-bit endian dump) | start, end |
| `splice` | Bytes | Insert/replace cluster-sized runs from another photo's scan data | photo, at, clusters, cluster_kb, mode |
| `header_graft` | Header | Decode this body with a donor photo's header. photo -1 prefers a pool photo with the same frame size and DQT/DHT. skip counts from the body start, or from byte 0 when the input's own header is destroyed | photo, skip, keep_exif, neutralise_markers (bool, default true) |
| `sof_dims` | Header | Lie about width/height in SOF | width (0 = unused), height, width_delta (int -256..256, default 16), height_delta |
| `huffman_swap` | Header | Replace DHT with another photo's or standard tables | photo |
| `ftp_ascii` | Transfer | LF→CRLF conversion (and/or CRLF→LF), whole file or a seed-placed stretch of the scan data | direction, portion (0.02..1, default 1 = whole file) |
| `seven_bit` | Transfer | High bit stripped (7-bit mail gateway) | start |
| `base64_damage` | Transfer | Base64-encode, damage/drop a line, decode | lines |
| `interrupted_download` | Transfer | Stop the transfer at a point | percent |
| `mms_recompress` | Transfer | MMS-style shrink + harsh recompress | size_kb |
| `ransomware_partial` | Recovery | Encrypt the first N KB with a stream cipher | kb |
| `displace` | Recovery | Bad carve: body spliced K MCUs early (wrap seam at seam_x), stale data decoded on top, later lost clusters add seams, DC predictor carry-over gives a cast per cut, optional run into another photo; the file is really cut where the data runs out | shifts 1..4, lost_kb -16..64, seam_x 0..1, first_row 0..0.9 (0 = auto), top_garbage_kb 0..8, foreign_from 0..1 (1 = none), foreign_photo, natural_cast, neutralise_markers, drop_orientation |
| `repair_tool` | Recovery | Commercial repair emulation: estimate DC per segment, patch gaps | strength |
| `mjpeg_no_dht` | Recovery | MJPEG frame without DHT, carver inserts standard tables | — |
| `mpf_ghost` | Recovery | Recover only the gain map / depth map / MPF secondary image | kind |
| `icc_loss` | Colour | Wide-gamut photo shown without its ICC profile | mode |
| `exif_orientation` | Metadata | Set/corrupt the orientation tag | value |
| `exif_thumb_mismatch` | Metadata | Embedded thumbnail from another photo | photo |
| `exif_corrupt` | Metadata | Damage the EXIF block (offsets, IFD loops) | rate |
| `strip_exif` | Metadata | Remove EXIF (private fields or everything) | mode |
| `sensor_noise` | Sensor | *Simulated* sensor noise (pixel) | amount |
| `oversharpen` | Sensor | *Simulated* in-camera oversharpening halos | amount |
| `purple_fringe` | Sensor | *Simulated* purple fringing | amount |
| `date_stamp` | Sensor | *Simulated* orange date imprint | text, corner |

## Card crate

| id | group | what it does | core params |
|---|---|---|---|
| `pass_through_card` | Card | Write this photo plus pool neighbours to a virtual (second-hand) card, run a scenario, carve, return the result for this photo. junk_overwrite overwrites 5%..60% of the photo's clusters (severity 1..10). Carvers that stop short continue into the following clusters instead of leaving grey | scenario, tool, severity, neighbours, cluster_kb |
| `interleave` | Card | Concurrent writes, so clusters alternate with another file | photo, period |
| `cross_link` | Card | chkdsk cross-link: a run of clusters shared with another photo | photo, at, clusters |
| `stutter_read` | Card | A cluster read twice (repeated band) | count |
| `dropped_sectors` | Card | 512-byte sectors skipped by a bad reader | count |
| `tool_fill_pattern` | Card | Unreadable sectors filled with a recovery tool's pattern | tool, count |
| `chipoff_xor` | Card | NAND dump without descrambling (XOR key, page order) | key_len, page_kb, shuffle |
| `flash_fault` | Card | Erased pages 0xFF / page-size bursts / stuck bits | mode, count, page_kb |
| `recuva_contiguous` | Card | Undelete assuming the file is contiguous; next clusters belong to another photo | photo, fragment_at |
| `thumbnail_only` | Formats | Only the EXIF/.THM thumbnail survives; upscaled | — |
| `thumbcache` | Formats | Windows thumbcache / thumbs.db / Android .thumbnails style recovery | kind |
| `heic_tiles` | Formats | Tiled HEIC partial recovery: 512×512 tiles lost | lost_tiles |
| `raw_preview` | Formats | Only the RAW's embedded preview JPEG recovered | kind |
| `raw_as_jpeg` | Formats | RAW sensor data decoded as if it were a JPEG body (Bayer garbage) | — |
