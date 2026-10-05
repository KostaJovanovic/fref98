// Recipe JSON (the stack without photos) and URL-fragment sharing (only when every referenced photo is a
// bundled one, Q42).
import type { StackNode, StepItem } from './stack';
import { uid } from './hash';
import { inflateRaw } from './zip';

export { VERSION as APP_VERSION } from '../version';

/** Recipes saved before the rename say 'jpegit-recipe'; both are read. */
const FORMATS = ['refragmenter-recipe', 'jpegit-recipe'];

export interface Recipe {
  format: 'refragmenter-recipe';
  version: 1;
  engine: string;
  /** Source photo when it is a bundled one ("bundled:<id>"), so a link reproduces the whole image. */
  source?: string;
  steps: StackNode[];
}

export function toRecipe(steps: StackNode[], engine: string, source?: string): Recipe {
  return { format: 'refragmenter-recipe', version: 1, engine, source, steps: JSON.parse(JSON.stringify(steps)) };
}

function validStep(s: any): s is StepItem {
  return s && s.type === 'step' && typeof s.id === 'string' && typeof s.params === 'object' && s.params !== null;
}

/** Parses and sanitises a recipe; fresh uids are assigned so it can be merged into any project. */
export function parseRecipe(json: string | object): Recipe {
  const r: any = typeof json === 'string' ? JSON.parse(json) : json;
  if (!r || !FORMATS.includes(r.format) || !Array.isArray(r.steps)) throw new Error('This is not a File Refragmenter recipe.');
  const steps: StackNode[] = [];
  const fixStep = (s: any): StepItem => ({
    type: 'step',
    uid: uid('s'),
    id: String(s.id),
    params: { ...s.params },
    seed: Number(s.seed) >>> 0,
    enabled: s.enabled !== false,
  });
  for (const s of r.steps) {
    if (validStep(s)) steps.push(fixStep(s));
    else if (s && s.type === 'repeat' && Array.isArray(s.children)) {
      steps.push({
        type: 'repeat',
        uid: uid('r'),
        times: Math.max(1, Math.min(500, Number(s.times) | 0)),
        seed: Number(s.seed) >>> 0,
        enabled: s.enabled !== false,
        children: s.children.filter(validStep).map(fixStep),
      });
    } else if (s && s.type === 'patch' && Array.isArray(s.patches)) {
      steps.push({
        type: 'patch',
        uid: uid('p'),
        enabled: s.enabled !== false,
        baseHash: String(s.baseHash ?? ''),
        patches: s.patches
          .filter((p: any) => p && Number.isFinite(p.offset) && Array.isArray(p.bytes))
          .map((p: any) => ({ offset: p.offset | 0, bytes: p.bytes.map((x: any) => Number(x) & 255) })),
      });
    }
  }
  return { format: 'refragmenter-recipe', version: 1, engine: String(r.engine ?? ''), source: typeof r.source === 'string' ? r.source : undefined, steps };
}

/** Photo uids referenced by photo params (strings) anywhere in the recipe. */
export function referencedPhotos(steps: StackNode[]): string[] {
  const out = new Set<string>();
  const visit = (s: StepItem) => {
    for (const v of Object.values(s.params)) if (typeof v === 'string' && /^(bundled|user|ph):/.test(v)) out.add(v);
  };
  for (const n of steps) {
    if (n.type === 'step') visit(n);
    else if (n.type === 'repeat') n.children.forEach(visit);
  }
  return [...out];
}

/** Photos anyone can get without the user's files: bundled ones and the generated placeholders. */
export function isPublicPhoto(uid: string): boolean {
  return uid.startsWith('bundled:') || uid.startsWith('ph:');
}

/** The recipe as it goes into a link: a private source photo is left out (the recipient's own photo is used). */
export function linkRecipe(recipe: Recipe): Recipe {
  return recipe.source && !isPublicPhoto(recipe.source) ? { ...recipe, source: undefined } : recipe;
}

export function canShareAsLink(recipe: Recipe): boolean {
  const refs = referencedPhotos(recipe.steps);
  return refs.every(isPublicPhoto) && !recipe.steps.some((s) => s.type === 'patch');
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(data: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(t);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** "#r=<data>": deflate-raw + base64url when CompressionStream exists, else "#j=<base64url json>". */
export async function recipeToFragment(r: Recipe): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(r));
  if (typeof CompressionStream !== 'undefined') {
    const z = await pipe(json, new CompressionStream('deflate-raw'));
    return '#r=' + b64url(z);
  }
  return '#j=' + b64url(json);
}

export async function recipeFromFragment(hash: string): Promise<Recipe | null> {
  const m = /^#?(r|j)=([A-Za-z0-9_-]+)/.exec(hash);
  if (!m) return null;
  let bytes = unb64url(m[2]);
  if (m[1] === 'r') bytes = await inflateRaw(bytes);
  return parseRecipe(new TextDecoder().decode(bytes));
}
