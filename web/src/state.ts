// The project: photo pool, the main recipe stack, per-photo one-level stacks, recycle bin, undo history,
// autosave to IndexedDB and .rfg project files.
import type { StackNode } from './engine/stack';
import { PROJECT_EXT } from './brand';
import { History } from './engine/history';
import { hashString, stableJson, uid } from './engine/hash';
import { kvGet, kvSet, kvDelete, kvKeys } from './engine/storage';
import { zipStore, unzip } from './engine/zip';
import { APP_VERSION } from './engine/recipe';

export type PhotoSource = 'user' | 'bundled' | 'placeholder' | 'recovered' | 'webcam';

export interface PhotoData {
  uid: string;
  name: string;
  source: PhotoSource;
  bytes: Uint8Array;
  version: number;
  license?: string;
  note?: string;
  width?: number;
  height?: number;
}

export interface ProjectDoc {
  stack: StackNode[];
  current: string | null;
  /** Pool order (photo uids). Photos not listed here are in the recycle bin or unused. */
  order: string[];
  /** Optional one-level stacks of pool photos (Q10). */
  photoStacks: Record<string, StackNode[]>;
  name: string;
}

export interface RecycleItem {
  id: string;
  kind: 'step' | 'photo' | 'project';
  label: string;
  deletedAt: number;
  data: any;
}

type Listener = (why: string) => void;

const EMPTY: ProjectDoc = { stack: [], current: null, order: [], photoStacks: {}, name: 'Untitled' };

class Store {
  doc: ProjectDoc = JSON.parse(JSON.stringify(EMPTY));
  photos = new Map<string, PhotoData>();
  bin: RecycleItem[] = [];
  history = new History<ProjectDoc>(this.doc);
  private listeners = new Set<Listener>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private savedPhotos = new Set<string>();
  loaded = false;
  loadedFromSave = false;

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  emit(why: string) {
    for (const l of this.listeners) l(why);
  }

  /** Apply an undoable edit. `merge` collapses rapid edits with the same key into one undo step. */
  update(f: (d: ProjectDoc) => ProjectDoc | void, why = 'edit', merge: string | null = null) {
    const draft: ProjectDoc = JSON.parse(JSON.stringify(this.doc));
    const res = f(draft) ?? draft;
    this.doc = res;
    this.history.push(this.doc, merge);
    this.emit(why);
    this.scheduleSave();
  }

  undo() {
    const s = this.history.undo();
    if (s) {
      this.doc = s;
      this.emit('undo');
      this.scheduleSave();
    }
  }

  redo() {
    const s = this.history.redo();
    if (s) {
      this.doc = s;
      this.emit('redo');
      this.scheduleSave();
    }
  }

  get current(): PhotoData | null {
    return this.doc.current ? this.photos.get(this.doc.current) ?? null : null;
  }

  pool(): PhotoData[] {
    return this.doc.order.map((u) => this.photos.get(u)).filter((p): p is PhotoData => !!p);
  }

  addPhoto(p: Omit<PhotoData, 'uid' | 'version'> & { uid?: string }, opts: { makeCurrent?: boolean; front?: boolean } = {}): PhotoData {
    const id = p.uid ?? (p.source === 'bundled' ? 'bundled:' + p.name : p.source === 'placeholder' ? 'ph:' + uid('') : 'user:' + uid(''));
    const existing = this.photos.get(id);
    const photo: PhotoData = { ...p, uid: id, version: (existing?.version ?? 0) + 1 };
    this.photos.set(id, photo);
    this.update((d) => {
      if (!d.order.includes(id)) {
        if (opts.front) d.order.unshift(id);
        else d.order.push(id);
      }
      if (opts.makeCurrent || !d.current) d.current = id;
    }, 'photos');
    return photo;
  }

  /** Replace a photo's bytes (e.g. "Apply" a stack, or downscale) — not undoable for the bytes themselves. */
  replacePhotoBytes(id: string, bytes: Uint8Array) {
    const p = this.photos.get(id);
    if (!p) return;
    p.bytes = bytes;
    p.version++;
    this.savedPhotos.delete(id);
    this.emit('photos');
    this.scheduleSave();
  }

  renamePhoto(id: string, name: string) {
    const p = this.photos.get(id);
    if (!p) return;
    p.name = name;
    this.savedPhotos.delete(id);
    this.emit('photos');
    this.scheduleSave();
  }

  removePhoto(id: string) {
    const p = this.photos.get(id);
    if (!p) return;
    this.bin.unshift({ id: uid('b'), kind: 'photo', label: p.name, deletedAt: Date.now(), data: { uid: id, stack: this.doc.photoStacks[id] ?? [] } });
    this.update((d) => {
      d.order = d.order.filter((u) => u !== id);
      if (d.current === id) d.current = d.order[0] ?? null;
    }, 'photos');
    this.emit('bin');
  }

  binStep(node: StackNode, label: string) {
    this.bin.unshift({ id: uid('b'), kind: 'step', label, deletedAt: Date.now(), data: node });
    this.emit('bin');
    this.scheduleSave();
  }

  restore(itemId: string) {
    const it = this.bin.find((b) => b.id === itemId);
    if (!it) return;
    this.bin = this.bin.filter((b) => b !== it);
    if (it.kind === 'photo') {
      const id = it.data.uid as string;
      if (this.photos.has(id))
        this.update((d) => {
          if (!d.order.includes(id)) d.order.push(id);
          if (it.data.stack?.length) d.photoStacks[id] = it.data.stack;
          if (!d.current) d.current = id;
        }, 'photos');
    } else if (it.kind === 'step') {
      this.update((d) => {
        d.stack.push(it.data);
      }, 'stack');
    } else if (it.kind === 'project') {
      void this.loadProjectZip(it.data as Uint8Array);
    }
    this.emit('bin');
    this.scheduleSave();
  }

  emptyBin() {
    const keep = new Set(this.doc.order);
    for (const it of this.bin) if (it.kind === 'photo' && !keep.has(it.data.uid)) this.photos.delete(it.data.uid);
    this.bin = [];
    this.emit('bin');
    this.scheduleSave();
  }

  /** Signature of a pool photo's current bytes (its bytes version + its own one-level stack). */
  photoKey(id: string): string {
    const p = this.photos.get(id);
    return id + '@' + (p?.version ?? 0) + ':' + hashString(stableJson(this.doc.photoStacks[id] ?? []));
  }

  // ----------------------------------------------------------- autosave

  scheduleSave() {
    if (!this.loaded) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveNow(), 800);
  }

  async saveNow() {
    this.saveTimer = null;
    const live = new Set<string>([...this.doc.order, ...this.bin.filter((b) => b.kind === 'photo').map((b) => b.data.uid as string)]);
    for (const id of live) {
      if (this.savedPhotos.has(id)) continue;
      const p = this.photos.get(id);
      if (!p || p.source === 'placeholder' || p.source === 'bundled') continue; // re-created / re-fetched on load
      await kvSet('photo:' + id, { ...p });
      this.savedPhotos.add(id);
    }
    for (const k of await kvKeys('photo:')) if (!live.has(k.slice(6))) await kvDelete(k);
    await kvSet('project', { doc: this.doc, bin: this.bin.filter((b) => b.kind !== 'project'), app: APP_VERSION });
  }

  async restoreAutosave(): Promise<boolean> {
    const saved = await kvGet<{ doc: ProjectDoc; bin: RecycleItem[] }>('project');
    if (!saved || !saved.doc) {
      this.loaded = true;
      return false;
    }
    for (const k of await kvKeys('photo:')) {
      const p = await kvGet<PhotoData>(k);
      if (p && p.bytes) {
        this.photos.set(p.uid, p);
        this.savedPhotos.add(p.uid);
      }
    }
    this.doc = { ...EMPTY, ...saved.doc };
    this.doc.order = this.doc.order.filter((u) => this.photos.has(u) || u.startsWith('ph:') || u.startsWith('bundled:'));
    this.bin = saved.bin ?? [];
    this.history.reset(this.doc);
    this.loaded = true;
    this.loadedFromSave = true;
    this.emit('load');
    return true;
  }

  /** "Shut Down…": clears the session (photos, stack, bin) but keeps preferences. */
  async clearSession() {
    for (const k of await kvKeys('photo:')) await kvDelete(k);
    await kvDelete('project');
    this.photos.clear();
    this.savedPhotos.clear();
    this.bin = [];
    this.doc = JSON.parse(JSON.stringify(EMPTY));
    this.history.reset(this.doc);
    this.emit('load');
  }

  // ----------------------------------------------------------- .rfg project files (Q16; old .jpegit still open)

  projectZip(): Uint8Array {
    const entries = [] as { name: string; data: Uint8Array }[];
    const meta = {
      format: 'refragmenter-project',
      version: 1,
      app: APP_VERSION,
      doc: this.doc,
      photos: this.pool().map((p) => ({ uid: p.uid, name: p.name, source: p.source, license: p.license, note: p.note, file: 'photos/' + safeName(p.uid) + '.jpg' })),
    };
    entries.push({ name: 'project.json', data: new TextEncoder().encode(JSON.stringify(meta, null, 1)) });
    for (const p of this.pool()) entries.push({ name: 'photos/' + safeName(p.uid) + '.jpg', data: p.bytes });
    return zipStore(entries);
  }

  async loadProjectZip(buf: Uint8Array) {
    const files = await unzip(buf);
    const pj = files.find((f) => f.name === 'project.json');
    if (!pj) throw new Error(`This ZIP has no project.json — is it a ${PROJECT_EXT} project?`);
    const meta = JSON.parse(new TextDecoder().decode(pj.data));
    if (meta.format !== 'refragmenter-project' && meta.format !== 'jpegit-project') throw new Error('Not a File Refragmenter project.');
    // the current session goes to the Recycle Bin first, so loading is never destructive
    if (this.doc.order.length) {
      this.bin.unshift({ id: uid('b'), kind: 'project', label: this.doc.name + ' (before opening another project)', deletedAt: Date.now(), data: this.projectZip() });
    }
    this.photos.clear();
    this.savedPhotos.clear();
    for (const ph of meta.photos ?? []) {
      const f = files.find((x) => x.name === ph.file);
      if (!f) continue;
      this.photos.set(ph.uid, { uid: ph.uid, name: ph.name, source: ph.source, license: ph.license, note: ph.note, bytes: f.data, version: 1 });
    }
    this.doc = { ...EMPTY, ...meta.doc };
    this.doc.order = this.doc.order.filter((u: string) => this.photos.has(u));
    if (this.doc.current && !this.photos.has(this.doc.current)) this.doc.current = this.doc.order[0] ?? null;
    this.history.reset(this.doc);
    this.emit('load');
    this.emit('bin');
    this.scheduleSave();
  }
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_');
}

export const store = new Store();
