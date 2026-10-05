// Bundled "roll mate" photos. The real set is supplied later via public/bundled/manifest.json; until then
// (or when the manifest is empty) a few procedural placeholders are generated at runtime and labelled so.
import { engine } from './client';

export interface BundledEntry {
  id: string;
  file: string;
  name: string;
  license?: string;
  author?: string;
}

export async function loadManifest(): Promise<BundledEntry[]> {
  try {
    const r = await fetch('bundled/manifest.json', { cache: 'no-cache' });
    if (!r.ok) return [];
    const j = await r.json();
    const list = Array.isArray(j) ? j : Array.isArray(j?.photos) ? j.photos : [];
    return list.filter((e: any) => e && typeof e.file === 'string').map((e: any) => ({ id: String(e.id ?? e.file), file: e.file, name: String(e.name ?? e.file), license: e.license, author: e.author }));
  } catch {
    return [];
  }
}

export async function fetchBundled(e: BundledEntry): Promise<Uint8Array> {
  const r = await fetch('bundled/' + e.file);
  if (!r.ok) throw new Error('missing bundled photo ' + e.file);
  return new Uint8Array(await r.arrayBuffer());
}

type Painter = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

function label(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, h - 34, w, 34);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText('PLACEHOLDER PHOTO — real bundled photos come later', 14, h - 11);
}

const PAINTERS: { id: string; name: string; paint: Painter }[] = [
  {
    id: 'testcard',
    name: 'Test card',
    paint: (ctx, w, h) => {
      const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0', '#101010'];
      bars.forEach((c, i) => {
        ctx.fillStyle = c;
        ctx.fillRect((i * w) / 8, 0, w / 8 + 1, h * 0.55);
      });
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, '#000');
      g.addColorStop(1, '#fff');
      ctx.fillStyle = g;
      ctx.fillRect(0, h * 0.55, w, h * 0.12);
      for (let x = 0; x < w; x += 2) {
        ctx.fillStyle = (x / 2) % 2 ? '#fff' : '#000';
        ctx.fillRect(x, h * 0.67, 2, h * 0.1);
      }
      const rg = ctx.createLinearGradient(0, 0, w, 0);
      ['#f00', '#ff0', '#0f0', '#0ff', '#00f', '#f0f', '#f00'].forEach((c, i) => rg.addColorStop(i / 6, c));
      ctx.fillStyle = rg;
      ctx.fillRect(0, h * 0.77, w, h * 0.1);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(w / 2, h * 0.35, h * 0.28, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 64px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('File Refragmenter', w / 2, h * 0.38);
      ctx.textAlign = 'left';
    },
  },
  {
    id: 'sunset',
    name: 'Sunset lake',
    paint: (ctx, w, h) => {
      const sky = ctx.createLinearGradient(0, 0, 0, h * 0.6);
      sky.addColorStop(0, '#2b1a5a');
      sky.addColorStop(0.5, '#c2457a');
      sky.addColorStop(1, '#ffb347');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, h * 0.6);
      ctx.fillStyle = '#ffe9a8';
      ctx.beginPath();
      ctx.arc(w * 0.62, h * 0.5, h * 0.11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1d1430';
      ctx.beginPath();
      ctx.moveTo(0, h * 0.6);
      for (let x = 0; x <= w; x += 16) ctx.lineTo(x, h * 0.6 - (Math.sin(x / 90) * 30 + Math.sin(x / 37) * 12 + 40));
      ctx.lineTo(w, h * 0.6);
      ctx.fill();
      const water = ctx.createLinearGradient(0, h * 0.6, 0, h);
      water.addColorStop(0, '#d0607f');
      water.addColorStop(1, '#25183f');
      ctx.fillStyle = water;
      ctx.fillRect(0, h * 0.6, w, h * 0.4);
      for (let y = h * 0.62; y < h; y += 7) {
        ctx.fillStyle = `rgba(255,230,160,${0.5 - (y - h * 0.6) / h})`;
        const half = 20 + ((y * 13) % 60);
        ctx.fillRect(w * 0.62 - half, y, half * 2, 2);
      }
    },
  },
  {
    id: 'bricks',
    name: 'Brick wall and sign',
    paint: (ctx, w, h) => {
      ctx.fillStyle = '#8a8070';
      ctx.fillRect(0, 0, w, h);
      for (let y = 0, r = 0; y < h; y += 28, r++)
        for (let x = (r % 2) * -30; x < w; x += 60) {
          const t = ((x * 7 + y * 13) % 40) - 20;
          ctx.fillStyle = `rgb(${150 + t},${60 + t / 2},${45 + t / 3})`;
          ctx.fillRect(x + 2, y + 2, 56, 24);
        }
      ctx.fillStyle = '#0d4f9c';
      ctx.fillRect(w * 0.18, h * 0.22, w * 0.64, h * 0.36);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 8;
      ctx.strokeRect(w * 0.18 + 10, h * 0.22 + 10, w * 0.64 - 20, h * 0.36 - 20);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 54px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('CAMERA SHOP', w / 2, h * 0.38);
      ctx.font = '28px serif';
      ctx.fillText('films developed in 1 hour', w / 2, h * 0.48);
      ctx.textAlign = 'left';
    },
  },
  {
    id: 'garden',
    name: 'Red flowers',
    paint: (ctx, w, h) => {
      const sky = ctx.createLinearGradient(0, 0, 0, h * 0.35);
      sky.addColorStop(0, '#3f7fd8');
      sky.addColorStop(1, '#bfe0ff');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, h * 0.35);
      const grass = ctx.createLinearGradient(0, h * 0.35, 0, h);
      grass.addColorStop(0, '#5c9e3a');
      grass.addColorStop(1, '#1f4d1a');
      ctx.fillStyle = grass;
      ctx.fillRect(0, h * 0.35, w, h * 0.65);
      let s = 7;
      const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < 260; i++) {
        const y = h * 0.38 + rnd() * h * 0.6;
        const x = rnd() * w;
        const r = 3 + (y / h) * 14;
        ctx.fillStyle = '#2d6b22';
        ctx.fillRect(x - 1, y, 2, r * 2);
        ctx.fillStyle = i % 7 ? '#e0182a' : '#f5d000';
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  },
];

export const PLACEHOLDER_IDS = PAINTERS.map((p) => 'ph:' + p.id);

export async function makePlaceholder(id: string): Promise<{ uid: string; name: string; bytes: Uint8Array } | null> {
  const p = PAINTERS.find((x) => 'ph:' + x.id === id);
  if (!p) return null;
  const w = 1024;
  const h = 768;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  p.paint(ctx, w, h);
  label(ctx, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const bytes = await engine().encodeRgba(w, h, rgba, { quality: 92 }).promise;
  return { uid: 'ph:' + p.id, name: p.name + ' (placeholder)', bytes };
}
