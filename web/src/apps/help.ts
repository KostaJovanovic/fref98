// Help, as the Windows 98 HTML Help viewer (Contents / Index / Search tabs on the left, the topic on the
// right, a toolbar with Hide, Back, Forward, Home, Print and Options), and the About box (with the privacy
// explanation behind the "Network: blocked" badge). The topic pages are deliberately 1999 web pages.
import { h, mount } from '../ui/dom';
import { iconImg } from '../ui/art';
import { button, tabs, textField } from '../ui/controls';
import { openWindow, getWin, type Win } from '../ui/wm';
import { spinningGlobe, marquee, hitCounter, visitCount } from '../ui/y2k';
import { pipeline } from '../pipeline';
import { APPS, openApp } from './registry';
import { foldy } from '../foldy/foldy';
import { logoArt } from './splash';
import { APP_NAME } from '../brand';
import { VERSION } from '../version';
import { registerContext } from '../ui/contextmenu';
import { menuAt, type MenuItem } from '../ui/menu';
import { message } from '../ui/dialog';
import { bookIcon } from './tools98';

interface Topic {
  id: string;
  title: string;
  body: () => (string | HTMLElement)[];
  see?: string[];
}

const TOPICS: Topic[] = [
  {
    id: 'start',
    title: 'Getting started',
    body: () => [
      marquee('*** Welcome to File Refragmenter 98 Gold Help! *** Your photos, beautifully broken. ***'),
      '1. Drop a photo onto the editor (or press "Try a sample photo").',
      '2. On the right, pick what happened to it: a dead SD card, 40 forwards on WhatsApp, a 2004 camera…',
      '3. Drag "How bad?".',
      '4. Press Save As… (or File ▸ Save As…) to save the broken .jpg. That file really is broken: open it in other programs and compare.',
      'Everything else is optional depth.',
    ],
    see: ['real', 'save'],
  },
  {
    id: 'real',
    title: 'What is real here?',
    body: () => [
      'File Refragmenter runs your photo through a real JPEG encoder and decoder (written in Rust, running in your browser) and damages the real data: pixels, quantised coefficients, bytes and whole simulated filesystems.',
      'The preview shows the true decoded pixels, never dithered. Zoom to 1:1 to see the 8×8 blocks.',
      'Our decoder is forgiving like a recovery tool: it never gives up, fills missing blocks and keeps going after bad markers. Switch the decoder personality (expert mode) or use the three-way compare to see how others show the same file.',
    ],
    see: ['hex', 'card'],
  },
  {
    id: 'modes',
    title: 'Simple and expert mode',
    body: () => [
      'Simple mode builds a real list of steps from a story. "Show Me How" opens the same steps in expert mode.',
      'Expert mode shows the step stack: steps run from top to bottom. Reorder them by dragging the dotted grip or with the ▲▼ buttons (keyboard: Alt+↑/↓). Every random step has its own seed and dice.',
      'Badges show what a step works on: pixel, coeff (DCT coefficients), byte (the file itself), card (a simulated memory card), meta (EXIF). "sim" marks the few effects that are simulated looks rather than real data damage.',
      'A dashed "automatic re-encode" marker shows where the engine has to decode a damaged file and save it again before a pixel step can run.',
    ],
    see: ['keys'],
  },
  {
    id: 'hex',
    title: 'Hex Doctor',
    body: () => [
      'Hex Doctor shows the compressed bytes of the photo in the editor. Header segments are navy, markers (FF followed by a code) red, the picture data black.',
      'Click a block in the editor preview to jump to its bytes; select bytes to see which blocks they paint.',
      'Edit bytes by clicking one and typing hex digits. Right-click the bytes to copy them as hex or text, fill them with 00 or FF, or randomize them. Your edits become a "Hex edit" step. If an earlier step changes the file, the edit is marked stale instead of being applied to the wrong bytes.',
      'Go ▸ Go To Offset… (Ctrl+G) jumps to a hexadecimal or decimal offset. F3 finds the next marker.',
    ],
    see: ['real'],
  },
  {
    id: 'card',
    title: 'Removable Disk (E:)',
    body: () => [
      'A complete simulated memory card with a real FAT16/FAT32/exFAT filesystem, shown like a drive in Windows Explorer.',
      'File ▸ Copy Pictures to Disk… "shoots" photos from My Pictures onto the card. Then things happen to it, from the Camera menu or as an accident: deletions, formats, new photos overwriting old ones, a battery dying mid-save, a PC writing its junk files.',
      'Deleted files stay visible, greyed out, with the first letter replaced by "?", as DOS undelete showed them.',
      'Tools ▸ Recover Files… runs a recovery tool over the card, just like PhotoRec or an undelete tool would. The recovered pictures land in the Rebuilt folder. File ▸ Properties shows the used and free space; Tools ▸ Cluster Map shows who owns which part of the card.',
      'In expert mode the Camera History lists every event, and File ▸ Save Disk Image saves the raw .img to try real recovery tools on.',
    ],
    see: ['real'],
  },
  {
    id: 'save',
    title: 'Saving your work',
    body: () => [
      'File ▸ Save As… opens the Save As dialog. Pick the kind of file in "Save as type": the broken JPEG, a PNG of the preview, the whole project (.rfg), the recipe (the steps only), a ZIP of all your pictures broken the same way, a GIF, AVI or MP4 animation of the damage, or a contact sheet.',
      'Options… holds the settings of each kind (privacy for JPEGs, which pictures go in a ZIP, the animation frames).',
      'Files go to your browser’s Downloads folder. "Save in: My Pictures" keeps a JPEG inside File Refragmenter instead.',
      'Video Lab saves its damaged clip with File ▸ Save As… (an MJPEG .avi). Camera Wizard records an .avi with Record and saves it when you stop recording, stop the camera or close the window.',
    ],
    see: ['privacy', 'video', 'webcam'],
  },
  {
    id: 'folders',
    title: 'My Pictures, Presets and the Recycle Bin',
    body: () => [
      'My Pictures holds every photo you opened, as a 98 folder: View switches between Large Icons, Small Icons, List, Details and Thumbnails. Double-click a picture to open it in the editor.',
      'Presets lists every story the editor knows. "Show Me How" opens its steps in the editor’s expert mode.',
      'Deleted photos, steps and projects go to the Recycle Bin. Restore puts them back where they were; Empty Recycle Bin removes them for good.',
    ],
    see: ['save', 'modes'],
  },
  {
    id: 'video',
    title: 'Video Lab',
    body: () => [
      'Video Lab opens an MJPEG .avi (File ▸ Open…, or drop one on it): every frame of those is a JPEG of its own.',
      'Effects ▸ Apply Recipe to Every Frame… runs the editor’s steps on each frame, each with its own seed. The Play menu and the buttons play, pause, stop and step through the frames; Effects switches between the damaged and the original frames.',
      'File ▸ Save As… writes the damaged clip as a new .avi.',
    ],
    see: ['save', 'webcam'],
  },
  {
    id: 'webcam',
    title: 'Camera Wizard',
    body: () => [
      'Camera Wizard turns your camera’s picture into JPEGs as you watch, with our own encoder at the quality you pick. The browser asks first whether the page may use the camera; nothing is sent anywhere.',
      'With "Use the editor’s recipe" on, the quick steps of your recipe (byte damage, re-quantising, channel tricks) run on every frame.',
      'Snapshot keeps the current frame in My Pictures. Record collects frames into an .avi, saved when you stop.',
    ],
    see: ['video', 'privacy'],
  },
  {
    id: 'display',
    title: 'Display Properties',
    body: () => [
      'Right-click the desktop and choose Properties. Background picks the wallpaper (our own low-quality sky, a colour, tiles or your broken photo).',
      'Screen Saver picks one of six screen savers and how long to wait; Settings… sets its speed (and the marquee’s text). Preview starts it now: move the mouse or press a key to stop it. It stays away while a video plays, the camera runs or a long job works.',
      'Appearance picks a colour scheme (Windows Standard, Brick, Desert… High Contrast) and the animations. Settings sets the colours of the desktop (16, 256, High Color or True Color: the wallpaper and the screen saver are drawn in them; the photos in the editor always keep their true colours), the screen area and the font size.',
      'Changes show at once, but are only kept when you press OK or Apply. Cancel puts everything back.',
    ],
  },
  {
    id: 'privacy',
    title: 'Privacy',
    body: () => [
      'Nothing is uploaded. File Refragmenter has no server: after the page loads, a Content Security Policy blocks every network request except the app’s own files. That is what the "Network: blocked" badge in the tray means.',
      'Photos and projects are stored only in this browser (IndexedDB). "Shut Down…" in the Start menu clears them.',
      'When you export, GPS position, camera serial number and owner name are removed from the EXIF data by default. Embedding the recipe is off by default.',
      'No analytics, no cookies, no accounts.',
    ],
  },
  {
    id: 'keys',
    title: 'Keyboard',
    body: () => [
      'Ctrl+Z / Ctrl+Y: undo / redo (unlimited).',
      'Tab moves between controls. F6 cycles windows. Alt+Space opens a window’s system menu, Alt+F4 closes it.',
      'Shift+F10 or the menu key opens the right-click menu of whatever has the focus.',
      'In the step stack: ↑/↓ move between steps, Alt+↑/↓ move the step, Space switches it on/off, Enter opens its settings, Delete sends it to the Recycle Bin.',
      'Esc closes menus.',
    ],
  },
];

const BOOKS: { title: string; topics: string[] }[] = [
  { title: 'Introducing File Refragmenter', topics: ['start', 'real'] },
  { title: 'Using the Programs', topics: ['modes', 'hex', 'card', 'folders', 'video', 'webcam', 'save', 'display'] },
  { title: 'Privacy and the Keyboard', topics: ['privacy', 'keys'] },
];

const INDEX: [string, string][] = [
  ['8×8 blocks', 'real'],
  ['animation, saving', 'save'],
  ['badges (pixel, coeff, byte…)', 'modes'],
  ['carving', 'card'],
  ['chkdsk', 'card'],
  ['cluster map', 'card'],
  ['contact sheet', 'save'],
  ['decoder personality', 'real'],
  ['deleted files', 'card'],
  ['disk image (.img)', 'card'],
  ['EXIF, removing', 'privacy'],
  ['expert mode', 'modes'],
  ['export', 'save'],
  ['formatting a card', 'card'],
  ['Go To offset', 'hex'],
  ['hex edit', 'hex'],
  ['IndexedDB', 'privacy'],
  ['markers (FF xx)', 'hex'],
  ['network', 'privacy'],
  ['project (.rfg)', 'save'],
  ['recipe', 'save'],
  ['recovering files', 'card'],
  ['Save As', 'save'],
  ['screen saver', 'display'],
  ['seed', 'modes'],
  ['shortcut keys', 'keys'],
  ['undo', 'keys'],
  ['wallpaper', 'display'],
  ['ZIP of all pictures', 'save'],
];

const topicById = (id: string) => TOPICS.find((t) => t.id === id) ?? TOPICS[0];
const topicText = (t: Topic) => (t.title + ' ' + t.body().map((p) => (typeof p === 'string' ? p : p.textContent ?? '')).join(' ')).toLowerCase();

let hv: HelpViewer | null = null;

export function open(topic?: string) {
  if (hv && getWin('help')) {
    if (topic) hv.show(topic);
    hv.win.focus();
    return;
  }
  hv = new HelpViewer(topic ?? 'start');
}

class HelpViewer {
  win: Win;
  private cur: string;
  private back: string[] = [];
  private fwd: string[] = [];
  private tab = 0;
  private open = new Set<number>([0, 1, 2]);
  private hidden = false;
  private nav = h('div', { class: 'hh-nav' });
  private page = h('div', { class: 'hh-topic y2k selectable', tabIndex: 0 });
  private bar = h('div', { class: 'hh-toolbar', role: 'toolbar', 'aria-label': 'Help toolbar' });
  private visits = visitCount();
  private query = '';
  private found: string[] | null = null;
  private keyword = '';
  private unreg: (() => void)[] = [];

  constructor(topic: string) {
    this.cur = topicById(topic).id;
    const body = h('div', { class: 'hh98' }, this.bar, h('div', { class: 'hh-main' }, this.nav, this.page));
    this.win = openWindow({
      id: 'help',
      // (the registry's title, so the desktop, Start menu and error boxes say the same)
      title: APPS.help.title,
      short: 'Help',
      icon: 'help',
      body,
      width: 640,
      height: 440,
      minWidth: 320,
      minHeight: 220,
      onClose: () => {
        for (const u of this.unreg) u();
        hv = null;
      },
    });
    this.unreg.push(
      registerContext('.hh-topic', () => {
        const sel = getSelection();
        const has = !!sel && !sel.isCollapsed && this.page.contains(sel.anchorNode);
        return [
          { label: '&Back', disabled: !this.back.length, onClick: () => this.goBack() },
          { label: '&Forward', disabled: !this.fwd.length, onClick: () => this.goFwd() },
          { sep: true },
          { label: 'Select &All', onClick: () => this.selectAll() },
          { label: '&Copy', disabled: !has, onClick: () => void navigator.clipboard?.writeText(sel!.toString()).catch(() => document.execCommand('copy')) },
          { sep: true },
          { label: '&Print…', onClick: () => this.print() },
          { label: 'P&roperties', onClick: () => message('Properties', `${topicById(this.cur).title}\n\nType: HTML Help topic\nAddress: mk:@MSITStore:refrag.chm::/${this.cur}.htm`, 'info') },
        ];
      }),
      registerContext('.hh-nav .hh-node', (t) => {
        const n = t.closest('.hh-node') as HTMLElement;
        const id = n.dataset.topic;
        const book = n.dataset.book;
        if (book !== undefined)
          return [
            { label: this.open.has(+book) ? '&Close' : '&Open', default: true, onClick: () => this.toggleBook(+book) },
            { sep: true },
            { label: '&Print…', onClick: () => this.print() },
          ];
        return [
          { label: '&Display', default: true, onClick: () => id && this.show(id) },
          { label: '&Print…', onClick: () => id && (this.show(id), this.print()) },
        ];
      }),
      registerContext('.hh-nav .hh-pick', (t) => [{ label: '&Display', default: true, onClick: () => (t.closest('.hh-pick') as HTMLElement).click() }]),
    );
    this.renderBar();
    this.renderNav();
    this.renderTopic();
  }

  show(id: string, record = true) {
    const t = topicById(id);
    if (record && t.id !== this.cur) {
      this.back.push(this.cur);
      this.fwd = [];
    }
    this.cur = t.id;
    this.renderBar();
    this.renderTopic();
    if (this.tab === 0) this.renderNav();
  }

  private goBack() {
    const p = this.back.pop();
    if (!p) return;
    this.fwd.push(this.cur);
    this.show(p, false);
  }

  private goFwd() {
    const n = this.fwd.pop();
    if (!n) return;
    this.back.push(this.cur);
    this.show(n, false);
  }

  private selectAll() {
    const r = document.createRange();
    r.selectNodeContents(this.page);
    const s = getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
  }

  private print() {
    message('Print', 'Windows cannot print this topic: no printer is installed.\nTo keep a topic, select its text and copy it.', 'warning');
  }

  private toggleBook(i: number) {
    if (this.open.has(i)) this.open.delete(i);
    else this.open.add(i);
    this.renderNav();
  }

  // ------------------------------------------------------------ toolbar

  private renderBar() {
    const big = (label: string, icon: HTMLElement, f: () => void, opts: { disabled?: boolean; tip?: string } = {}) => {
      const b = h('button', { class: 'tool hh-big', 'aria-label': label, 'data-tip': opts.tip ?? label, disabled: !!opts.disabled, onclick: f }, icon, h('span', null, label));
      return b;
    };
    const optBtn = big('Options', iconImg('settings', 16), () => menuAt(optBtn, this.optionsMenu(), { label: 'Options' }));
    mount(
      this.bar,
      big(this.hidden ? 'Show' : 'Hide', iconImg('documents', 16), () => this.toggleHide(), { tip: this.hidden ? 'Show the navigation pane' : 'Hide the navigation pane' }),
      big('Back', iconImg('undo', 16), () => this.goBack(), { disabled: !this.back.length }),
      big('Forward', iconImg('redo', 16), () => this.goFwd(), { disabled: !this.fwd.length }),
      big('Home', iconImg('help', 16), () => this.show('start')),
      big('Print', iconImg('project', 16), () => this.print()),
      optBtn,
    );
  }

  private optionsMenu(): MenuItem[] {
    return [
      { label: this.hidden ? '&Show Tabs' : '&Hide Tabs', onClick: () => this.toggleHide() },
      { label: '&Back', disabled: !this.back.length, onClick: () => this.goBack() },
      { label: '&Forward', disabled: !this.fwd.length, onClick: () => this.goFwd() },
      { label: 'H&ome', onClick: () => this.show('start') },
      { sep: true },
      { label: '&Print…', onClick: () => this.print() },
      { sep: true },
      { label: 'Ask &Foldy', icon: 'folder', onClick: () => foldy.show() },
      { label: '&About File Refragmenter', icon: 'about', onClick: () => openAbout() },
    ];
  }

  private toggleHide() {
    this.hidden = !this.hidden;
    this.nav.style.display = this.hidden ? 'none' : '';
    this.renderBar();
  }

  // ------------------------------------------------------------ left pane

  private renderNav() {
    const t = tabs(['Contents', 'Index', 'Search'], this.tab, (i, byKey) => {
      this.tab = i;
      this.renderNav();
      // a click goes on into the page (its field or tree); the arrow keys stay on the tabs
      if (!byKey) requestAnimationFrame(() => this.nav.querySelector<HTMLElement>('.hh-tabpage input, .hh-tree')?.focus());
    });
    const page = h('div', { class: 'tabpage hh-tabpage' });
    if (this.tab === 0) page.append(this.contents());
    else if (this.tab === 1) this.index(page);
    else this.search(page);
    mount(this.nav, t, page);
  }

  private contents(): HTMLElement {
    const tree = h('div', { class: 'hh-tree', role: 'tree', tabIndex: 0, 'aria-label': 'Contents' });
    const rows: HTMLElement[] = [];
    BOOKS.forEach((b, i) => {
      const isOpen = this.open.has(i);
      const r = h('div', { class: 'hh-node', role: 'treeitem', 'aria-expanded': String(isOpen), dataset: { book: String(i) }, onclick: () => this.toggleBook(i) }, bookIcon(isOpen ? 'open' : 'closed'), h('span', { class: 'hh-lbl' }, b.title));
      rows.push(r);
      if (isOpen)
        for (const id of b.topics) {
          const tp = topicById(id);
          rows.push(h('div', { class: 'hh-node hh-leaf' + (id === this.cur ? ' sel' : ''), role: 'treeitem', dataset: { topic: id }, onclick: () => this.show(id) }, bookIcon('page'), h('span', { class: 'hh-lbl' }, tp.title)));
        }
    });
    tree.append(...rows);
    tree.addEventListener('keydown', (e) => {
      const nodes = [...tree.querySelectorAll<HTMLElement>('.hh-node')];
      let i = nodes.findIndex((n) => n.classList.contains('sel') || n.classList.contains('kb'));
      const mark = (j: number) => {
        nodes.forEach((n, k) => n.classList.toggle('kb', k === j));
        nodes[j]?.scrollIntoView({ block: 'nearest' });
      };
      if (e.key === 'ArrowDown') mark(Math.min(nodes.length - 1, i + 1));
      else if (e.key === 'ArrowUp') mark(Math.max(0, i - 1));
      else if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        if (i < 0) i = 0;
        const n = nodes[i];
        if (!n) return;
        if (n.dataset.book !== undefined) {
          const open = this.open.has(+n.dataset.book);
          if (e.key === 'Enter' || e.key === ' ' || (e.key === 'ArrowRight') !== open) this.toggleBook(+n.dataset.book);
        } else if (n.dataset.topic && (e.key === 'Enter' || e.key === ' ')) this.show(n.dataset.topic);
        requestAnimationFrame(() => this.nav.querySelector<HTMLElement>('.hh-tree')?.focus());
      } else return;
      e.preventDefault();
    });
    return tree;
  }

  private index(page: HTMLElement) {
    const list = h('div', { class: 'list hh-list', role: 'listbox', 'aria-label': 'Keywords' });
    let picked: string | null = null;
    const fill = () => {
      const k = this.keyword.toLowerCase();
      list.replaceChildren(
        ...INDEX.map(([kw, id]) => {
          const r = h('div', { class: 'li hh-pick', role: 'option', onclick: () => select(r, id), ondblclick: () => this.show(id) }, kw);
          return r;
        }),
      );
      // the first keyword that starts with what was typed is highlighted, as in 98
      const j = INDEX.findIndex(([kw]) => kw.toLowerCase().startsWith(k));
      if (k && j >= 0) select(list.children[j] as HTMLElement, INDEX[j][1]);
    };
    const select = (r: HTMLElement, id: string) => {
      for (const c of list.children) c.classList.toggle('sel', c === r);
      picked = id;
      r.scrollIntoView({ block: 'nearest' });
    };
    const field = textField(this.keyword, (v) => ((this.keyword = v), fill()), { label: 'Keyword' });
    field.addEventListener('keydown', (e) => e.key === 'Enter' && picked && this.show(picked));
    fill();
    page.append(h('div', null, 'Type in the keyword to find:'), field, list, h('div', { class: 'hh-btnrow' }, button('Display', () => picked && this.show(picked))));
  }

  private search(page: HTMLElement) {
    const list = h('div', { class: 'list hh-list', role: 'listbox', 'aria-label': 'Topics found' });
    let picked: string | null = null;
    const fill = () => {
      list.replaceChildren(
        ...(this.found ?? []).map((id) => {
          const r = h('div', { class: 'li hh-pick', role: 'option', onclick: () => ((picked = id), [...list.children].forEach((c) => c.classList.toggle('sel', c === r))), ondblclick: () => this.show(id) }, topicById(id).title);
          return r;
        }),
      );
      if (this.found && !this.found.length) list.append(h('div', { class: 'li dim' }, 'No topics found.'));
    };
    const run = () => {
      const words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
      this.found = words.length ? TOPICS.filter((t) => words.every((w) => topicText(t).includes(w))).map((t) => t.id) : [];
      fill();
      const first = list.querySelector<HTMLElement>('.hh-pick');
      if (first) first.click();
    };
    const field = textField(this.query, (v) => (this.query = v), { label: 'Words to search for' });
    field.addEventListener('keydown', (e) => e.key === 'Enter' && run());
    fill();
    page.append(h('div', null, 'Type in the word(s) to search for:'), h('div', { class: 'hh-searchrow' }, field, button('List Topics', run, { cls: 'small' })), h('div', null, 'Select topic to display:'), list, h('div', { class: 'hh-btnrow' }, button('Display', () => picked && this.show(picked))));
  }

  // ------------------------------------------------------------ the topic page

  private renderTopic() {
    const t = topicById(this.cur);
    const see = (t.see ?? []).map((id) => h('li', null, h('span', { class: 'hh-link', role: 'link', tabIndex: 0, onclick: () => this.show(id), onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && this.show(id) }, topicById(id).title)));
    mount(
      this.page,
      h('div', { class: 'row hh-head' }, spinningGlobe(), h('h1', { class: 'big' }, t.title)),
      ...t.body().map((p) => (typeof p === 'string' ? h('p', null, p) : p)),
      see.length ? h('div', { class: 'box' }, h('h2', null, 'Related Topics'), h('ul', { class: 'hh-see' }, see)) : null,
      h('div', { class: 'hh-foot' }, h('span', null, 'You are visitor number'), hitCounter(this.visits), h('span', null, '· Best viewed at 800×600 · Last updated 25 June 1998')),
    );
    this.page.scrollTop = 0;
  }
}

/** Days this "unregistered copy" has been in use: since Windows 98 shipped (25 June 1998). */
export function nagDays(now = new Date()): number {
  return Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(1998, 5, 25)) / 86_400_000);
}

export function openAbout(section?: string) {
  if (getWin('about')) getWin('about')!.close();
  const caps = pipeline.caps;
  const engineTxt = caps?.exports.length ? `Engine: ${caps.exports.length} functions, ${caps.catalog.length} steps, ${caps.profiles.length} camera profiles.` : `Engine not loaded${caps?.loadError ? ': ' + caps.loadError : ''}.`;
  // the registration nag: a joke, only here, never blocking
  const nag = h('div', { class: 'about-nag-text' });
  const nagText = () => mount(nag, h('b', null, 'UNREGISTERED COPY'), h('div', null, `This copy has been used for ${nagDays().toLocaleString('en-US')} days. Please register.`));
  nagText();
  let pressed = 0;
  const register = button('Register…', () => {
    pressed++;
    mount(
      nag,
      h('b', null, pressed > 1 ? 'STILL UNREGISTERED' : 'THANK YOU!'),
      h('div', null, pressed > 1 ? 'The registration line is still busy. It has been busy since 1998.' : 'Registration is closed. This copy will keep working anyway, forever, for free.'),
    );
  }, { cls: 'small' });
  const body = h(
    'div',
    { class: 'about98' },
    logoArt(412, 96),
    h(
      'div',
      { class: 'about-main' },
      h('div', { class: 'about-id' }, h('b', null, APP_NAME), h('div', null, `Version ${VERSION}`), h('div', null, 'Registered to: Unregistered User'), h('div', null, 'Serial number: none (that is the point)'), h('div', { class: 'about-dim' }, engineTxt)),
      h('div', { class: 'about-nag' }, nag, register),
      h(
        'div',
        { class: 'group about-privacy', role: 'group', 'aria-label': 'Network: blocked' },
        h('div', { class: 'legend' }, 'Network: blocked'),
        h('p', null, 'This page cannot talk to the internet. A Content Security Policy allows only the app’s own files; there is no server to send anything to, no analytics and no accounts.'),
        h('p', null, 'Your photos stay in this browser. Exports strip GPS, serial numbers and owner names unless you say otherwise.'),
      ),
      h('p', { class: 'about-dim' }, 'All art, icons, the pixel font and Foldy are original, made for File Refragmenter. Open source (MIT or Apache-2.0).'),
    ),
    h('div', { class: 'about-btns' }, button('OK', () => openWindowClose(), { cls: 'default' }), button('Help topics', () => openApp('help'))),
  );
  openWindow({ id: 'about', title: 'About File Refragmenter', short: 'About', icon: 'about', body, width: 440, height: 470, resizable: false });
  if (section === 'privacy') requestAnimationFrame(() => body.querySelector('.about-privacy')?.scrollIntoView());
}

function openWindowClose() {
  getWin('about')?.close();
}
