// "Video Lab": a 98 media player for Motion-JPEG AVIs. Open a clip, run the current recipe over every frame
// (each frame gets its own seed), play it back (sunken video area, seek trackbar, transport buttons, the
// green-on-black counter), and save a new AVI whose frames are the damaged JPEGs themselves.
import { h, mount, setText, download, pickFiles, fmtBytes } from '../ui/dom';
import { iconImg } from '../ui/art';
import { button, group, radio, slider } from '../ui/controls';
import { openWindow, getWin, type Win } from '../ui/wm';
import type { MenuItem } from '../ui/menu';
import { registerContext } from '../ui/contextmenu';
import { engine, NotAvailableError, isCancel } from '../engine/client';
import { store } from '../state';
import { pipeline } from '../pipeline';
import { offsetSeeds } from './export';
import { errorBox, message, progressDialog, progressDone } from '../ui/dialog';
import { mediaGlyph, type MediaGlyph } from './explorer-art';
import { fmtClock } from './explorer-model';
import { Folder, propertySheet } from './explorer';
import * as bus from '../bus';

type State = 'stopped' | 'playing' | 'paused';

let win: Win | null = null;
let avi: Uint8Array | null = null;
let info: { width: number; height: number; fps: number; frames: number } | null = null;
let name = 'video';
let outFrames: Uint8Array[] = [];
let showDamaged = true;
let state: State = 'stopped';
let pos = 0;
let repeat = true;
let view: HTMLCanvasElement | null = null;
let seek: HTMLInputElement | null = null;
let lcd: HTMLElement | null = null;
let playRun = 0;
let unreg: (() => void) | null = null;

export function open(arg?: { file?: File }) {
  if (!win || !getWin('video')) {
    win = openWindow({
      id: 'video',
      title: 'Video Lab',
      short: 'Video',
      icon: 'video',
      body: h('div', { class: 'mp' }),
      width: 560,
      height: 500,
      minWidth: 360,
      minHeight: 320,
      menu: [
        { label: '&File', items: fileMenu },
        { label: '&Play', items: playMenu },
        { label: '&Effects', items: () => [{ label: '&Apply Recipe to Every Frame…', disabled: !info, onClick: () => void apply() }, { sep: true }, ...showItems()] },
        { label: '&Help', items: () => Folder.helpMenu() },
      ],
      status: [h('div', { class: 'grow' })],
      onClose: () => {
        state = 'stopped';
        playRun++;
        win = null;
        view = seek = lcd = null;
        unreg?.();
        unreg = null;
      },
      onResize: () => fit(),
    });
    unreg = registerContext('.mp-video[data-mp="video"]', () => videoMenu());
  } else win.focus();
  if (arg?.file) void load(arg.file);
  else render();
}

// ------------------------------------------------------------------ menus

function fileMenu(): MenuItem[] {
  return [
    { label: '&Open…', acc: 'Ctrl+O', icon: 'folder', onClick: () => void openFile() },
    { label: 'Save &As…', disabled: !outFrames.length || !engine().has('avi_write'), onClick: () => void save() },
    { sep: true },
    { label: 'P&roperties', disabled: !info, onClick: properties },
    { sep: true },
    { label: '&Close', onClick: () => win?.close() },
  ];
}

function playMenu(): MenuItem[] {
  return [
    { label: state === 'playing' ? 'P&ause' : '&Play', disabled: !info, default: true, onClick: () => (state === 'playing' ? pause() : play()) },
    { label: '&Stop', disabled: !info || state === 'stopped', onClick: stop },
    { sep: true },
    { label: 'P&revious Frame', disabled: !info, onClick: () => step(-1) },
    { label: '&Next Frame', disabled: !info, onClick: () => step(1) },
    { label: '&Beginning', disabled: !info, onClick: () => seekTo(0) },
    { label: '&End', disabled: !info, onClick: () => info && seekTo(info.frames - 1) },
    { sep: true },
    { label: 'Repea&t', checked: repeat, onClick: () => (repeat = !repeat) },
  ];
}

function showItems(): MenuItem[] {
  return [
    { label: 'Show &Original', checked: !showDamaged || !outFrames.length, radio: true, disabled: !info, onClick: () => setShow(false) },
    { label: 'Show &Damaged', checked: showDamaged && !!outFrames.length, radio: true, disabled: !outFrames.length, onClick: () => setShow(true) },
  ];
}

function videoMenu(): MenuItem[] {
  return [
    ...playMenu().slice(0, 5),
    { sep: true },
    ...showItems(),
    { sep: true },
    { label: '&Open…', onClick: () => void openFile() },
    { label: 'P&roperties', disabled: !info, onClick: properties },
  ];
}

// ------------------------------------------------------------------ loading and rendering

async function openFile() {
  const f = (await pickFiles('.avi,video/x-msvideo', false))[0];
  if (f) await load(f);
}

async function load(f: File) {
  stop();
  avi = new Uint8Array(await f.arrayBuffer());
  name = f.name.replace(/\.avi$/i, '');
  outFrames = [];
  pos = 0;
  try {
    info = await engine().aviRead(avi).promise;
  } catch (e) {
    info = null;
    if (e instanceof NotAvailableError) message('Not available yet', 'Reading AVI files needs a part of the engine that is not built yet.', 'video');
    else errorBox(`${f.name}: ${(e as Error).message}`);
  }
  win?.setTitle(info ? `${name}.avi - Video Lab` : 'Video Lab');
  render();
}

function tbtn(g: MediaGlyph, label: string, run: () => void, disabled: boolean, on = false): HTMLButtonElement {
  const b = h('button', { class: 'mp-btn' + (on ? ' on' : ''), type: 'button', 'aria-label': label, 'data-tip': label, disabled, onclick: run });
  b.style.setProperty('background-image', `url("${mediaGlyph(g, disabled)}")`);
  if (on) b.setAttribute('aria-pressed', 'true');
  return b;
}

function render() {
  if (!win) return;
  // one canvas for the window's life: playback keeps drawing into it across re-renders
  if (!view) view = h('canvas', { width: info?.width ?? 320, height: info?.height ?? 240, 'aria-label': 'Video' });
  const none = !info;
  const area = h('div', { class: 'mp-video', dataset: { mp: 'video' } }, none ? h('div', { class: 'mp-blank' }, h('div', null, 'Open a Motion-JPEG .avi (many old digital cameras made these). Every frame is a JPEG; the recipe breaks each one.')) : view);
  seek = slider(pos, 0, Math.max(0, (info?.frames ?? 1) - 1), 1, (v) => seekTo(v), { label: 'Seek' });
  seek.disabled = none;
  lcd = h('div', { class: 'mp-lcd', 'aria-live': 'off' }, clock());
  const steps = store.doc.stack.length;
  mount(
    win.body,
    area,
    h('div', { class: 'mp-seek' }, seek),
    h(
      'div',
      { class: 'mp-bar', role: 'toolbar', 'aria-label': 'Transport' },
      tbtn('play', 'Play', play, none, state === 'playing'),
      tbtn('pause', 'Pause', pause, none || state === 'stopped', state === 'paused'),
      tbtn('stop', 'Stop', stop, none || state === 'stopped'),
      h('span', { class: 'mp-sep' }),
      tbtn('prev', 'Beginning', () => seekTo(0), none),
      tbtn('stepb', 'Previous Frame', () => step(-1), none),
      tbtn('stepf', 'Next Frame', () => step(1), none),
      tbtn('next', 'End', () => info && seekTo(info.frames - 1), none),
      h('span', { class: 'mp-sep' }),
      tbtn('eject', 'Open…', () => void openFile(), false),
      lcd,
    ),
    h(
      'div',
      { class: 'mp-groups' },
      group(
        'Damage',
        h('div', { class: 'mp-row' }, button('Apply Recipe…', () => void apply(), { disabled: none, icon: iconImg('presets', 16) }), h('span', null, `${steps} step${steps === 1 ? '' : 's'} from the editor`)),
        h('div', { class: 'mp-row' }, radio('mpshow', 'Original', !showDamaged || !outFrames.length, () => setShow(false), { disabled: none }), radio('mpshow', 'Damaged', showDamaged && !!outFrames.length, () => setShow(true), { disabled: !outFrames.length })),
      ),
      group('Save', h('div', { class: 'mp-row' }, button('Save AVI…', () => void save(), { disabled: !outFrames.length || !engine().has('avi_write'), icon: iconImg('export', 16) })), h('div', { class: 'mp-row hint' }, 'Frame n uses seed + n.')),
    ),
  );
  status();
  requestAnimationFrame(fit);
  if (info && state !== 'playing') void showFrame(pos);
}

function status() {
  if (!win) return;
  const st = !info ? 'Ready' : state === 'playing' ? 'Playing' : state === 'paused' ? 'Paused' : 'Stopped';
  win.setStatus([
    st,
    info ? `Frame ${pos + 1} of ${info.frames}` : '',
    info ? `${info.width} x ${info.height}, ${info.fps} fps${outFrames.length ? ', damaged' : ''}` : '',
  ]);
}

function clock(): string {
  if (!info) return '00:00.0 / 00:00.0';
  const fps = info.fps || 10;
  return `${fmtClock(pos / fps, true)} / ${fmtClock(info.frames / fps, true)}`;
}

/** Integer zoom when the clip fits more than once, otherwise scaled down, centred in the black area. */
function fit() {
  const c = view;
  const holder = c?.parentElement;
  if (!c || !holder) return;
  const W = holder.clientWidth - 4;
  const H = holder.clientHeight - 4;
  const s = Math.min(W / c.width, H / c.height);
  const z = s >= 1 ? Math.floor(s) : s;
  c.style.width = Math.round(c.width * z) + 'px';
  c.style.height = Math.round(c.height * z) + 'px';
  c.style.left = Math.round(2 + (W - c.width * z) / 2) + 'px';
  c.style.top = Math.round(2 + (H - c.height * z) / 2) + 'px';
}

// ------------------------------------------------------------------ playback

async function frameBytes(i: number): Promise<Uint8Array> {
  if (showDamaged && outFrames[i]) return outFrames[i];
  return engine().aviFrame(avi!, i).promise;
}

async function showFrame(i: number) {
  const c = view;
  if (!c || !avi) return;
  try {
    const d = await engine().decode(await frameBytes(i), {}).promise;
    const resized = c.width !== d.width || c.height !== d.height;
    c.width = d.width;
    c.height = d.height;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(d.rgba.buffer as ArrayBuffer), d.width, d.height), 0, 0);
    if (resized) fit();
  } catch {
    /* unreadable frame: the last good one stays */
  }
}

function tick() {
  if (seek) seek.value = String(pos);
  if (lcd) setText(lcd, clock());
  status();
}

function play() {
  if (!info || state === 'playing') return;
  if (pos >= info.frames - 1) pos = 0;
  state = 'playing';
  render();
  void loop(++playRun);
}

async function loop(run: number) {
  while (state === 'playing' && run === playRun && win && info) {
    const t = performance.now();
    await showFrame(pos);
    if (run !== playRun) return;
    tick();
    await new Promise((r) => setTimeout(r, Math.max(0, 1000 / (info!.fps || 10) - (performance.now() - t))));
    if (run !== playRun || state !== 'playing') return;
    if (pos + 1 >= info.frames) {
      if (!repeat) {
        state = 'stopped';
        render();
        return;
      }
      pos = 0;
    } else pos++;
  }
}

function pause() {
  if (state !== 'playing' && state !== 'paused') return;
  state = state === 'playing' ? 'paused' : 'playing';
  playRun++;
  render();
  if (state === 'playing') void loop(++playRun);
}

function stop() {
  if (state === 'stopped' && pos === 0) return;
  state = 'stopped';
  playRun++;
  pos = 0;
  render();
}

function seekTo(i: number) {
  if (!info) return;
  pos = Math.max(0, Math.min(info.frames - 1, Math.round(i)));
  tick();
  if (state !== 'playing') void showFrame(pos);
}

function step(d: number) {
  if (!info) return;
  if (state === 'playing') {
    state = 'paused';
    playRun++;
    render();
  }
  seekTo(pos + d);
}

function setShow(damaged: boolean) {
  showDamaged = damaged;
  render();
}

// ------------------------------------------------------------------ damage and save

async function apply() {
  if (!avi || !info) return;
  if (state === 'playing') pause();
  let cancelled = false;
  const prog = progressDialog('Video Lab', { onCancel: () => (cancelled = true), say: 'Breaking every single frame…' });
  const out: Uint8Array[] = [];
  try {
    for (let i = 0; i < info.frames && !cancelled; i++) {
      prog.set(i / info.frames, `Frame ${i + 1} of ${info.frames}…`);
      const src = await engine().aviFrame(avi, i).promise;
      const r = await pipeline.runOn('avi:' + name + ':' + i, src, offsetSeeds(store.doc.stack, i), null, () => cancelled);
      out.push(r.output);
    }
    if (!cancelled) {
      outFrames = out;
      showDamaged = true;
    }
  } catch (e) {
    if (!isCancel(e)) errorBox(String((e as Error).message ?? e));
  } finally {
    progressDone(prog);
    render();
  }
}

async function save() {
  if (!info || !outFrames.length) return;
  try {
    const bytes = await engine().aviWrite(outFrames, info.width, info.height, info.fps || 10).promise;
    download(bytes, name + '_refrag.avi', 'video/x-msvideo');
    bus.emit('exported');
  } catch (e) {
    errorBox(String((e as Error).message ?? e));
  }
}

function properties() {
  if (!info) return;
  const fps = info.fps || 10;
  propertySheet({
    id: 'props:video',
    title: `${name}.avi Properties`,
    icon: 'video',
    name: name + '.avi',
    groups: [
      [
        { label: 'Type:', value: 'Video Clip (Motion-JPEG AVI)' },
        { label: 'Size:', value: fmtBytes(avi?.length ?? 0) },
      ],
      [
        { label: 'Length:', value: `${fmtClock(info.frames / fps, true)} (${info.frames} frames)` },
        { label: 'Frame size:', value: `${info.width} x ${info.height}` },
        { label: 'Frame rate:', value: `${info.fps} frames/second` },
        { label: 'Damaged:', value: outFrames.length ? `${outFrames.length} frames` : 'Not yet' },
      ],
    ],
  });
}
