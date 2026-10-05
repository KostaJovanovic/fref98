// The project: photo pool, the main recipe stack, per-photo one-level stacks, recycle bin, undo history,
// autosave to IndexedDB and .rfg project files.
import { findNode, type StackNode } from './engine/stack';
import { PROJECT_EXT } from './brand';
import { History } from './engine/history';
import { hashString, stableJson, uid } from './engine/hash';
import { kvGet, kvSet, kvDelete, kvKeys } from './engine/storage';
import { zipStore, unzip } from './engine/zip';
import { APP_VERSION } from './engine/recipe';
import * as bus from './bus';
import { link } from './editor/link';

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

/** Where a deleted step was: a photo's own steps (`owner`) or the main recipe, inside a repeat (`parent`) or not. */
export interface StepPlace {
  owner?: string;
  parent?: string;
  index: number;
}

export interface RecycleItem {
  id: string;
  kind: 'step' | 'photo' | 'project';
  label: string;
  deletedAt: number;
  data: any;
  /** Steps only. Missing on items from older saves: those go to the end of the main recipe. */
  place?: StepPlace;
}

type Listener = (why: string) => void;

const EMPTY: ProjectDoc = { stack: [], current: null, order: [], photoStacks: {}, name: 'Untitled' };
/** Autosave key of a replaced project kept in the Recycle Bin (the bin entry itself stores no bytes). */
const BIN_PROJECT = 'binproject:';

export class Store {
  doc: ProjectDoc = JSON.parse(JSON.stringify(EMPTY));
  photos = new Map<string, PhotoData>();
  bin: RecycleItem[] = [];
  history = new History<ProjectDoc>(this.doc);
  private listeners = new Set<Listener>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private savedPhotos = new Set<string>();
  private savedProjects = new Set<string>();
  /** Saves (and Shut Down's clear) run one after another, never interleaved. */
  private saving: Promise<void> = Promise.resolve();
  /** Bin items taken out because an undo brought them back; a redo that deletes them again returns them. */
  private unbinned = new Map<string, RecycleItem>();
  loaded = false;
  loadedFromSave = false;

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  emit(why: string) {
    link.follow(this.doc.current);
    for (const l of this.listeners) l(why);
  }

  /** Apply an undoable edit. `merge` collapses rapid edits with the same key into one undo step. */
  update(f: (d: ProjectDoc) => ProjectDoc | void, why = 'edit', merge: string | null = null) {
    const draft: ProjectDoc = JSON.parse(JSON.stringify(this.doc));
    const res = f(draft) ?? draft;
    this.doc = res;
    this.history.push(this.doc, merge);
    // a new edit ends the redo chain
    this.unbinned.clear();
    this.emit(why);
    this.scheduleSave();
  }

  undo() {
    const s = this.history.undo();
    if (s) {
      this.doc = s;
      this.reconcileBin();
      this.emit('undo');
      bus.emit('undo');
      this.scheduleSave();
    }
  }

  redo() {
    const s = this.history.redo();
    if (s) {
      this.doc = s;
      this.reconcileBin();
      this.emit('redo');
      this.scheduleSave();
    }
  }

  /** After undo/redo: a deleted step or photo that is back in the project leaves the bin (so restoring it can't
   *  duplicate it), and one deleted again by a redo goes back in. */
  private reconcileBin() {
    const inDoc = (it: RecycleItem) => (it.kind === 'photo' ? this.doc.order.includes(it.data?.uid) : it.kind === 'step' ? hasStep(this.doc, it.data?.uid) : false);
    let changed = false;
    for (const it of this.bin.filter(inDoc)) {
      this.unbinned.set(it.id, it);
      changed = true;
    }
    if (changed) this.bin = this.bin.filter((b) => !this.unbinned.has(b.id));
    for (const [id, it] of this.unbinned) {
      if (inDoc(it) || this.bin.includes(it)) continue;
      this.unbinned.delete(id);
      if (it.kind === 'photo' && !this.photos.has(it.data.uid)) continue;
      this.bin.unshift(it);
      changed = true;
    }
    if (changed) this.emit('bin');
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
    this.savedPhotos.delete(id);
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

  /** Call before the step is removed from the project: its place is recorded so Restore puts it back there. */
  binStep(node: StackNode, label: string) {
    this.bin.unshift({ id: uid('b'), kind: 'step', label, deletedAt: Date.now(), data: node, place: locateStep(this.doc, node.uid) });
    this.emit('bin');
    this.scheduleSave();
  }

  /** Puts a bin item back. False when it can't be (its photo is gone, the project file doesn't open); a project
   *  that fails to open stays in the bin. */
  async restore(itemId: string): Promise<boolean> {
    const it = this.bin.find((b) => b.id === itemId);
    if (!it) return false;
    const at = this.bin.indexOf(it);
    this.bin = this.bin.filter((b) => b !== it);
    let ok = true;
    if (it.kind === 'photo') {
      const id = it.data.uid as string;
      ok = this.photos.has(id);
      if (ok)
        this.update((d) => {
          if (!d.order.includes(id)) d.order.push(id);
          if (it.data.stack?.length) d.photoStacks[id] = it.data.stack;
          if (!d.current) d.current = id;
        }, 'photos');
    } else if (it.kind === 'step') {
      const p = it.place;
      const owner = p?.owner && this.photos.has(p.owner) ? p.owner : undefined;
      // own steps of a photo that is gone for good go to the end of the main recipe
      const place = p?.owner && !owner ? undefined : p;
      this.update((d) => insertStep(d, it.data, place, owner), owner ? 'photos' : 'stack');
    } else if (it.kind === 'project') {
      try {
        if (!it.data) throw new Error('The project is no longer stored.');
        await this.loadProjectZip(it.data as Uint8Array);
      } catch (e) {
        console.warn('restore project failed', e);
        this.bin.splice(Math.min(at, this.bin.length), 0, it);
        ok = false;
      }
    }
    // undoing the restore sends it back to the bin
    if (ok && it.kind !== 'project') this.unbinned.set(it.id, it);
    this.emit('bin');
    this.scheduleSave();
    return ok;
  }

  /** Removes bin items for good (all of them without `ids`), and the photo bytes unless the photo is back in
   *  the pool. Undo can't bring a forgotten photo back: it leaves the history too. */
  forget(ids?: Set<string>) {
    const going = ids ? this.bin.filter((b) => ids.has(b.id)) : this.bin;
    const keep = new Set(this.doc.order);
    const gone = new Set<string>();
    for (const it of going)
      if (it.kind === 'photo' && !keep.has(it.data?.uid)) {
        this.photos.delete(it.data.uid);
        gone.add(it.data.uid);
      }
    this.bin = ids ? this.bin.filter((b) => !ids.has(b.id)) : [];
    for (const [id, it] of this.unbinned) if (it.kind === 'photo' && gone.has(it.data?.uid)) this.unbinned.delete(id);
    if (gone.size) this.history.rewrite((d) => dropPhotos(d, gone));
    this.emit('bin');
    this.scheduleSave();
  }

  emptyBin() {
    this.forget();
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

  /** Saves now, after any save still running. */
  saveNow(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    return this.queue(() => this.writeSave());
  }

  private queue(f: () => Promise<void>): Promise<void> {
    this.saving = this.saving.then(f).catch((e) => console.warn('autosave failed', e));
    return this.saving;
  }

  private livePhotos(): Set<string> {
    return new Set<string>([...this.doc.order, ...this.bin.filter((b) => b.kind === 'photo').map((b) => b.data.uid as string)]);
  }

  private async writeSave() {
    for (const id of this.livePhotos()) {
      if (this.savedPhotos.has(id)) continue;
      const p = this.photos.get(id);
      if (!p || p.source === 'placeholder' || p.source === 'bundled') continue; // re-created / re-fetched on load
      const snap = { ...p };
      // a failed write stays unsaved (tried again next time); so does a photo that changed meanwhile
      if ((await kvSet('photo:' + id, snap)) && this.photos.get(id) === p && p.bytes === snap.bytes && p.name === snap.name) this.savedPhotos.add(id);
    }
    for (const it of this.bin) if (it.kind === 'project' && it.data && !this.savedProjects.has(it.id) && (await kvSet(BIN_PROJECT + it.id, it.data))) this.savedProjects.add(it.id);
    // what to keep is worked out now, after the writes: the project may have changed in the meantime
    const live = this.livePhotos();
    for (const k of await kvKeys('photo:'))
      if (!live.has(k.slice(6))) {
        await kvDelete(k);
        this.savedPhotos.delete(k.slice(6));
      }
    const projects = new Set(this.bin.filter((b) => b.kind === 'project').map((b) => b.id));
    for (const k of await kvKeys(BIN_PROJECT))
      if (!projects.has(k.slice(BIN_PROJECT.length))) {
        await kvDelete(k);
        this.savedProjects.delete(k.slice(BIN_PROJECT.length));
      }
    const bin = this.bin.map((b) => (b.kind === 'project' ? { ...b, data: null } : b));
    await kvSet('project', { doc: this.doc, bin, app: APP_VERSION });
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
    const bin: RecycleItem[] = [];
    for (const it of saved.bin ?? []) {
      if (it.kind === 'project') {
        const zip = await kvGet<Uint8Array>(BIN_PROJECT + it.id);
        if (!zip) continue;
        it.data = zip;
        this.savedProjects.add(it.id);
      }
      bin.push(it);
    }
    this.bin = bin;
    this.history.reset(this.doc);
    this.loaded = true;
    this.loadedFromSave = true;
    this.emit('load');
    this.emit('bin');
    return true;
  }

  /** "Shut Down…": clears the session (photos, stack, bin) but keeps preferences. */
  clearSession(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    // after a save still running, so it can't write the old session back
    return this.queue(async () => {
      for (const k of [...(await kvKeys('photo:')), ...(await kvKeys(BIN_PROJECT))]) await kvDelete(k);
      await kvDelete('project');
      this.photos.clear();
      this.savedPhotos.clear();
      this.savedProjects.clear();
      this.unbinned.clear();
      this.bin = [];
      this.doc = JSON.parse(JSON.stringify(EMPTY));
      this.history.reset(this.doc);
      this.loadedFromSave = false;
      this.emit('load');
      this.emit('bin');
    });
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
    // photos in the Recycle Bin keep their bytes (they belong to no project); the rest are replaced
    const binned = new Map<string, RecycleItem>();
    for (const b of this.bin) if (b.kind === 'photo') binned.set(b.data.uid, b);
    for (const id of [...this.photos.keys()]) if (!binned.has(id)) this.photos.delete(id);
    for (const id of [...this.savedPhotos]) if (!binned.has(id)) this.savedPhotos.delete(id);
    for (const ph of meta.photos ?? []) {
      const f = files.find((x) => x.name === ph.file);
      if (!f) continue;
      const clash = binned.get(ph.uid);
      if (clash && this.photos.has(ph.uid)) {
        // same uid as a binned photo: the binned one moves to a new uid
        const nu = 'user:' + uid('');
        this.photos.set(nu, { ...this.photos.get(ph.uid)!, uid: nu, source: 'user' });
        clash.data = { ...clash.data, uid: nu };
        this.savedPhotos.delete(ph.uid);
        binned.delete(ph.uid);
      }
      this.photos.set(ph.uid, { uid: ph.uid, name: ph.name, source: ph.source, license: ph.license, note: ph.note, bytes: f.data, version: 1 });
    }
    this.doc = { ...EMPTY, ...meta.doc };
    this.doc.order = this.doc.order.filter((u: string) => this.photos.has(u) && !binned.has(u));
    if (this.doc.current && !this.doc.order.includes(this.doc.current)) this.doc.current = this.doc.order[0] ?? null;
    this.unbinned.clear();
    this.history.reset(this.doc);
    this.emit('load');
    this.emit('bin');
    this.scheduleSave();
  }
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_');
}

function hasStep(d: ProjectDoc, u: string): boolean {
  return !!findNode(d.stack, u) || Object.values(d.photoStacks).some((nodes) => !!findNode(nodes, u));
}

function locateStep(d: ProjectDoc, u: string): StepPlace | undefined {
  const lists: [string | undefined, StackNode[]][] = [[undefined, d.stack], ...Object.entries(d.photoStacks)];
  for (const [owner, nodes] of lists) {
    const i = nodes.findIndex((n) => n.uid === u);
    if (i >= 0) return { owner, index: i };
    for (const n of nodes)
      if (n.type === 'repeat') {
        const j = n.children.findIndex((c) => c.uid === u);
        if (j >= 0) return { owner, parent: n.uid, index: j };
      }
  }
  return undefined;
}

/** Puts a step back at `place` (in `owner`'s own steps when given), or at the end of the main recipe. */
function insertStep(d: ProjectDoc, node: StackNode, place: StepPlace | undefined, owner: string | undefined) {
  const list = owner ? (d.photoStacks[owner] ??= []) : d.stack;
  if (place?.parent && node.type === 'step') {
    const p = list.find((n) => n.uid === place.parent);
    if (p?.type === 'repeat') {
      p.children.splice(Math.min(place.index, p.children.length), 0, node);
      return;
    }
  }
  list.splice(Math.min(place?.index ?? list.length, list.length), 0, node);
}

/** A project state without the given (deleted for good) photos. */
function dropPhotos(d: ProjectDoc, gone: Set<string>): ProjectDoc {
  d.order = d.order.filter((u) => !gone.has(u));
  if (d.current && gone.has(d.current)) d.current = d.order[0] ?? null;
  for (const g of gone) delete d.photoStacks[g];
  return d;
}

export const store = new Store();
