import './ui/theme.css';
import { ensureCrispFilter, initTextSnap } from './ui/dom';
import { initScale, ui, onScale } from './ui/scale';
import { onWm } from './ui/wm';
import { initTheme } from './ui/theme';
import { initTooltips } from './ui/tooltip';
import { initContextMenu } from './ui/contextmenu';
import { buildShell } from './shell/shell';
import { store } from './state';
import { pipeline } from './pipeline';
import { ensureSamples, importFiles, applyRecipe } from './importflow';
import { recipeFromFragment } from './engine/recipe';
import { openApp } from './apps/registry';
import { foldy } from './foldy/foldy';
import { engine } from './engine/client';
import { showSplash } from './apps/splash';
import { errorBox } from './ui/dialog';

async function boot() {
  const root = document.getElementById('app')!;
  ensureCrispFilter();
  initScale(root);
  initTheme(root);
  buildShell(root);
  // no native browser UI: 98 tooltips (title → data-tip), right-click menus, img drag ghosts off
  initTooltips();
  initContextMenu();
  const snap = initTextSnap(root, () => ({ dpr: ui.dpr, zoom: ui.zoom }));
  onScale(snap);
  onWm(snap);

  // drop files anywhere
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) {
      void importFiles(files);
      openApp('editor');
    }
  });
  // paste a photo (screenshot, copied image or copied files) anywhere
  addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    void importFiles(files);
    openApp('editor');
  });

  // the splash stays while the engine loads (at least ~1 s; a click skips it). A failure here must not
  // stop the boot silently: say so, and start without the engine (the windows still open).
  let bootError: unknown = null;
  const engineReady = (async () => {
    await store.restoreAutosave();
    await pipeline.init();
  })().catch((e) => {
    bootError = e;
    console.error('engine failed to start', e);
  });
  const splash = showSplash(root, engineReady);
  await engineReady;
  openApp('editor');
  if (bootError) errorBox(`The picture engine could not start (${(bootError as Error)?.message ?? bootError}). Reloading the page usually fixes it.`);
  await ensureSamples();

  // recipe shared in the URL fragment (bundled photos only)
  if (location.hash.length > 3) {
    try {
      const r = await recipeFromFragment(location.hash);
      if (r) {
        if (r.source && store.photos.has(r.source)) store.update((d) => void (d.current = r.source!), 'photos');
        await applyRecipe(r.steps);
        history.replaceState(null, '', location.pathname + location.search);
        if (!store.current) setTimeout(() => foldy.help('Someone sent you a recipe! Open one of your photos (or try a sample) and the same damage happens to it.'), 1200);
      }
    } catch (e) {
      console.warn('bad recipe link', e);
    }
  }

  (window as any).__refrag = { store, pipeline, engine, ui, foldy, openApp };
  // Foldy starts talking once the splash is gone
  await splash;
  foldy.startTutorial(!!store.current);
  foldy.startChatter();

  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

void boot();
