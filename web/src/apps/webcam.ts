// "Camera Wizard": live webcam through the real codec at ~640×480, applying only the cheap steps of the
// current recipe, recording the damaged JPEG frames into an MJPEG AVI (Q28). Before the browser's own camera
// prompt, our message box says what happens: everything stays on this computer. 98 media-player chrome:
// sunken video area, transport buttons, the green counter, group boxes, a trackbar with ticks.
import { h, mount, setText, download } from '../ui/dom';
import { iconImg } from '../ui/art';
import { checkbox, group, slider } from '../ui/controls';
import { openWindow, getWin, type Win } from '../ui/wm';
import type { MenuItem } from '../ui/menu';
import { registerContext } from '../ui/contextmenu';
import { EngineClient } from '../engine/client';
import { store } from '../state';
import { pipeline } from '../pipeline';
import type { StackNode } from '../engine/stack';
import { confirmBox, errorBox, message } from '../ui/dialog';
import { mediaGlyph, type MediaGlyph } from './explorer-art';
import { Folder } from './explorer';
import * as bus from '../bus';
import { keepAwake } from '../shell/screensaver';

const CHEAP = new Set(['requantize', 'cbcr_swap', 'channel_drop', 'dc_offset', 'qtable_decode_swap', 'coeff_kill', 'color_matrix']);

let win: Win | null = null;
let cam: Cam | null = null;
/** The "nothing leaves this computer" box is shown once per session, before the first camera prompt. */
let agreed = false;

export function open() {
  if (win && getWin('webcam')) return win.focus();
  cam = new Cam();
}

function cheapSteps(nodes: StackNode[]): { id: string; params: Record<string, unknown>; seed: number }[] {
  const out: { id: string; params: Record<string, unknown>; seed: number }[] = [];
  const visit = (n: StackNode) => {
    if (!n.enabled || n.type !== 'step') return;
    const info = pipeline.catalog.get(n.id);
    if (!info || info.uses_pool) return;
    if (info.layer === 'byte' || info.layer === 'meta' || CHEAP.has(n.id)) out.push({ id: n.id, params: n.params, seed: n.seed });
  };
  for (const n of nodes) {
    if (n.type === 'repeat') {
      if (n.enabled) for (let r = 0; r < Math.min(3, n.times); r++) n.children.forEach(visit);
    } else visit(n);
  }
  return out;
}

/** The AVI's frame rate for n frames recorded in `secs`: a whole number from 1 to 30 (the engine's u32). */
export function recFps(n: number, secs: number): number {
  return Math.max(1, Math.min(30, Math.round(n / Math.max(0.5, secs))));
}

class Cam {
  private video = h('video', { playsInline: true, muted: true } as any) as HTMLVideoElement;
  private view = h('canvas', { width: 640, height: 480, 'aria-label': 'Live webcam preview' });
  private stream: MediaStream | null = null;
  private eng: EngineClient | null = null;
  private running = false;
  private starting = false;
  private quality = 40;
  private useRecipe = true;
  private recording: Uint8Array[] | null = null;
  private recStart = 0;
  private fps = 0;
  private lcd = h('div', { class: 'mp-lcd' }, '--.- fps');
  private lastJpeg: Uint8Array | null = null;
  private frameCount = 0;
  private unreg: () => void;
  private closing = false;
  private unwake: (() => void) | null = null;

  constructor() {
    const body = h('div', { class: 'mp' });
    win = openWindow({
      id: 'webcam',
      title: 'Camera Wizard',
      short: 'Webcam',
      icon: 'webcam',
      body,
      width: 600,
      height: 560,
      minWidth: 380,
      minHeight: 360,
      menu: [
        { label: '&File', items: () => [{ label: '&Snapshot to My Pictures', disabled: !this.stream, onClick: () => this.snap() }, { sep: true }, { label: '&Close', onClick: () => win?.close() }] },
        { label: '&Capture', items: () => this.captureMenu() },
        { label: '&Help', items: () => Folder.helpMenu({ id: 'webcam', label: '&Camera Wizard Help' }) },
      ],
      status: [h('div', { class: 'grow' })],
      onClose: () => {
        this.closing = true;
        this.stop();
      },
      onResize: () => this.fit(),
    });
    this.unreg = registerContext('.mp-video[data-mp="webcam"]', () => this.captureMenu());
    this.render();
  }

  private captureMenu(): MenuItem[] {
    return [
      this.stream ? { label: 'Stop &Camera', default: true, onClick: () => this.stop() } : { label: 'Start &Camera…', default: true, onClick: () => void this.start() },
      { sep: true },
      this.recording ? { label: 'Stop &Recording', onClick: () => void this.stopRec() } : { label: '&Record AVI', disabled: !this.stream, onClick: () => this.rec() },
      { label: '&Snapshot to My Pictures', disabled: !this.stream, onClick: () => this.snap() },
      { sep: true },
      { label: "Use the Editor's Reci&pe", checked: this.useRecipe, onClick: () => ((this.useRecipe = !this.useRecipe), this.render()) },
    ];
  }

  private tbtn(g: MediaGlyph, label: string, run: () => void, disabled: boolean, on = false): HTMLButtonElement {
    const b = h('button', { class: 'mp-btn' + (on ? ' on' : ''), type: 'button', 'aria-label': label, 'data-tip': label, disabled, onclick: run });
    b.style.setProperty('--glyph', `url("${mediaGlyph(g, disabled)}")`);
    return b;
  }

  private render() {
    if (!win) return;
    const live = !!this.stream;
    const area = h('div', { class: 'mp-video', dataset: { mp: 'webcam' } }, live ? this.view : h('div', { class: 'mp-blank' }, h('div', null, 'Press Play to start the camera. Its picture goes through the real JPEG codec, and never leaves this computer.')));
    const steps = cheapSteps(store.doc.stack);
    const snap = h('button', { class: 'mp-btn', type: 'button', 'aria-label': 'Snapshot to My Pictures', 'data-tip': 'Snapshot to My Pictures', disabled: !live, onclick: () => this.snap() }, iconImg('camera', 16));
    mount(
      win.body,
      area,
      h(
        'div',
        { class: 'mp-bar', role: 'toolbar', 'aria-label': 'Camera' },
        this.tbtn('play', 'Start Camera', () => void this.start(), live || this.starting, live),
        this.tbtn('stop', 'Stop Camera', () => this.stop(), !live),
        h('span', { class: 'mp-sep' }),
        this.tbtn('record', this.recording ? 'Stop Recording' : 'Record AVI', () => (this.recording ? void this.stopRec() : this.rec()), !live, !!this.recording),
        snap,
        this.lcd,
      ),
      h(
        'div',
        { class: 'mp-groups' },
        group(
          'Picture',
          h('div', { class: 'mp-row' }, h('span', null, 'JPEG quality:')),
          h('div', { class: 'mp-row' }, h('span', null, 'Low'), slider(this.quality, 1, 95, 1, (v) => (this.quality = v), { label: 'JPEG quality', ticks: 10 }), h('span', null, 'High')),
        ),
        group(
          'Recipe',
          checkbox(`Use the editor's recipe (${steps.length} quick step${steps.length === 1 ? '' : 's'})`, this.useRecipe, (v) => (this.useRecipe = v)),
          h('div', { class: 'mp-row hint' }, 'Only quick steps run live: byte damage, re-quantising, channel tricks.'),
        ),
      ),
    );
    this.status();
    requestAnimationFrame(() => this.fit());
  }

  private status() {
    if (!win) return;
    win.setStatus([this.recording ? `Recording: ${this.recording.length} frames` : this.stream ? 'Live' : 'Camera off', this.stream ? `${this.fps.toFixed(1)} fps` : '', '640 x 480']);
  }

  private fit() {
    const holder = this.view.parentElement;
    if (!holder) return;
    const W = holder.clientWidth - 4;
    const H = holder.clientHeight - 4;
    const s = Math.min(W / 640, H / 480);
    const z = s >= 1 ? Math.floor(s) : s;
    this.view.style.width = Math.round(640 * z) + 'px';
    this.view.style.height = Math.round(480 * z) + 'px';
    this.view.style.left = Math.round(2 + (W - 640 * z) / 2) + 'px';
    this.view.style.top = Math.round(2 + (H - 480 * z) / 2) + 'px';
  }

  private async start() {
    if (this.stream || this.starting) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      message('No camera here', 'This browser does not let pages use a camera here (it needs a secure https:// page). Everything else in File Refragmenter still works.', 'webcam');
      return;
    }
    if (!agreed) {
      const ok = await confirmBox(
        'Camera Wizard',
        'Your browser will now ask whether File Refragmenter may use the camera.\n\nThe picture is turned into JPEGs right here on this computer. Nothing is sent anywhere, and nothing is kept unless you press Record or Snapshot.',
        'Continue',
        'webcam',
      );
      if (!ok || this.closing) return;
      agreed = true;
    }
    this.starting = true;
    this.render();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    } catch (e) {
      if (this.closing) return;
      const name = (e as Error)?.name;
      message(
        'No camera',
        name === 'NotAllowedError' ? 'The camera was not allowed. You can allow it in your browser’s site settings and press Play again.' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'No camera was found on this device. Plug one in and press Play again.' : 'The camera could not be started (' + String((e as Error)?.message ?? e) + '). Is another program using it?',
        'webcam',
      );
      return;
    } finally {
      this.starting = false;
      // Play is enabled again (it was greyed while starting)
      if (!this.closing && !this.stream) this.render();
    }
    // the window can close during any of these waits: then the camera and the worker go at once
    if (this.closing) return this.release(this.stream);
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    if (this.closing) return this.release(this.stream);
    this.eng = this.eng ?? new EngineClient('webcam');
    await this.eng.ready;
    if (this.closing) return this.release(this.stream);
    this.running = true;
    // a live camera keeps the screen saver away
    this.unwake = keepAwake();
    this.render();
    void this.loop();
  }

  /** Lets go of a camera stream and (window closed) the private engine worker. */
  private release(stream: MediaStream | null) {
    stream?.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
    if (this.stream === stream) this.stream = null;
    if (this.closing) {
      this.eng?.dispose();
      this.eng = null;
    }
  }

  private stop() {
    this.running = false;
    this.unwake?.();
    this.unwake = null;
    // a recording in progress is saved, not thrown away (also when the window closes)
    const frames = this.recording;
    this.recording = null;
    const closed = this.closing || !getWin('webcam');
    const eng = this.eng;
    // (taken first, so release() leaves the worker to the recording)
    if (closed) this.eng = null;
    this.release(this.stream);
    if (closed) {
      if (frames?.length && eng) void this.saveRec(frames, eng).finally(() => eng.dispose());
      else eng?.dispose();
      this.unreg();
      win = null;
      cam = null;
    } else {
      if (frames?.length && eng) void this.saveRec(frames, eng);
      this.render();
    }
  }

  private async loop() {
    const tmp = document.createElement('canvas');
    tmp.width = 640;
    tmp.height = 480;
    const tx = tmp.getContext('2d', { willReadFrequently: true })!;
    const vx = this.view.getContext('2d')!;
    let t0 = performance.now();
    let frames = 0;
    while (this.running && this.eng) {
      const vw = this.video.videoWidth || 640;
      const vh = this.video.videoHeight || 480;
      const s = Math.max(640 / vw, 480 / vh);
      tx.drawImage(this.video, (640 - vw * s) / 2, (480 - vh * s) / 2, vw * s, vh * s);
      const rgba = tx.getImageData(0, 0, 640, 480).data;
      try {
        let jpg = await this.eng.encodeRgba(640, 480, rgba, { quality: this.quality }).promise;
        if (this.useRecipe) {
          for (const st of cheapSteps(store.doc.stack)) {
            try {
              jpg = await this.eng.applyStep(st.id, st.params, jpg, (st.seed + this.frameCount) >>> 0, null).promise;
            } catch {
              /* a failing step is skipped live */
            }
          }
        }
        this.lastJpeg = jpg;
        this.recording?.push(jpg);
        const d = await this.eng.decode(jpg, {}).promise;
        if (d.width === 640 && d.height === 480) vx.putImageData(new ImageData(new Uint8ClampedArray(d.rgba.buffer as ArrayBuffer), 640, 480), 0, 0);
        else {
          vx.fillStyle = '#808080';
          vx.fillRect(0, 0, 640, 480);
        }
      } catch {
        vx.fillStyle = '#808080';
        vx.fillRect(0, 0, 640, 480);
      }
      this.frameCount++;
      frames++;
      const now = performance.now();
      if (now - t0 > 1000) {
        this.fps = (frames * 1000) / (now - t0);
        frames = 0;
        t0 = now;
        setText(this.lcd, this.recording ? `REC ${this.recording.length}` : `${this.fps.toFixed(1)} fps`);
        this.lcd.classList.toggle('mp-rec', !!this.recording);
        this.status();
      }
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  private rec() {
    if (!this.eng?.has('avi_write')) {
      message('Not available yet', 'Recording needs the AVI writer from the engine, which is not built yet.', 'video');
      return;
    }
    this.recording = [];
    this.recStart = performance.now();
    this.render();
  }

  private async stopRec() {
    const frames = this.recording ?? [];
    this.recording = null;
    this.render();
    if (!frames.length || !this.eng) return;
    await this.saveRec(frames, this.eng);
  }

  private async saveRec(frames: Uint8Array[], eng: EngineClient) {
    const fps = recFps(frames.length, (performance.now() - this.recStart) / 1000);
    try {
      const avi = await eng.aviWrite(frames, 640, 480, fps).promise;
      download(avi, 'webcam_refrag.avi', 'video/x-msvideo');
      bus.emit('exported');
    } catch (e) {
      errorBox(String((e as Error).message ?? e));
    }
  }

  private snap() {
    if (!this.lastJpeg) return;
    store.addPhoto({ name: 'Webcam ' + new Date().toLocaleTimeString().replace(/:/g, '-') + '.jpg', source: 'webcam', bytes: this.lastJpeg }, { makeCurrent: false });
    message('Snapshot', 'Saved to My Pictures.', 'pictures');
  }
}

void cam;
