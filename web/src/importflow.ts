// Getting things in: dropped/picked files (photos, .rfg projects, recipes, AVIs) and the sample photos.
import { store } from './state';
import { classify, importPhotoFile } from './engine/importer';
import { loadManifest, fetchBundled, makePlaceholder, PLACEHOLDER_IDS } from './engine/bundled';
import { parseRecipe } from './engine/recipe';
import { errorBox, confirmBox, progressDialog, progressDone } from './ui/dialog';
import { openApp } from './apps/registry';
import { PROJECT_NAME_EXT } from './brand';
import * as bus from './bus';

export async function importFiles(files: File[], opts: { makeCurrent?: boolean } = {}) {
  if (!files.length) return;
  const photos: File[] = [];
  for (const f of files) {
    const head = new Uint8Array(await f.slice(0, 16).arrayBuffer());
    const kind = classify(f, head);
    if (kind === 'project') {
      try {
        await store.loadProjectZip(new Uint8Array(await f.arrayBuffer()));
        store.doc.name = f.name.replace(PROJECT_NAME_EXT, '');
        bus.emit('photo-loaded');
      } catch (e) {
        errorBox(`Could not open ${f.name}: ${(e as Error).message}`);
      }
    } else if (kind === 'recipe') {
      try {
        const r = parseRecipe(await f.text());
        await applyRecipe(r.steps);
      } catch (e) {
        errorBox(`${f.name}: ${(e as Error).message}`);
      }
    } else if (kind === 'avi') {
      openApp('video', { file: f });
    } else if (kind === 'photo') photos.push(f);
    else {
      bus.emit('unreadable');
      errorBox(`${f.name}: File Refragmenter can't use this kind of file.`);
    }
  }
  if (!photos.length) return;
  const prog = photos.length > 2 ? progressDialog('Copying photos', { say: 'Copying your photos into My Pictures… they stay on this computer.' }) : null;
  let first = true;
  let i = 0;
  for (const f of photos) {
    if (prog?.cancelled) break;
    prog?.set(i / photos.length, `Copying ${f.name} (${i + 1} of ${photos.length})…`);
    try {
      const p = await importPhotoFile(f);
      store.addPhoto({ name: p.name, source: 'user', bytes: p.bytes, note: p.note, width: p.width, height: p.height }, { makeCurrent: first && opts.makeCurrent !== false, front: false });
      first = false;
    } catch (e) {
      bus.emit('unreadable');
      errorBox(`${f.name}: ${(e as Error).message}`);
    }
    i++;
  }
  if (prog) progressDone(prog);
  if (!first) bus.emit('photo-loaded');
}

export async function applyRecipe(steps: import('./engine/stack').StackNode[]) {
  if (store.doc.stack.length) {
    const ok = await confirmBox('Load recipe', 'Replace the current steps with this recipe? (Undo brings them back.)', 'Replace');
    if (!ok) return;
  }
  store.update((d) => {
    d.stack = steps;
  }, 'stack');
}

let samplesP: Promise<void> | null = null;

/** After Shut Down ▸ forget: the next ensureSamples() puts the samples back in the emptied pool. */
export function resetSamples() {
  samplesP = null;
}

/** Makes sure the bundled photos (or generated placeholders) are in the pool. */
export function ensureSamples(): Promise<void> {
  if (samplesP) return samplesP;
  samplesP = (async () => {
    const manifest = await loadManifest();
    if (manifest.length) {
      for (const e of manifest) {
        const uid = 'bundled:' + e.id;
        if (store.photos.has(uid)) continue;
        try {
          const bytes = await fetchBundled(e);
          store.photos.set(uid, { uid, name: e.name, source: 'bundled', bytes, version: 1, license: e.license, note: e.author ? `by ${e.author}` : undefined });
          if (!store.doc.order.includes(uid) && !store.bin.some((b) => b.kind === 'photo' && b.data.uid === uid) && !store.loadedFromSave) store.doc.order.push(uid);
        } catch {
          /* a missing bundled file is not fatal */
        }
      }
    } else {
      for (const id of PLACEHOLDER_IDS) {
        if (store.photos.has(id)) continue;
        const p = await makePlaceholder(id);
        if (!p) continue;
        store.photos.set(p.uid, { uid: p.uid, name: p.name, source: 'placeholder', bytes: p.bytes, version: 1, note: 'Generated placeholder. The real bundled photos are supplied later.' });
        if (!store.doc.order.includes(p.uid) && !store.loadedFromSave) store.doc.order.push(p.uid);
      }
    }
    store.history.reset(store.doc);
    store.emit('photos');
  })();
  // a failed load (no network, storage full) is tried again next time instead of failing for good
  samplesP.catch(() => (samplesP = null));
  return samplesP;
}

export async function useSample() {
  await ensureSamples();
  const first = store.doc.order.find((u) => u.startsWith('bundled:') || u.startsWith('ph:')) ?? store.doc.order[0];
  if (!first) return;
  store.update((d) => {
    d.current = first;
  }, 'photos');
  bus.emit('photo-loaded');
}
