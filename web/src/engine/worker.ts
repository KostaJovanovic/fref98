// The ONLY place the WASM engine is loaded. Every call is feature-detected: the Rust side is still being
// written, so any export may be missing. Missing decode/encode fall back to the browser's own codec (clearly
// reported as "browser-fallback"); everything else reports "not available yet".
import type { EngineCaps, DecodeOpts, EncodeOpts } from './types';
import { inspectJpeg, stripExifFallback } from './jpegmeta';
import { renderSkyFrame, ditherSky, type SkyParams } from './skygen';

type Wasm = Record<string, any>;

let wasm: Wasm | null = null;
let loadError: string | undefined;
let exportsList: string[] = [];
const cards = new Map<number, any>();
let nextCard = 1;
const pools = new Map<string, Uint8Array[]>();
let lastAvi: Uint8Array | null = null;

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

async function load(): Promise<void> {
  if (wasm || loadError) return;
  try {
    const mods = import.meta.glob('../wasm/pkg/refragmenter_wasm.js');
    const loader = Object.values(mods)[0];
    if (!loader) throw new Error('engine not built yet (run `npm run wasm`)');
    const mod = (await loader()) as Wasm;
    await mod.default();
    wasm = mod;
    exportsList = Object.keys(mod).filter((k) => k !== 'default' && k !== 'initSync');
    if (mod.Card && typeof mod.Card.simulate === 'function') exportsList.push('Card.simulate');
  } catch (e) {
    loadError = String((e as Error)?.message ?? e);
    exportsList = [];
  }
}

function has(name: string): boolean {
  return !!wasm && typeof wasm[name] === 'function';
}

function need(name: string): any {
  if (!has(name)) throw new Error(`NOT_AVAILABLE:${name}`);
  return wasm![name];
}

function parseJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function errText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

async function browserDecode(input: Uint8Array, opts: DecodeOpts) {
  const blob = new Blob([input as BlobPart], { type: 'image/jpeg' });
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    throw new Error('unreadable');
  }
  let w = bmp.width;
  let h = bmp.height;
  if (opts.max_dim && Math.max(w, h) > opts.max_dim) {
    const s = opts.max_dim / Math.max(w, h);
    w = Math.max(1, Math.round(w * s));
    h = Math.max(1, Math.round(h * s));
  }
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const data = ctx.getImageData(0, 0, w, h).data;
  return { width: w, height: h, rgba: data, events: [], via: 'browser-fallback' as const };
}

function wasmDecode(input: Uint8Array, opts: DecodeOpts, donor?: Uint8Array) {
  // fill "donor": never-reached blocks show another photo instead of grey (needs decode_with_donor)
  const d = opts?.fill === 'donor' && donor?.length && has('decode_with_donor')
    ? need('decode_with_donor')(input, JSON.stringify(opts), donor)
    : need('decode')(input, JSON.stringify(opts?.fill === 'donor' ? { ...opts, fill: 'grey' } : opts ?? {}));
  try {
    const width = d.width as number;
    const height = d.height as number;
    const raw: Uint8Array = d.rgba();
    const rgba = new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength);
    const events = typeof d.events_json === 'function' ? parseJson(d.events_json(), []) : [];
    return { width, height, rgba, events, via: 'ours' as const };
  } finally {
    if (typeof d.free === 'function') d.free();
  }
}

async function decode(input: Uint8Array, opts: DecodeOpts, donor?: Uint8Array) {
  if (has('decode')) return wasmDecode(input, opts, donor);
  return browserDecode(input, opts);
}

async function encodeRgba(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray, opts: EncodeOpts): Promise<Uint8Array> {
  if (has('encode_rgba')) {
    const bytes = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    return need('encode_rgba')(width, height, bytes, JSON.stringify(opts ?? {}));
  }
  const c = new OffscreenCanvas(width, height);
  const ctx = c.getContext('2d')!;
  const img = new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength), width, height);
  ctx.putImageData(img, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: Math.max(0.01, Math.min(1, (opts.quality ?? 85) / 100)) });
  return new Uint8Array(await blob.arrayBuffer());
}

function poolArray(key: string | undefined, photos: Uint8Array[] | undefined): Uint8Array[] {
  if (photos) {
    if (key) {
      pools.set(key, photos);
      if (pools.size > 4) pools.delete(pools.keys().next().value!);
    }
    return photos;
  }
  if (key && pools.has(key)) return pools.get(key)!;
  if (key) throw new Error('POOL_MISSING');
  return [];
}

async function caps(): Promise<EngineCaps> {
  await load();
  const call = (name: string, fb: string) => {
    if (!has(name)) return fb;
    try {
      return wasm![name]();
    } catch {
      return fb;
    }
  };
  return {
    exports: exportsList,
    loadError,
    catalog: parseJson(call('catalog', '[]'), []),
    profiles: parseJson(call('profiles', '[]'), []),
    cardPresets: parseJson(call('card_presets', '[]'), []),
    cardEvents: parseJson(call('card_events', '[]'), []),
  };
}

async function handle(op: string, a: any): Promise<{ result: unknown; transfer?: Transferable[] }> {
  await load();
  switch (op) {
    case 'init':
      return { result: await caps() };
    case 'applyStep': {
      const pool = poolArray(a.poolKey, a.pool);
      const out: Uint8Array = need('apply_step')(a.id, JSON.stringify(a.params ?? {}), a.input, a.seed >>> 0, pool);
      return { result: out, transfer: [out.buffer] };
    }
    case 'decode': {
      const d = await decode(a.input, a.opts ?? {}, a.donor);
      return { result: d, transfer: [d.rgba.buffer] };
    }
    case 'encodeRgba': {
      const out = await encodeRgba(a.width, a.height, a.rgba, a.opts ?? {});
      return { result: out, transfer: [out.buffer] };
    }
    case 'encodeLike': {
      if (!has('encode_like')) {
        const out = await encodeRgba(a.width, a.height, a.rgba, { quality: 90 });
        return { result: out, transfer: [out.buffer] };
      }
      const out: Uint8Array = wasm!.encode_like(a.width, a.height, a.rgba, a.like);
      return { result: out, transfer: [out.buffer] };
    }
    case 'inspect': {
      if (has('inspect')) {
        try {
          return { result: { ...JSON.parse(wasm!.inspect(a.input)), via: 'ours' } };
        } catch {
          /* fall through to the TS walker */
        }
      }
      return { result: { ...inspectJpeg(a.input), via: 'fallback' } };
    }
    case 'mcuMap': {
      const out: Uint32Array = need('mcu_map')(a.input);
      return { result: out, transfer: [out.buffer] };
    }
    case 'coeffHeatmap': {
      const out: Float32Array = need('coeff_heatmap')(a.input, a.component | 0, a.mode);
      return { result: out, transfer: [out.buffer] };
    }
    case 'stripPrivateExif': {
      const out: Uint8Array = has('strip_private_exif') ? wasm!.strip_private_exif(a.input) : stripExifFallback(a.input);
      return { result: out, transfer: [out.buffer] };
    }
    case 'encodeGif': {
      const out: Uint8Array = need('encode_gif')(a.width, a.height, a.frames, a.delayCs | 0);
      return { result: out, transfer: [out.buffer] };
    }
    case 'aviWrite': {
      const out: Uint8Array = need('avi_write')(a.frames, a.width, a.height, a.fps);
      return { result: out, transfer: [out.buffer] };
    }
    case 'aviRead':
      return { result: JSON.parse(need('avi_read')(a.avi)) };
    case 'aviFrame': {
      // The client sends the AVI once and then only frame numbers (see EngineClient.aviFrame).
      if (a.avi) lastAvi = a.avi;
      else if (!lastAvi) throw new Error('AVI_MISSING');
      const out: Uint8Array = need('avi_frame')(lastAvi, a.index | 0);
      return { result: out, transfer: [out.buffer] };
    }
    // ---- card ----
    case 'cardSimulate': {
      if (!wasm?.Card || typeof wasm.Card.simulate !== 'function') throw new Error('NOT_AVAILABLE:Card.simulate');
      const card = wasm.Card.simulate(JSON.stringify(a.scenario), a.photos, a.seed >>> 0);
      const h = nextCard++;
      cards.set(h, card);
      const info = parseJson(card.info_json(), null);
      const map: Uint8Array = card.cluster_map();
      const owner: Int32Array = card.cluster_owner();
      return { result: { handle: h, info, map, owner }, transfer: [map.buffer, owner.buffer] };
    }
    case 'cardCarve': {
      const card = cards.get(a.handle);
      if (!card) throw new Error('card gone');
      return { result: parseJson(card.carve(JSON.stringify(a.method)), []) };
    }
    case 'cardRecovered': {
      const card = cards.get(a.handle);
      if (!card) throw new Error('card gone');
      const out: Uint8Array = card.recovered(a.index);
      return { result: out, transfer: [out.buffer] };
    }
    case 'cardImageSize': {
      const card = cards.get(a.handle);
      if (!card) throw new Error('card gone');
      return { result: card.image_size() };
    }
    case 'cardImageChunk': {
      const card = cards.get(a.handle);
      if (!card) throw new Error('card gone');
      const out: Uint8Array = card.image_chunk(a.offset, a.length);
      return { result: out, transfer: [out.buffer] };
    }
    case 'cardFree': {
      const card = cards.get(a.handle);
      if (card) {
        cards.delete(a.handle);
        try {
          card.free();
        } catch {
          /* already freed */
        }
      }
      return { result: true };
    }
    // ---- ambient: the desktop sky, made of a real low-quality JPEG ----
    case 'sky': {
      const p = a as SkyParams & { quality: number; damage: number; seed: number; depth?: string };
      const frame = renderSkyFrame(p);
      let out = frame;
      let via = 'raw';
      if (has('encode_rgba') && has('decode')) {
        let jpeg: Uint8Array = wasm!.encode_rgba(p.width, p.height, new Uint8Array(frame.buffer), JSON.stringify({ quality: p.quality, subsampling: '420' }));
        if (p.damage > 0 && has('apply_step')) {
          try {
            jpeg = wasm!.apply_step('bitflip', JSON.stringify({ rate: p.damage }), jpeg, p.seed >>> 0, []);
          } catch {
            /* the damage step is optional */
          }
        }
        const d = wasmDecode(jpeg, {});
        if (d.width === p.width && d.height === p.height) {
          out = d.rgba;
          via = 'ours';
        }
      }
      if (!p.noDither) ditherSky(out, p.width, p.height, p.depth);
      return { result: { rgba: out, via }, transfer: [out.buffer] };
    }
    case 'ping':
      return { result: 'pong' };
    default:
      throw new Error('unknown op ' + op);
  }
}

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  if (!msg || typeof msg.id !== 'number') return;
  try {
    const { result, transfer } = await handle(msg.op, msg.args ?? {});
    post({ id: msg.id, ok: true, result }, transfer ?? []);
  } catch (e) {
    // A trap (a Rust panic, running out of memory) leaves the WASM instance in an unknown state:
    // tell the client, which replaces this worker.
    const trapped = typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError;
    post({ id: msg.id, ok: false, error: (trapped ? 'ENGINE_CRASHED:' : '') + errText(e) });
  }
};
