// MP4 export via WebCodecs (H.264) with a minimal ISO-BMFF muxer: one video track, all samples in one mdat.

export function canEncodeMp4(): boolean {
  return typeof (globalThis as any).VideoEncoder !== 'undefined' && typeof (globalThis as any).VideoFrame !== 'undefined';
}

interface Sample {
  data: Uint8Array;
  key: boolean;
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const len = 8 + parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  const v = new DataView(out.buffer);
  v.setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let o = 8;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u32(...n: number[]): Uint8Array {
  const b = new Uint8Array(n.length * 4);
  const v = new DataView(b.buffer);
  n.forEach((x, i) => v.setUint32(i * 4, x >>> 0));
  return b;
}

function u16(...n: number[]): Uint8Array {
  const b = new Uint8Array(n.length * 2);
  const v = new DataView(b.buffer);
  n.forEach((x, i) => v.setUint16(i * 2, x));
  return b;
}

function bytes(...n: number[]): Uint8Array {
  return new Uint8Array(n);
}

function fullbox(type: string, version: number, flags: number, ...parts: Uint8Array[]) {
  return box(type, u32(((version & 255) << 24) | (flags & 0xffffff)), ...parts);
}

const MATRIX = u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);

function mux(samples: Sample[], avcC: Uint8Array, w: number, h: number, fps: number): Uint8Array {
  const timescale = fps * 100;
  const dur = 100;
  const total = samples.length * dur;
  const ftyp = box('ftyp', new TextEncoder().encode('isom'), u32(512), new TextEncoder().encode('isomiso2avc1mp41'));
  const mdatPayload = samples.reduce((a, s) => a + s.data.length, 0);
  const stsd = fullbox(
    'stsd', 0, 0, u32(1),
    box('avc1', bytes(0, 0, 0, 0, 0, 0), u16(1), new Uint8Array(16), u16(w, h), u32(0x480000, 0x480000, 0), u16(1), new Uint8Array(32), u16(0x18, 0xffff), box('avcC', avcC)),
  );
  const stts = fullbox('stts', 0, 0, u32(1, samples.length, dur));
  const stsc = fullbox('stsc', 0, 0, u32(1, 1, samples.length, 1));
  const stsz = fullbox('stsz', 0, 0, u32(0, samples.length), u32(...samples.map((s) => s.data.length)));
  const keys = samples.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean);
  const stss = fullbox('stss', 0, 0, u32(keys.length, ...keys));
  // the chunk offset is patched once moov's size is known
  const build = (chunkOffset: number) => {
    const stco = fullbox('stco', 0, 0, u32(1, chunkOffset));
    const stbl = box('stbl', stsd, stts, stsc, stsz, stss, stco);
    const dinf = box('dinf', fullbox('dref', 0, 0, u32(1), fullbox('url ', 0, 1)));
    const minf = box('minf', fullbox('vmhd', 0, 1, u16(0, 0, 0, 0)), dinf, stbl);
    const hdlr = fullbox('hdlr', 0, 0, u32(0), new TextEncoder().encode('vide'), u32(0, 0, 0), new TextEncoder().encode('File Refragmenter\0'));
    const mdhd = fullbox('mdhd', 0, 0, u32(0, 0, timescale, total), u16(0x55c4, 0));
    const mdia = box('mdia', mdhd, hdlr, minf);
    const tkhd = fullbox('tkhd', 0, 3, u32(0, 0, 1, 0, total, 0, 0), u16(0, 0, 0, 0), MATRIX, u32(w << 16, h << 16));
    const trak = box('trak', tkhd, mdia);
    const mvhd = fullbox('mvhd', 0, 0, u32(0, 0, timescale, total, 0x10000), u16(0x100, 0), u32(0, 0), MATRIX, new Uint8Array(24), u32(2));
    return box('moov', mvhd, trak);
  };
  let moov = build(0);
  const offset = ftyp.length + moov.length + 8;
  moov = build(offset);
  const mdatHead = new Uint8Array(8);
  new DataView(mdatHead.buffer).setUint32(0, mdatPayload + 8);
  mdatHead.set([0x6d, 0x64, 0x61, 0x74], 4);
  const out = new Uint8Array(ftyp.length + moov.length + 8 + mdatPayload);
  let o = 0;
  for (const p of [ftyp, moov, mdatHead]) {
    out.set(p, o);
    o += p.length;
  }
  for (const s of samples) {
    out.set(s.data, o);
    o += s.data.length;
  }
  return out;
}

/** Encodes RGBA frames (all w×h) to an MP4 file. */
export async function encodeMp4(frames: Uint8ClampedArray[], w: number, h: number, fps: number): Promise<Uint8Array> {
  const W = w & ~1;
  const H = h & ~1;
  const VE = (globalThis as any).VideoEncoder;
  const VF = (globalThis as any).VideoFrame;
  const samples: Sample[] = [];
  let avcC: Uint8Array | null = null;
  let err: unknown = null;
  const enc = new VE({
    output: (chunk: any, meta: any) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, key: chunk.type === 'key' });
      if (meta?.decoderConfig?.description && !avcC) avcC = new Uint8Array(meta.decoderConfig.description);
    },
    error: (e: unknown) => (err = e),
  });
  const cfgs = ['avc1.42001f', 'avc1.4d0028', 'avc1.640028'];
  let ok = false;
  for (const codec of cfgs) {
    const cfg = { codec, width: W, height: H, bitrate: 4_000_000, framerate: fps, avc: { format: 'avc' } };
    const sup = await VE.isConfigSupported(cfg).catch(() => ({ supported: false }));
    if (sup.supported) {
      enc.configure(cfg);
      ok = true;
      break;
    }
  }
  if (!ok) throw new Error('This browser cannot encode H.264 video.');
  const c = new OffscreenCanvas(W, H);
  const x = c.getContext('2d')!;
  for (let i = 0; i < frames.length; i++) {
    x.putImageData(new ImageData(new Uint8ClampedArray(frames[i].buffer as ArrayBuffer, frames[i].byteOffset, w * h * 4), w, h), 0, 0);
    const vf = new VF(c, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
    enc.encode(vf, { keyFrame: i % 30 === 0 });
    vf.close();
  }
  await enc.flush();
  enc.close();
  if (err) throw err;
  if (!avcC) throw new Error('The video encoder gave no stream description.');
  return mux(samples, avcC, W, H, fps);
}
