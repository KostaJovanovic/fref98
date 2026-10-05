// Preferences and the session around it: foreign settings keys, a stored change during another dialog's
// preview, the recent projects list and Shut Down ▸ forget (audit B3).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { kv } = vi.hoisted(() => ({ kv: new Map<string, unknown>() }));

vi.mock('../src/engine/storage', () => ({
  kvGet: async (k: string) => kv.get(k),
  kvSet: async (k: string, v: unknown) => (kv.set(k, v), true),
  kvDelete: async (k: string) => void kv.delete(k),
  kvKeys: async (p: string) => [...kv.keys()].filter((k) => k.startsWith(p)),
  onStorageError: () => () => {},
}));
vi.mock('../src/engine/bundled', () => ({
  loadManifest: async () => [],
  fetchBundled: async () => new Uint8Array(),
  PLACEHOLDER_IDS: ['ph:one', 'ph:two'],
  makePlaceholder: async (id: string) => ({ uid: id, name: id + '.jpg', bytes: new Uint8Array([1]) }),
}));

const KEY = 'refragmenter.settings.v1';

function fakeStorage(init: Record<string, string>) {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

beforeEach(() => kv.clear());
afterEach(() => vi.unstubAllGlobals());

describe('settings', () => {
  // 04-17: keys from older versions (or anything else) used to be kept and written back for ever
  it('drops keys this version does not know', async () => {
    const ls = fakeStorage({ [KEY]: JSON.stringify({ wallpaper: 'solid', theme: 'xp', bogus: 1, fillDonor: 'user:a' }) });
    vi.stubGlobal('localStorage', ls);
    vi.resetModules();
    const { settings } = await import('../src/settings');
    expect(settings.wallpaper).toBe('solid');
    expect(settings.fillDonor).toBe('user:a');
    expect(settings).not.toHaveProperty('bogus');
    const stored = JSON.parse(ls.m.get(KEY)!);
    expect(stored).not.toHaveProperty('bogus');
    expect(stored).not.toHaveProperty('theme');
  });

  // 04-16: Foldy's "tutorial done" used to store Display Properties' unapplied preview of Foldy on/off
  it("a sub-setting change doesn't store another dialog's preview, nor undo it", async () => {
    const ls = fakeStorage({});
    vi.stubGlobal('localStorage', ls);
    vi.resetModules();
    const { settings, previewSettings, setSubSettings, savedSetting } = await import('../src/settings');
    previewSettings({ foldy: { ...settings.foldy, enabled: false } });
    setSubSettings('foldy', { tutorialDone: true });
    expect(savedSetting('foldy')).toMatchObject({ enabled: true, tutorialDone: true });
    expect(settings.foldy).toMatchObject({ enabled: false, tutorialDone: true });
    expect(JSON.parse(ls.m.get(KEY)!).foldy.enabled).toBe(true);
  });
});

describe('recent projects', () => {
  // 04-4: the files of projects past the sixth were never deleted
  it('keeps the files of the last six projects only', async () => {
    const { rememberProject, recentProjects } = await import('../src/shell/recent');
    for (let i = 0; i < 9; i++) await rememberProject('p' + i, new Uint8Array([i]));
    expect(recentProjects().map((r) => r.name)).toEqual(['p8', 'p7', 'p6', 'p5', 'p4', 'p3']);
    expect([...kv.keys()].filter((k) => k.startsWith('recent:')).sort()).toEqual(['recent:p3', 'recent:p4', 'recent:p5', 'recent:p6', 'recent:p7', 'recent:p8']);
  });

  // 04-3: Shut Down ▸ forget left the recent projects (and their files) behind
  it('forgetting removes the list and the files', async () => {
    const { rememberProject, forgetRecent, recentProjects } = await import('../src/shell/recent');
    await rememberProject('a', new Uint8Array([1]));
    await forgetRecent();
    expect(recentProjects()).toEqual([]);
    expect([...kv.keys()].filter((k) => k.startsWith('recent'))).toEqual([]);
  });
});

describe('samples after forgetting the session', () => {
  // 04-5: the samples were gone after Shut Down ▸ forget until a reload
  it('come back into the pool', async () => {
    vi.resetModules();
    const { store } = await import('../src/state');
    const { ensureSamples, resetSamples } = await import('../src/importflow');
    store.loaded = true;
    store.loadedFromSave = true; // as after restoring an autosave
    await store.clearSession();
    resetSamples();
    await ensureSamples();
    expect(store.doc.order).toEqual(['ph:one', 'ph:two']);
  });
});
