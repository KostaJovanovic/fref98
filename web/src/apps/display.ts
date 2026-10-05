// Display Properties, as the Windows 98 property sheet: Background, Screen Saver, Appearance, Settings and
// our Foldy tab; the beige monitor preview; OK / Cancel / Apply. A change shows at once (desktop and
// monitor) but is only stored by OK or Apply; Cancel (or the close box) puts the stored values back.
import { h, mount } from '../ui/dom';
import { button, checkbox, group, numberField, selectField, slider, tabs } from '../ui/controls';
import { openWindow, getWin, type Win } from '../ui/wm';
import { settings, setSettings, previewSettings, revertPreview, savedSetting, defaultSettings, type Settings, type Wallpaper } from '../settings';
import { ui } from '../ui/scale';
import { previewSaver } from '../shell/screensaver';
import { clearWallpaperImage, wallpaperImage } from '../shell/wallpaper';
import { foldy } from '../foldy/foldy';
import { snap, ditherBayer } from '../ui/palette';
import { tilePattern, iconImg } from '../ui/art';
import { registerContext } from '../ui/contextmenu';
import { renderSkyFrame } from '../engine/skygen';
import { foldyStill } from '../foldy/sheet';
import { pipeline } from '../pipeline';
import { store } from '../state';
import { crtMonitor, listBox, SCREEN } from './tools98';

const TABS = ['Background', 'Screen Saver', 'Appearance', 'Settings', 'Foldy'];
const WALLPAPERS: [Wallpaper, string][] = [
  ['sky', 'Sky (our own low-quality JPEG)'],
  ['solid', 'Solid colour'],
  ['tiles', 'Tiles'],
  ['photo', 'My broken photo'],
];
const SAVERS: [string, string][] = [
  ['none', '(None)'],
  ['starfield', 'JPEG Starfield'],
  ['folders', 'Flying Folders'],
];
const SWATCHES = ['#3a6fc4', '#009999', '#000000', '#336699', '#663366', '#2f8f2f', '#808080', '#0a246a'];

let dp: DisplayProps | null = null;

export function open(arg?: { tab?: number }) {
  if (dp && getWin('display')) {
    if (arg?.tab !== undefined) dp.setTab(arg.tab);
    return dp.win.focus();
  }
  dp = new DisplayProps(arg?.tab ?? 0);
}

class DisplayProps {
  win: Win;
  private tab: number;
  /** Settings changed since the last OK/Apply (shown live, not yet stored). */
  private dirty = new Set<keyof Settings>();
  /** "My broken photo" was picked from the list: on Apply the pinned "Set as Wallpaper" picture is dropped. */
  private pickedPhoto = false;
  private applied = false;
  private page = h('div', { class: 'tabpage dp-page' });
  private tabBar = h('div');
  private applyBtn: HTMLButtonElement;
  private saverTimer: ReturnType<typeof setInterval> | null = null;
  private unreg: () => void;

  constructor(tab: number) {
    this.tab = tab;
    this.applyBtn = button('Apply', () => this.apply(), { disabled: true });
    const btns = h('div', { class: 'dp-btns' }, button('OK', () => this.ok(), { cls: 'default' }), button('Cancel', () => this.win.close()), this.applyBtn);
    const body = h('div', { class: 'dp98' }, this.tabBar, this.page, btns);
    this.win = openWindow({
      id: 'display',
      title: 'Display Properties',
      short: 'Display',
      icon: 'display',
      body,
      width: 406,
      height: 456,
      resizable: false,
      onClose: () => {
        this.stopSaver();
        // closing without OK is Cancel: the desktop goes back to the stored settings
        if (!this.applied || this.dirty.size) this.revert();
        this.unreg();
        dp = null;
      },
      enter: (t) => {
        if (!t.closest('.lb98')) this.ok();
      },
      esc: () => this.win.close(),
    });
    this.win.el.addEventListener('keydown', (e) => {
      // next/previous tab: Ctrl+PgDn/PgUp (browsers keep Ctrl+Tab for their own tabs)
      const dir = e.ctrlKey && (e.key === 'PageDown' || (e.key === 'Tab' && !e.shiftKey)) ? 1 : e.ctrlKey && (e.key === 'PageUp' || (e.key === 'Tab' && e.shiftKey)) ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      this.setTab((this.tab + TABS.length + dir) % TABS.length);
      this.win.el.querySelector<HTMLElement>('.tab.on')?.focus();
    });
    this.unreg = registerContext('.dp98 .crt-wrap', () => [
      { label: '&Preview', disabled: this.tab !== 1 || !settings.screensaver.enabled, onClick: () => this.preview() },
      { sep: true },
      { label: '&Background…', onClick: () => this.setTab(0) },
      { label: '&Screen Saver…', onClick: () => this.setTab(1) },
      { label: 'Se&ttings…', onClick: () => this.setTab(3) },
    ]);
    this.render();
  }

  setTab(i: number) {
    this.tab = i;
    this.render();
  }

  /** Shows a change now; it is stored by OK / Apply. */
  private change(p: Partial<Settings>, rerender = true) {
    previewSettings(p);
    for (const k of Object.keys(p) as (keyof Settings)[]) this.dirty.add(k);
    if ('foldy' in p) foldy.applyEnabled();
    this.applyBtn.disabled = false;
    if (rerender) this.render();
  }

  private apply() {
    if (this.pickedPhoto) {
      clearWallpaperImage();
      this.dirty.add('wallpaper');
      this.pickedPhoto = false;
    }
    const patch: Partial<Settings> = {};
    for (const k of this.dirty) (patch as any)[k] = JSON.parse(JSON.stringify(settings[k] ?? null)) ?? undefined;
    this.dirty.clear();
    if (Object.keys(patch).length) setSettings(patch);
    this.applied = true;
    this.applyBtn.disabled = true;
  }

  private ok() {
    this.apply();
    this.win.close();
  }

  private revert() {
    if (!this.dirty.size) return;
    revertPreview([...this.dirty]);
    this.dirty.clear();
    foldy.applyEnabled();
  }

  private render() {
    this.stopSaver();
    mount(this.tabBar, tabs(TABS, this.tab, (i) => this.setTab(i)));
    this.page.replaceChildren();
    if (this.tab === 0) this.background();
    else if (this.tab === 1) this.saverTab();
    else if (this.tab === 2) this.appearance();
    else if (this.tab === 3) this.settingsTab();
    else this.foldyTab();
  }

  // ------------------------------------------------------------ Background

  private background() {
    const mon = crtMonitor((x, w, hh) => paintWallpaper(x, w, hh, () => mon.redraw()));
    const wp = settings.wallpaper;
    const list = listBox(
      WALLPAPERS.map(([id, label]) => ({ id, label, icon: iconImg(id === 'photo' ? 'jpeg' : id === 'sky' ? 'display' : 'pictures', 16) })),
      wp,
      (id) => {
        if (id === settings.wallpaper) return;
        this.pickedPhoto = id === 'photo';
        this.change({ wallpaper: id as Wallpaper });
        requestAnimationFrame(() => this.page.querySelector<HTMLElement>('.lb98')?.focus());
      },
      { label: 'Wallpaper', cls: 'dp-list' },
    );
    const solid = wp === 'solid';
    const sw = h(
      'div',
      { class: 'dp-swatches', role: 'radiogroup', 'aria-label': 'Desktop colour' },
      SWATCHES.map((raw) => {
        const c = snap(raw);
        const b = h('button', { class: 'tool dp-sw' + (settings.solidColor === c ? ' on' : ''), role: 'radio', 'aria-checked': String(settings.solidColor === c), 'aria-label': 'Colour ' + c, 'data-tip': c, disabled: !solid, onclick: () => this.change({ solidColor: c }) });
        const chip = h('span', { class: 'dp-chip' });
        chip.style.background = c;
        b.append(chip);
        return b;
      }),
    );
    const clouds = slider(settings.cloudSpeed, 0, 3, 1, (v) => this.change({ cloudSpeed: v }, false), { label: 'Cloud speed', ticks: 3 });
    clouds.disabled = wp !== 'sky';
    this.page.append(
      mon.el,
      h(
        'div',
        { class: 'dp-row' },
        h('div', { class: 'dp-left' }, h('div', { class: 'dp-lbl' }, 'Wallpaper'), h('div', null, 'Select a picture for the desktop:'), list),
        h(
          'div',
          { class: 'dp-right' },
          h('div', { class: 'dp-lbl' + (solid ? '' : ' dis') }, 'Colour:'),
          sw,
          h('div', { class: 'dp-lbl' + (wp === 'sky' ? '' : ' dis') }, 'Clouds:'),
          clouds,
          h('div', { class: 'dp-ends' + (wp === 'sky' ? '' : ' dis') }, h('span', null, 'Still'), h('span', null, 'Windy')),
        ),
      ),
    );
  }

  // ------------------------------------------------------------ Screen Saver

  private saverTab() {
    const ss = settings.screensaver;
    const kind = ss.enabled ? ss.kind : 'none';
    let t = 0;
    const stars = Array.from({ length: 60 }, () => ({ x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: Math.random() }));
    const mon = crtMonitor((x, w, hh) => {
      if (kind === 'none') return paintWallpaper(x, w, hh, () => mon.redraw());
      x.fillStyle = '#000';
      x.fillRect(0, 0, w, hh);
      if (kind === 'starfield') {
        for (const s of stars) {
          s.z -= 0.02;
          if (s.z <= 0.03) Object.assign(s, { x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: 1 });
          const c = Math.round(110 + 145 * (1 - s.z));
          x.fillStyle = `rgb(${c},${c},${Math.min(255, c + 40)})`;
          x.fillRect(Math.round(w / 2 + (s.x / s.z) * w * 0.5), Math.round(hh / 2 + (s.y / s.z) * hh * 0.5), s.z < 0.3 ? 2 : 1, s.z < 0.3 ? 2 : 1);
        }
      } else {
        x.imageSmoothingEnabled = false;
        const still = foldyStill(['body.open.paper', 'body.half.paper', 'body.closed', 'body.half.paper'][(t >> 2) % 4], 'eyes.happy');
        for (const s of stars.slice(0, 8)) {
          s.z -= 0.01;
          if (s.z <= 0.08) Object.assign(s, { x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: 1 });
          const size = Math.max(4, Math.round(6 / s.z));
          if (still) x.drawImage(still, Math.round(w / 2 + (s.x / s.z) * w * 0.35 - size / 2), Math.round(hh / 2 + (s.y / s.z) * hh * 0.35 - size / 2), size, size);
        }
      }
      t++;
    });
    if (kind !== 'none') this.saverTimer = setInterval(() => (mon.el.isConnected ? mon.redraw() : this.stopSaver()), 100);
    const prev = button('Preview', () => this.preview(), { disabled: kind === 'none' });
    this.page.append(
      mon.el,
      group(
        'Screen Saver',
        h(
          'div',
          { class: 'row' },
          selectField(kind, SAVERS, (v) => this.change({ screensaver: v === 'none' ? { ...settings.screensaver, enabled: false } : { ...settings.screensaver, enabled: true, kind: v as 'starfield' | 'folders' } }), { label: 'Screen saver', width: 170 }),
          button('Settings…', () => {}, { disabled: true }),
          prev,
        ),
        h(
          'div',
          { class: 'row dp-wait' },
          h('span', { class: kind === 'none' ? 'dis' : '' }, 'Wait:'),
          numberField(ss.minutes, (v) => this.change({ screensaver: { ...settings.screensaver, minutes: Math.max(1, Math.min(60, Math.round(v))) } }, false), { min: 1, max: 60, label: 'Wait (minutes)', width: 48 }),
          h('span', { class: kind === 'none' ? 'dis' : '' }, 'minutes'),
        ),
      ),
    );
    if (kind === 'none') this.page.querySelector<HTMLInputElement>('.dp-wait input')!.disabled = true;
  }

  private preview() {
    if (!settings.screensaver.enabled) return;
    previewSaver(document.getElementById('app')!, settings.screensaver.kind);
  }

  private stopSaver() {
    if (this.saverTimer) clearInterval(this.saverTimer);
    this.saverTimer = null;
  }

  // ------------------------------------------------------------ Appearance

  private appearance() {
    const prevBox = h(
      'div',
      { class: 'ap-prev', 'aria-hidden': 'true' },
      h('div', { class: 'ap-win ap-inactive' }, h('div', { class: 'ap-cap' }, 'Inactive Window')),
      h(
        'div',
        { class: 'ap-win ap-active' },
        h('div', { class: 'ap-cap' }, 'Active Window'),
        h('div', { class: 'ap-menu' }, h('span', null, 'Normal'), h('span', { class: 'dis' }, 'Disabled'), h('span', { class: 'ap-selm' }, 'Selected')),
        h('div', { class: 'ap-text' }, h('span', null, 'Window Text')),
      ),
      h('div', { class: 'ap-win ap-msg' }, h('div', { class: 'ap-cap' }, 'Message Box'), h('div', { class: 'ap-msgbody' }, h('span', null, 'Message Text'), h('span', { class: 'btn small default ap-ok' }, 'OK'))),
    );
    this.page.append(
      prevBox,
      h('div', { class: 'row dp-scheme' }, h('span', null, 'Scheme:'), selectField('std', [['std', 'Refragmenter Standard']], () => {}, { label: 'Scheme', width: 200 })),
      group(
        'Visual effects',
        h('div', { class: 'row' }, h('span', { class: 'dp-ilbl' }, 'Animate windows and menus:'), selectField(String(settings.reducedMotion), [['auto', 'Follow my system'], ['false', 'On'], ['true', 'Off (reduced motion)']], (v) => this.change({ reducedMotion: v === 'auto' ? 'auto' : v === 'true' }), { label: 'Animations', width: 150 })),
      ),
      h('div', { class: 'row dp-restore' }, button('Restore Defaults', () => this.restoreDefaults(), { cls: 'small' })),
    );
  }

  private restoreDefaults() {
    const d = defaultSettings();
    this.change({ wallpaper: d.wallpaper, solidColor: d.solidColor, cloudSpeed: d.cloudSpeed, screensaver: d.screensaver, uiScale: d.uiScale, bigText: d.bigText, reducedMotion: d.reducedMotion });
  }

  // ------------------------------------------------------------ Settings

  private settingsTab() {
    const mon = crtMonitor((x, w, hh) => paintWallpaper(x, w, hh, () => mon.redraw()));
    const auto = settings.uiScale === 'auto';
    const s: number = settings.uiScale === 'auto' ? 1 : settings.uiScale;
    // Less ← 3× 2× 1× → More (the 98 "Screen area" slider: more area = smaller UI)
    const area = slider(4 - s, 1, 3, 1, (v) => this.change({ uiScale: (4 - v) as 1 | 2 | 3 }), { label: 'Screen area', ticks: 2 });
    const res = areaAt(s);
    this.page.append(
      mon.el,
      h('div', { class: 'dp-display' }, h('div', null, 'Display:'), h('div', null, 'Refragmenter Plug and Play Monitor on 98 Gold Display Adapter')),
      h(
        'div',
        { class: 'dp-row' },
        group('Colors', selectField('256', [['256', '256 Colors (dithered)']], () => {}, { label: 'Colors', width: 160 }), h('div', { class: 'dp-pal', 'aria-hidden': 'true' })),
        group(
          'Screen area',
          h('div', { class: 'dp-ends' }, h('span', null, 'Less'), area, h('span', null, 'More')),
          h('div', { class: 'dp-res' }, `${res.w} by ${res.h} pixels`),
          checkbox('Automatic', auto, (v) => this.change({ uiScale: v ? 'auto' : 1 })),
        ),
      ),
      h('div', { class: 'row dp-font' }, h('span', { class: 'dp-ilbl' }, 'Font size:'), selectField(String(settings.bigText), [['auto', 'Automatic (large on phones)'], ['false', 'Small Fonts'], ['true', 'Large Fonts (2×)']], (v) => this.change({ bigText: v === 'auto' ? 'auto' : v === 'true' }), { label: 'Font size', width: 190 })),
    );
  }

  // ------------------------------------------------------------ Foldy

  private foldyTab() {
    const f = settings.foldy;
    const pic = foldyStill('body.closed', 'eyes.happy');
    const art = h('div', { class: 'dp-foldy-art' });
    if (pic) {
      const c = h('canvas', { width: pic.width, height: pic.height });
      c.getContext('2d')!.drawImage(pic, 0, 0);
      art.append(c);
    }
    this.page.append(
      h('div', { class: 'row dp-foldy' }, art, h('div', { class: 'grow' }, h('div', { class: 'b' }, 'Foldy, your folder assistant'), h('div', null, 'He shows up at the bottom of every window with tips, and explains what happened to your photo.'))),
      group(
        'Foldy',
        checkbox('Show Foldy', f.enabled, (v) => {
          foldy.hiddenForSession = false;
          this.change({ foldy: { ...settings.foldy, enabled: v } });
        }),
        checkbox('Let him glitch now and then', f.glitches, (v) => this.change({ foldy: { ...settings.foldy, glitches: v } })),
        h('div', { class: 'hint' }, 'Glitches are only for fun. Help you ask for always ends up readable and correct.'),
      ),
      h(
        'div',
        { class: 'row' },
        button('Replay the Tutorial', () => {
          // an action, not a setting: runs (and is stored) at once, like 98's "Test" buttons
          setSettings({ foldy: { ...savedSetting('foldy'), tutorialDone: false, expertIntroDone: false, enabled: true } });
          previewSettings({ foldy: { ...settings.foldy, tutorialDone: false, expertIntroDone: false, enabled: true } });
          foldy.applyEnabled();
          foldy.startTutorial(!!store.current);
        }, { cls: 'small' }),
      ),
    );
  }
}

/** The screen area (UI pixels) at a UI scale. */
function areaAt(s: number): { w: number; h: number } {
  const dpr = window.devicePixelRatio || 1;
  const k = Math.max(1, Math.round(s * dpr));
  const zoom = k / dpr;
  return { w: Math.floor(innerWidth / zoom), h: Math.floor(innerHeight / zoom) };
}

// ------------------------------------------------------------------ the miniature wallpaper

let skyMini: HTMLCanvasElement | null = null;
let tileImg: HTMLImageElement | null = null;

function paintWallpaper(x: CanvasRenderingContext2D, w: number, hh: number, again: () => void) {
  const mode = settings.wallpaper;
  if (mode === 'solid') {
    x.fillStyle = settings.solidColor;
    x.fillRect(0, 0, w, hh);
    return;
  }
  if (mode === 'tiles') {
    if (!tileImg) {
      tileImg = new Image();
      tileImg.onload = again;
      tileImg.src = tilePattern();
    }
    if (!tileImg.complete) return;
    // the desktop's 32 px tile, scaled like the rest of the desktop
    const t = Math.max(2, Math.round((32 * w) / ui.w));
    x.imageSmoothingEnabled = false;
    for (let yy = 0; yy < hh; yy += t) for (let xx = 0; xx < w; xx += t) x.drawImage(tileImg, xx, yy, t, t);
    return;
  }
  if (mode === 'photo') {
    void wallpaperImage().then((snapImg) => {
      const r = pipeline.last;
      let src: CanvasImageSource | null = null;
      let sw = 0;
      let sh = 0;
      if (snapImg) {
        src = snapImg.src;
        sw = snapImg.w;
        sh = snapImg.h;
      } else if (r?.after) {
        const c = document.createElement('canvas');
        c.width = r.after.width;
        c.height = r.after.height;
        c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.after.rgba), r.after.width, r.after.height), 0, 0);
        src = c;
        sw = c.width;
        sh = c.height;
      }
      if (!src || settings.wallpaper !== 'photo') {
        if (!src) paintSky(x, w, hh);
        return;
      }
      const s = Math.max(w / sw, hh / sh);
      x.imageSmoothingEnabled = true;
      x.drawImage(src, (w - sw * s) / 2, (hh - sh * s) / 2, sw * s, sh * s);
      const d = x.getImageData(0, 0, w, hh);
      ditherBayer(d.data, w, hh, 40);
      x.putImageData(d, 0, 0);
      // the monitor frame was drawn already: copy the new screen into it
      const host = x.canvas;
      for (const crt of document.querySelectorAll<HTMLCanvasElement>('.dp98 canvas.crt')) crt.getContext('2d')!.drawImage(host, SCREEN.x, SCREEN.y);
    });
    return;
  }
  paintSky(x, w, hh);
}

function paintSky(x: CanvasRenderingContext2D, w: number, hh: number) {
  if (!skyMini) {
    // the real sky at desktop size (it is drawn at half resolution), shrunk into the monitor
    const W = Math.max(64, Math.ceil(ui.w / 2));
    const H = Math.max(48, Math.ceil(ui.h / 2));
    const px = renderSkyFrame({ width: W, height: H, t: 0, speed: 1 });
    const big = document.createElement('canvas');
    big.width = W;
    big.height = H;
    big.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px), W, H), 0, 0);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = hh;
    const cx = c.getContext('2d', { willReadFrequently: true })!;
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(big, 0, 0, w, hh);
    const d = cx.getImageData(0, 0, w, hh);
    ditherBayer(d.data, w, hh, 40);
    cx.putImageData(d, 0, 0);
    skyMini = c;
  }
  x.drawImage(skyMini, 0, 0);
}
