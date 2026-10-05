// Story presets for simple mode ("What happened to this photo?" → "How bad?"). Every preset builds a real
// step stack from the frozen step ids in docs/STEP_IDS.md. Param defaults come from catalog() at runtime;
// presets only override the documented core params, clamped to the ranges the engine reports.
import type { StepInfo, Profile } from './engine/types';
import { makeRepeat, makeStep, type StackNode, type StepItem } from './engine/stack';

export interface PresetCtx {
  catalog: Map<string, StepInfo>;
  profiles: Profile[];
  /** 0 (barely) .. 1 (destroyed) */
  bad: number;
  seed: number;
}

export interface Preset {
  id: string;
  title: string;
  story: string;
  category: 'Storage' | 'Sharing' | 'Camera' | 'Transfer' | 'Rescue';
  icon: string;
  /** Foldy's comment when the preset is chosen. */
  foldy: string;
  /** Words for the "How bad?" slider ends. */
  scale: [string, string];
  /** Step ids it uses (to show "partly available"). */
  uses: string[];
  /** Needs at least one other photo in the pool. */
  needsPool?: boolean;
  build(c: PresetCtx): StackNode[];
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function seedFor(c: PresetCtx, i: number): number {
  return (Math.imul(c.seed ^ 0x5bd1e995, i + 1) ^ (c.seed >>> 7)) >>> 0;
}

/** Build a step with defaults from the catalog and the given core params (clamped). */
function step(c: PresetCtx, id: string, params: Record<string, unknown> = {}, i = 0): StepItem {
  const info = c.catalog.get(id);
  const p: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    const pi = info?.params.find((x) => x.id === k);
    if (pi && typeof v === 'number' && (pi.kind === 'int' || pi.kind === 'float')) {
      let n = v;
      if (pi.min !== undefined) n = Math.max(pi.min, n);
      if (pi.max !== undefined) n = Math.min(pi.max, n);
      p[k] = pi.kind === 'int' ? Math.round(n) : n;
    } else if (pi && pi.kind === 'enum' && typeof v === 'string' && pi.options && !pi.options.some((o) => o[0] === v)) {
      // an option the engine doesn't know: keep the engine default
    } else p[k] = v;
  }
  return makeStep(id, info, p, seedFor(c, i));
}

/** A deterministic 0..1 value from the preset seed (so one preset choice keeps its look while "How bad?" moves). */
function seedUnit(c: PresetCtx, i: number): number {
  let h = seedFor(c, i);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function findProfile(c: PresetCtx, test: (p: Profile) => boolean): string | undefined {
  return c.profiles.find(test)?.id;
}

export const PRESETS: Preset[] = [
  {
    id: 'dead-sd',
    title: 'Dead SD card',
    story: 'The memory card died. This is what came back from recovery.',
    category: 'Storage',
    icon: 'disk',
    foldy: 'Recovered files are often cut short (grey at the bottom) or start in the wrong place, which shifts the colours. All of that happens here for real.',
    scale: ['A bit glitchy', 'Barely recognisable'],
    uses: ['splice', 'byte_delete', 'truncate'],
    needsPool: true,
    build: (c) => {
      const out: StackNode[] = [];
      if (c.bad > 0.25) out.push(step(c, 'splice', { photo: -1, clusters: Math.round(lerp(1, 4, c.bad)) }, 1));
      out.push(step(c, 'byte_delete', { count: Math.round(lerp(1, 6, c.bad)) }, 2));
      // keep the cut-off grey band at the bottom a band, not most of the picture
      out.push(step(c, 'truncate', { percent: Math.round(lerp(97, 86, c.bad)) }, 3));
      return out;
    },
  },
  {
    id: 'displaced',
    title: 'Displaced',
    story: 'Recovered from a card where some clusters went missing and others turned up uninvited.',
    category: 'Rescue',
    icon: 'shovel',
    foldy: 'When a few clusters go missing or extra ones sneak in, every block after that lands in the wrong spot. The picture slides sideways with a seam, picks up a colour cast, and the bottom can even turn into another photo.',
    scale: ['Slightly off', 'Way off'],
    uses: ['displace'],
    needsPool: true,
    build: (c) => [
      step(
        c,
        'displace',
        {
          shifts: 1 + Math.round(2 * c.bad),
          lost_kb: 2 + 30 * c.bad,
          seam_x: lerp(0.3, 0.8, seedUnit(c, 12)),
          top_garbage_kb: 1 + 4 * c.bad,
          // 1 = no foreign photo; from "fairly bad" on, the bottom part comes from another pool photo
          foreign_from: c.bad > 0.35 ? 1 - 0.45 * c.bad : 1,
          foreign_photo: -1,
          natural_cast: true,
          neutralise_markers: true,
        },
        1,
      ),
    ],
  },
  {
    id: 'whatsapp-40',
    title: 'Forwarded 40× on WhatsApp',
    story: 'Everyone forwarded it to everyone. Each app saved it again.',
    category: 'Sharing',
    icon: 'chat',
    foldy: 'Every forward decodes and re-encodes the photo. The 8×8 blocks and smeared colours pile up with each generation.',
    scale: ['Forwarded twice', 'Forwarded 60 times'],
    uses: ['resave'],
    // Plain re-saves with the same tables settle after a few generations (a repeat of reencode_profile barely
    // changes between 2 and 60 forwards). resave nudges the 8x8 grid and wobbles the quality per save, like
    // real forwards through different phones, so the damage keeps piling up.
    build: (c) => {
      const times = Math.round(lerp(2, 60, c.bad * c.bad));
      const wa = findProfile(c, (p) => /whats/i.test(p.id + p.label));
      return [
        step(c, 'resave', { generations: times, quality: Math.round(lerp(80, 70, c.bad)), quality_jitter: 5, shift: 1, ...(wa ? { profile: wa } : {}) }, 1),
      ];
    },
  },
  {
    id: 'digicam-2004',
    title: '2004 digicam',
    story: 'Shot on a little silver camera in 2004, at "Normal" quality.',
    category: 'Camera',
    icon: 'camera',
    foldy: 'Old cameras used coarse tables, strong sharpening and noisy sensors. The noise and date stamp are simulated; the compression is real.',
    scale: ['Fine mode', 'Economy mode at night'],
    uses: ['reencode_profile', 'sensor_noise', 'oversharpen', 'date_stamp', 'requantize'],
    build: (c) => {
      const out: StackNode[] = [];
      if (c.bad > 0.1) out.push(step(c, 'sensor_noise', { amount: lerp(0.1, 0.8, c.bad) }, 1));
      out.push(step(c, 'oversharpen', { amount: lerp(0.2, 0.9, c.bad) }, 2));
      const cam = findProfile(c, (p) => p.kind === 'camera' && (p.year ?? 2004) <= 2006);
      if (cam) out.push(step(c, 'reencode_profile', { profile: cam }, 3));
      out.push(step(c, 'requantize', { quality: Math.round(lerp(88, 35, c.bad)) }, 4));
      out.push(step(c, 'date_stamp', { text: "'04 6 12" }, 5));
      return out;
    },
  },
  {
    id: 'photorec',
    title: 'PhotoRec carve',
    story: 'Deleted by accident, then dug out of the card by a carving tool.',
    category: 'Rescue',
    icon: 'shovel',
    foldy: 'A carver has no file table: it finds a JPEG header and keeps reading clusters. When the file was fragmented, the next clusters belong to someone else.',
    scale: ['One fragment', 'Shredded'],
    uses: ['pass_through_card', 'recuva_contiguous', 'dropped_sectors'],
    needsPool: true,
    build: (c) => {
      const out: StackNode[] = [step(c, 'pass_through_card', { tool: 'photorec', severity: Math.round(lerp(1, 8, c.bad)) }, 1)];
      out.push(step(c, 'recuva_contiguous', { photo: -1, fragment_at: Math.round(lerp(85, 30, c.bad)) }, 2));
      if (c.bad > 0.5) out.push(step(c, 'dropped_sectors', { count: Math.round(lerp(1, 8, (c.bad - 0.5) * 2)) }, 3));
      return out;
    },
  },
  {
    id: 'header-graft',
    title: 'Bad header graft',
    story: 'The header was gone, so someone glued on the header of another photo.',
    category: 'Rescue',
    icon: 'glue',
    foldy: 'The body is decoded with another photo’s tables and size. Different dimensions shear the picture; different tables change the contrast.',
    scale: ['Same camera', 'Wrong everything'],
    uses: ['header_graft', 'byte_delete'],
    needsPool: true,
    build: (c) => {
      const out: StackNode[] = [step(c, 'header_graft', { photo: -1 }, 1)];
      if (c.bad > 0.2) out.push(step(c, 'byte_delete', { count: Math.round(lerp(1, 4, c.bad)) }, 2));
      return out;
    },
  },
  {
    id: 'interrupted',
    title: 'Interrupted download',
    story: 'The connection dropped halfway through the download.',
    category: 'Transfer',
    icon: 'globe',
    foldy: 'Only part of the file arrived. This photo was sent in passes, coarse first and sharp later, so the missing passes leave it blocky and blurry, and some of the colour never showed up.',
    scale: ['Almost finished', 'Barely started'],
    uses: ['interrupted_download'],
    build: (c) => [step(c, 'interrupted_download', { percent: Math.round(lerp(90, 15, c.bad)) }, 1)],
  },
  {
    id: 'ftp-ascii',
    title: 'FTP ASCII accident',
    story: 'Uploaded over FTP in text mode, so every line ending got "fixed".',
    category: 'Transfer',
    icon: 'globe',
    foldy: 'Text mode turns every 0x0A byte into 0x0D 0x0A. Each extra byte desyncs the decoder: shifts, smears and colour jumps.',
    scale: ['A little of it', 'The whole file'],
    uses: ['ftp_ascii'],
    // portion = fraction of the file that went over in text mode
    build: (c) => [step(c, 'ftp_ascii', { portion: lerp(0.05, 1, c.bad) }, 1)],
  },
  {
    id: 'ransomware',
    title: 'Ransomware rescue',
    story: 'Ransomware encrypted the start of every file. The rest was rescued.',
    category: 'Rescue',
    icon: 'lock',
    foldy: 'Fast ransomware only scrambles the first few kilobytes. Gluing a donor header onto the surviving body brings most of the picture back.',
    scale: ['First 1 KB', 'First 14 KB'],
    uses: ['ransomware_partial', 'header_graft'],
    needsPool: true,
    build: (c) => {
      // the lost kilobytes come off the bottom as grey, so keep them small; the look comes from where the cut lands
      const kb = Math.round(lerp(1, 14, c.bad));
      // the graft must skip exactly the encrypted bytes, or the noise is decoded as picture data
      return [step(c, 'ransomware_partial', { kb }, 1), step(c, 'header_graft', { photo: -1, skip: kb * 1024, neutralise_markers: true }, 2)];
    },
  },
  {
    id: 'thumb-survivor',
    title: 'Thumbnail survivor',
    story: 'The photo was lost; only its tiny embedded thumbnail survived.',
    category: 'Rescue',
    icon: 'stamp',
    foldy: 'Cameras hide a 160×120 preview inside the EXIF data. Blown up to full size, every one of its pixels becomes a big soft block.',
    scale: ['Gently upscaled', 'Pixel soup'],
    uses: ['thumbnail_only', 'requantize'],
    build: (c) => {
      const out: StackNode[] = [step(c, 'thumbnail_only', {}, 1)];
      if (c.bad > 0.4) out.push(step(c, 'requantize', { quality: Math.round(lerp(70, 25, c.bad)) }, 2));
      return out;
    },
  },
  {
    id: 'cosmic',
    title: 'Cosmic ray',
    story: 'A few bits flipped while the file sat on an old disk.',
    category: 'Storage',
    icon: 'star',
    foldy: 'One flipped bit in the compressed data can derail everything after it until the next restart marker.',
    scale: ['One bit', 'A shower'],
    uses: ['bitflip'],
    // rate is in flips per 100 KB
    build: (c) => [step(c, 'bitflip', { rate: lerp(0.5, 40, c.bad * c.bad) }, 1)],
  },
  {
    id: 'pink-cast',
    title: 'Pink cast',
    story: 'Recovered, but the colours are pastel pink and green from some point on.',
    category: 'Rescue',
    icon: 'palette',
    foldy: 'Colour is stored as differences from the previous block. Start from a wrong value and every block after it keeps the wrong tint.',
    scale: ['Slight tint', 'Bubblegum'],
    uses: ['dc_offset'],
    build: (c) => [
      step(c, 'dc_offset', { component: '2', amount: Math.round(lerp(8, 60, c.bad)) }, 1),
      step(c, 'dc_offset', { component: '1', amount: Math.round(lerp(-4, -40, c.bad)) }, 2),
    ],
  },
  {
    id: 'email-1998',
    title: 'Emailed in 1998',
    story: 'Sent through an old mail gateway that only spoke 7-bit text.',
    category: 'Transfer',
    icon: 'mail',
    foldy: 'A 7-bit gateway clears the top bit of every byte. JPEG data needs all eight, so the picture falls apart quickly.',
    scale: ['One bad line', 'Fully mangled'],
    uses: ['base64_damage', 'seven_bit'],
    build: (c) => (c.bad < 0.5 ? [step(c, 'base64_damage', { lines: Math.round(lerp(1, 6, c.bad * 2)) }, 1)] : [step(c, 'seven_bit', { start: Math.round(lerp(90, 30, c.bad)) }, 1)]),
  },
  {
    id: 'mms',
    title: 'MMS to grandma',
    story: 'Sent as a picture message on a 2007 flip phone.',
    category: 'Sharing',
    icon: 'phone',
    foldy: 'MMS gateways squeezed photos into tens of kilobytes: tiny size, harsh tables, smeared colour.',
    scale: ['300 KB', '20 KB'],
    uses: ['mms_recompress'],
    // geometric 300 → 77 → 20 KB: the halfway point is already a real squeeze, not "still bigger than the photo"
    build: (c) => [step(c, 'mms_recompress', { size_kb: Math.round(300 * Math.pow(20 / 300, c.bad)) }, 1)],
  },
  {
    id: 'wrong-size',
    title: 'Wrong size',
    story: 'The header says the photo is a different width than it really is.',
    category: 'Rescue',
    icon: 'ruler',
    foldy: 'Rows of blocks wrap at the wrong place, so the picture slides sideways a bit more on every row: a diagonal shear.',
    scale: ['A few pixels off', 'Way off'],
    uses: ['sof_dims'],
    // width 0 keeps the real width; width_delta is the signed error (in pixels) the header claims
    build: (c) => {
      const sign = seedUnit(c, 1) < 0.5 ? -1 : 1;
      return [step(c, 'sof_dims', { width: 0, height: 0, width_delta: sign * (8 + Math.round(56 * c.bad)), height_delta: 0 }, 1)];
    },
  },
  {
    id: 'flaky-reader',
    title: 'Flaky card reader',
    story: 'A cheap card reader that sometimes skips or repeats sectors.',
    category: 'Storage',
    icon: 'disk',
    foldy: 'A skipped 512-byte sector shifts everything after it; a repeated cluster makes a band appear twice.',
    scale: ['Once', 'Constantly'],
    uses: ['dropped_sectors', 'stutter_read'],
    build: (c) => {
      // no stutter at the low end ("Once"): the step's own minimum is one repeat
      const stutters = Math.round(lerp(0, 4, c.bad));
      return [step(c, 'dropped_sectors', { count: Math.round(lerp(1, 10, c.bad)) }, 1), ...(stutters > 0 ? [step(c, 'stutter_read', { count: stutters }, 2)] : [])];
    },
  },
  {
    id: 'deep-fried',
    title: 'Deep fried',
    story: 'Saved at the lowest quality, then sharpened, then saved again. Many times.',
    category: 'Sharing',
    icon: 'flame',
    foldy: 'Very low quality throws away almost all detail; sharpening exaggerates what is left and the next save chews it up again.',
    scale: ['Crispy', 'Charcoal'],
    uses: ['oversharpen', 'requantize'],
    build: (c) =>
      [makeRepeat(Math.round(lerp(2, 12, c.bad)), [step(c, 'oversharpen', { amount: lerp(0.3, 1, c.bad) }, 1), step(c, 'requantize', { quality: Math.round(lerp(40, 8, c.bad)) }, 2)], seedFor(c, 7))],
  },
];

export function presetAvailability(p: Preset, catalog: Map<string, StepInfo>): 'full' | 'partial' | 'none' {
  const n = p.uses.filter((u) => catalog.has(u)).length;
  if (n === p.uses.length) return 'full';
  return n ? 'partial' : 'none';
}
