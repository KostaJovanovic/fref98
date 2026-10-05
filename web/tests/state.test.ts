// The project store against an in-memory autosave: failed writes, overlapping saves, the Recycle Bin and undo
// (audit B3).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { kv, ctl } = vi.hoisted(() => ({
  kv: new Map<string, unknown>(),
  ctl: { fail: false, slow: '' as string, gate: null as Promise<void> | null },
}));

vi.mock('../src/engine/storage', () => ({
  kvGet: async (k: string) => kv.get(k),
  kvSet: async (k: string, v: unknown) => {
    // only the first write of the slow key waits
    if (k === ctl.slow && ctl.gate) {
      const g = ctl.gate;
      ctl.gate = null;
      await g;
    }
    if (ctl.fail) return false;
    kv.set(k, v);
    return true;
  },
  kvDelete: async (k: string) => void kv.delete(k),
  kvKeys: async (p: string) => [...kv.keys()].filter((k) => k.startsWith(p)),
  onStorageError: () => () => {},
}));

import { Store } from '../src/state';
import { makeStep, makeRepeat, type StepItem } from '../src/engine/stack';

const bytes = (n: number) => new Uint8Array([0xff, 0xd8, n, 0xff, 0xd9]);

function fresh(): Store {
  const s = new Store();
  s.loaded = true;
  return s;
}

function addUser(s: Store, name: string, n = 1) {
  return s.addPhoto({ name, source: 'user', bytes: bytes(n) });
}

beforeEach(() => {
  kv.clear();
  ctl.fail = false;
  ctl.slow = '';
  ctl.gate = null;
});

describe('autosave', () => {
  // 07-8 / 04-1: a write that failed used to mark the photo as saved, so it was never written
  it('a photo whose write failed is written by the next save', async () => {
    const s = fresh();
    const p = addUser(s, 'a.jpg');
    ctl.fail = true;
    await s.saveNow();
    expect(kv.has('photo:' + p.uid)).toBe(false);
    ctl.fail = false;
    await s.saveNow();
    expect(kv.has('photo:' + p.uid)).toBe(true);
  });

  // 04-2: an older save still running used to delete the photo a newer save had just written
  it('overlapping saves never delete a newer photo', async () => {
    const s = fresh();
    const p1 = addUser(s, 'a.jpg');
    let open!: () => void;
    ctl.slow = 'photo:' + p1.uid;
    ctl.gate = new Promise<void>((r) => (open = r));
    const a = s.saveNow();
    const p2 = addUser(s, 'b.jpg', 2);
    const b = s.saveNow();
    open();
    await Promise.all([a, b]);
    expect(kv.has('photo:' + p1.uid)).toBe(true);
    expect(kv.has('photo:' + p2.uid)).toBe(true);
    const saved = kv.get('project') as { doc: { order: string[] } };
    expect(saved.doc.order).toEqual([p1.uid, p2.uid]);
  });

  // 05-7: a replaced project in the bin was not saved, so it was gone after a reload
  it('a replaced project in the bin survives a reload', async () => {
    const s = fresh();
    addUser(s, 'old.jpg');
    const other = fresh();
    addUser(other, 'new.jpg', 2);
    await s.loadProjectZip(other.projectZip());
    expect(s.bin[0].kind).toBe('project');
    await s.saveNow();
    const r = fresh();
    r.loaded = false;
    await r.restoreAutosave();
    expect(r.bin.map((b) => b.kind)).toEqual(['project']);
    expect(r.bin[0].data).toBeInstanceOf(Uint8Array);
    expect(await r.restore(r.bin[0].id)).toBe(true);
    expect(r.pool().map((p) => p.name)).toEqual(['old.jpg']);
  });

  // Shut Down ▸ forget used to race a save still running, which wrote the old session back
  it('forgetting the session waits for a running save', async () => {
    const s = fresh();
    const p = addUser(s, 'a.jpg');
    let open!: () => void;
    ctl.slow = 'photo:' + p.uid;
    ctl.gate = new Promise<void>((r) => (open = r));
    const a = s.saveNow();
    const c = s.clearSession();
    open();
    await Promise.all([a, c]);
    expect([...kv.keys()]).toEqual([]);
    expect(s.loadedFromSave).toBe(false);
  });
});

describe('Recycle Bin', () => {
  // 05-8: opening a project used to throw away the bytes of photos in the bin
  it('photos in the bin keep their bytes when a project is opened', async () => {
    const s = fresh();
    const keep = addUser(s, 'keep.jpg');
    const gone = addUser(s, 'binned.jpg', 2);
    s.removePhoto(gone.uid);
    const other = fresh();
    addUser(other, 'new.jpg', 3);
    await s.loadProjectZip(other.projectZip());
    const item = s.bin.find((b) => b.kind === 'photo')!;
    expect(await s.restore(item.id)).toBe(true);
    expect(s.pool().map((p) => p.name)).toEqual(['new.jpg', 'binned.jpg']);
    expect(s.photos.has(keep.uid)).toBe(false);
  });

  it('a binned photo whose uid the opened project also uses keeps its own bytes', async () => {
    const s = fresh();
    const p = s.addPhoto({ uid: 'user:same', name: 'mine.jpg', source: 'user', bytes: bytes(1) });
    addUser(s, 'other.jpg', 9);
    s.removePhoto(p.uid);
    const other = fresh();
    other.addPhoto({ uid: 'user:same', name: 'theirs.jpg', source: 'user', bytes: bytes(2) });
    await s.loadProjectZip(other.projectZip());
    const item = s.bin.find((b) => b.kind === 'photo')!;
    await s.restore(item.id);
    expect(s.pool().map((x) => [x.name, x.bytes[2]])).toEqual([
      ['theirs.jpg', 2],
      ['mine.jpg', 1],
    ]);
  });

  // 05-9 / 04-7: a step deleted from a photo's own steps used to come back in the main recipe
  it('own steps are restored into their photo, at their place', async () => {
    const s = fresh();
    const p = addUser(s, 'a.jpg');
    const [x, y, z] = ['x', 'y', 'z'].map((id) => makeStep(id, undefined));
    s.update((d) => void (d.photoStacks[p.uid] = [x, y, z]));
    s.binStep(y, 'y');
    s.update((d) => void (d.photoStacks[p.uid] = [x, z]));
    expect(await s.restore(s.bin[0].id)).toBe(true);
    expect(s.doc.photoStacks[p.uid].map((n) => n.uid)).toEqual([x.uid, y.uid, z.uid]);
    expect(s.doc.stack).toEqual([]);
  });

  it('a step deleted from inside a repeat goes back into it', async () => {
    const s = fresh();
    const a = makeStep('a', undefined);
    const b = makeStep('b', undefined);
    const rep = makeRepeat(2, [a, b]);
    s.update((d) => void (d.stack = [rep]));
    s.binStep(a, 'a');
    s.update((d) => void (d.stack = [{ ...rep, children: [b] }]));
    await s.restore(s.bin[0].id);
    expect((s.doc.stack[0] as typeof rep).children.map((c: StepItem) => c.uid)).toEqual([a.uid, b.uid]);
  });

  // 04-8: undoing a step delete left the step in the bin too, so Restore made a second copy
  it('undo of a step delete takes it out of the bin; redo puts it back', () => {
    const s = fresh();
    const a = makeStep('a', undefined);
    s.update((d) => void (d.stack = [a]));
    s.binStep(a, 'a');
    s.update((d) => void (d.stack = []));
    expect(s.bin.length).toBe(1);
    s.undo();
    expect(s.doc.stack.length).toBe(1);
    expect(s.bin.length).toBe(0);
    s.redo();
    expect(s.doc.stack.length).toBe(0);
    expect(s.bin.length).toBe(1);
  });

  // 05-10: the same for photos
  it('undo of a photo delete takes it out of the bin', () => {
    const s = fresh();
    const p = addUser(s, 'a.jpg');
    s.removePhoto(p.uid);
    expect(s.bin.length).toBe(1);
    s.undo();
    expect(s.doc.order).toEqual([p.uid]);
    expect(s.bin.length).toBe(0);
  });

  it('undo of a restore sends the item back to the bin', async () => {
    const s = fresh();
    const a = makeStep('a', undefined);
    s.update((d) => void (d.stack = [a]));
    s.binStep(a, 'a');
    s.update((d) => void (d.stack = []));
    await s.restore(s.bin[0].id);
    s.undo();
    expect(s.doc.stack.length).toBe(0);
    expect(s.bin.length).toBe(1);
  });

  // 07-10: undo after Empty Bin used to bring back the uid of a photo whose bytes were gone
  it('undo after Empty Bin does not bring back a deleted photo', () => {
    const s = fresh();
    const keep = addUser(s, 'keep.jpg');
    const p = addUser(s, 'a.jpg', 2);
    s.update((d) => void (d.current = p.uid));
    s.removePhoto(p.uid);
    s.emptyBin();
    expect(s.photos.has(p.uid)).toBe(false);
    // back to before the delete
    s.undo();
    expect(s.doc.order).toEqual([keep.uid]);
    expect(s.doc.current).toBe(keep.uid);
    expect(s.bin.length).toBe(0);
  });

  // state.ts restore of a project had no catch: a project that failed to open was lost from the bin
  it('a project that fails to open stays in the bin', async () => {
    const s = fresh();
    s.bin.unshift({ id: 'b1', kind: 'project', label: 'broken', deletedAt: 0, data: new Uint8Array([1, 2, 3]) });
    expect(await s.restore('b1')).toBe(false);
    expect(s.bin.map((b) => b.id)).toEqual(['b1']);
  });

  // 05-11 + 04-6: the Recycle window and the desktop icon missed bin changes that came with a whole new session
  it('loading, opening and forgetting a session tell bin listeners', async () => {
    const s = fresh();
    addUser(s, 'a.jpg');
    await s.saveNow();
    const seen: string[] = [];
    s.on((why) => seen.push(why));
    const other = fresh();
    addUser(other, 'b.jpg');
    await s.loadProjectZip(other.projectZip());
    await s.clearSession();
    const r = fresh();
    r.on((why) => seen.push('r:' + why));
    kv.set('project', { doc: { order: [] }, bin: [] });
    await r.restoreAutosave();
    expect(seen.filter((w) => w === 'bin').length).toBe(2);
    expect(seen).toContain('r:bin');
  });

  it('a photo whose bytes are gone reports failure', async () => {
    const s = fresh();
    s.bin.unshift({ id: 'b2', kind: 'photo', label: 'lost.jpg', deletedAt: 0, data: { uid: 'user:nope' } });
    expect(await s.restore('b2')).toBe(false);
  });
});
