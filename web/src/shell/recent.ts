// Start ▸ Documents: the last six saved projects, each with its file kept in the autosave database.
import { kvGet, kvSet, kvKeys, kvDelete } from '../engine/storage';

const RECENT_KEY = 'recent-projects';
const MAX = 6;
export type Recent = { name: string; at: number };
let recent: Recent[] = [];

/** The list as last loaded (newest first). */
export function recentProjects(): Recent[] {
  return recent;
}

export async function loadRecent() {
  recent = (await kvGet<Recent[]>(RECENT_KEY)) ?? [];
}

export async function rememberProject(name: string, zip: Uint8Array) {
  const list = ((await kvGet<Recent[]>(RECENT_KEY)) ?? []).filter((r) => r.name !== name);
  list.unshift({ name, at: Date.now() });
  await kvSet('recent:' + name, zip);
  recent = list.slice(0, MAX);
  await kvSet(RECENT_KEY, recent);
  // the files of projects that fell off the list
  const keep = new Set(recent.map((r) => 'recent:' + r.name));
  for (const k of await kvKeys('recent:')) if (!keep.has(k)) await kvDelete(k);
}

export function recentZip(name: string): Promise<Uint8Array | undefined> {
  return kvGet<Uint8Array>('recent:' + name);
}

/** Shut Down ▸ forget: the recent projects go with the session. */
export async function forgetRecent() {
  recent = [];
  for (const k of await kvKeys('recent:')) await kvDelete(k);
  await kvDelete(RECENT_KEY);
}
