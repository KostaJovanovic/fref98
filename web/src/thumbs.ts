// Dithered (palette) thumbnails of pool photos, made on the ambient worker so they never delay the editor.
import { ambientEngine } from './engine/client';
import { ditheredThumb } from './ui/art';

const cache = new Map<string, Promise<string | null>>();

export function thumbUrl(key: string, bytes: Uint8Array, size = 96): Promise<string | null> {
  const k = key + ':' + size;
  let p = cache.get(k);
  if (!p) {
    p = (async () => {
      try {
        const d = await ambientEngine().decode(bytes, { max_dim: size * 2 }).promise;
        return ditheredThumb(d.rgba, d.width, d.height, size).toDataURL('image/png');
      } catch {
        return null;
      }
    })();
    cache.set(k, p);
    if (cache.size > 400) cache.delete(cache.keys().next().value as string);
  }
  return p;
}
