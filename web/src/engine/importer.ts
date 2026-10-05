// Getting photos in: JPEGs keep their original bytes as step 0; other formats are decoded by the browser
// and encoded with our encoder at the camera profile's size unless "keep original" is on (Q9, Q24).
import { engine } from './client';
import { isJpeg } from './jpegmeta';
import { settings } from '../settings';
import type { Profile } from './types';

export interface ImportedPhoto {
  name: string;
  bytes: Uint8Array;
  width?: number;
  height?: number;
  note?: string;
}

export type ImportKind = 'photo' | 'project' | 'recipe' | 'avi' | 'unknown';

export function classify(file: File, head: Uint8Array): ImportKind {
  const n = file.name.toLowerCase();
  if (n.endsWith('.rfg') || n.endsWith('.jpegit') || (n.endsWith('.zip') && head[0] === 0x50 && head[1] === 0x4b)) return 'project';
  if (n.endsWith('.json')) return 'recipe';
  if (n.endsWith('.avi') || (head[0] === 0x52 && head[1] === 0x49 && head[8] === 0x41 && head[9] === 0x56)) return 'avi';
  if (isJpeg(head) || file.type.startsWith('image/') || /\.(png|gif|webp|bmp|avif|heic|heif|jfif|jpe?g)$/.test(n)) return 'photo';
  return 'unknown';
}

export function chooseProfile(profiles: Profile[]): Profile | null {
  if (!profiles.length) return null;
  return (
    profiles.find((p) => p.id === settings.importProfile) ??
    profiles.find((p) => p.kind === 'camera') ??
    profiles[0]
  );
}

/** Fit (w,h) inside the profile's frame, matching orientation; never upscale. */
export function fitSize(w: number, h: number, pw: number, ph: number): [number, number] {
  const landscape = w >= h;
  const bw = landscape ? Math.max(pw, ph) : Math.min(pw, ph);
  const bh = landscape ? Math.min(pw, ph) : Math.max(pw, ph);
  const s = Math.min(1, bw / w, bh / h);
  return [Math.max(8, Math.round(w * s)), Math.max(8, Math.round(h * s))];
}

export async function importPhotoFile(file: File): Promise<ImportedPhoto> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const name = file.name.replace(/\.[^.]+$/, '') || 'photo';
  if (isJpeg(buf)) return { name, bytes: buf, note: 'original JPEG bytes' };
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  } catch {
    const ext = file.name.split('.').pop()?.toUpperCase() ?? 'this';
    throw new Error(`This browser can't open ${ext} files. Try a JPEG or PNG.`);
  }
  const eng = engine();
  const caps = await eng.ready;
  const prof = chooseProfile(caps.profiles);
  let w = bmp.width;
  let h = bmp.height;
  if (!settings.keepOriginal) {
    const [pw, ph] = prof ? [prof.width, prof.height] : [2272, 1704];
    [w, h] = fitSize(w, h, pw, ph);
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const bytes = await eng.encodeRgba(w, h, rgba, prof ? { profile: prof.id } : { quality: 92 }).promise;
  return { name, bytes, width: w, height: h, note: prof ? `encoded like ${prof.label}` : 'encoded at quality 92' };
}

/** Downscale an existing JPEG to the profile size, re-encoding "like" itself (keeps its tables). */
export async function shrinkJpeg(bytes: Uint8Array, maxW: number, maxH: number): Promise<Uint8Array> {
  const eng = engine();
  const d = await eng.decode(bytes, {}).promise;
  const [w, h] = fitSize(d.width, d.height, maxW, maxH);
  if (w === d.width && h === d.height) return bytes;
  const src = document.createElement('canvas');
  src.width = d.width;
  src.height = d.height;
  src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(d.rgba), d.width, d.height), 0, 0);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return eng.encodeLike(w, h, ctx.getImageData(0, 0, w, h).data, bytes).promise;
}
