// The hidden Foldy timing panel (Ctrl+Shift+F): a slider for every timing number, applied live and saved in
// settings.foldyTiming. Foldy has his panel in this window too, so "Say a test line" plays right here.
import { h } from '../ui/dom';
import { openWindow, getWin } from '../ui/wm';
import { slider, button } from '../ui/controls';
import { settings, setSettings } from '../settings';
import { DEFAULT_TIMING, TIMING_RANGES, sanitizeTiming, type FoldyTiming } from './timeline';
import { foldy } from './foldy';

const TEST_LINES = [
  "Hi! I'm Foldy. I explain what happened to your photo, block by block.",
  'One flipped bit in the compressed data can derail everything after it, until the next restart marker.',
  'Colour is stored as differences from the previous block. Start from a wrong value, and every block after it keeps the wrong tint.',
];
let testN = 0;

/** Groups for the two columns. */
const GROUPS: [string, (keyof FoldyTiming)[]][] = [
  ['Talking', ['textCharMs', 'frameMs', 'lettersPerStep', 'minSteps', 'wordGapMs', 'commaGapMs', 'sentenceGapMs', 'joltPx', 'lingerMs', 'moodHoldMs']],
  ['Idle and pain', ['bobPeriodMs', 'bobAmpPx', 'bobFps', 'eyeLagSteps', 'blinkMinMs', 'blinkMaxMs', 'blinkFrameMs', 'doubleBlinkPct', 'painMs', 'painFps', 'tearPx', 'winceMs']],
];

export function openTuning() {
  if (getWin('foldy-tuning')) return getWin('foldy-tuning')!.focus();
  const cols = h('div', { class: 'ftune-cols' });
  const render = () => {
    const t = sanitizeTiming(settings.foldyTiming);
    cols.replaceChildren(
      ...GROUPS.map(([legend, keys]) =>
        h(
          'div',
          { class: 'group ftune-group', role: 'group', 'aria-label': legend },
          h('div', { class: 'legend' }, legend),
          ...keys.map((k) => row(k, t[k])),
        ),
      ),
    );
  };
  const row = (k: keyof FoldyTiming, v: number) => {
    const [min, max, step, label, unit] = TIMING_RANGES[k];
    const out = h('span', { class: 'tx ftune-val' }, fmt(v, unit));
    const changed = v !== DEFAULT_TIMING[k];
    const name = h('span', { class: 'ftune-name' + (changed ? ' changed' : '') }, label);
    const s = slider(v, min, max, step, (nv) => {
      out.textContent = fmt(nv, unit);
      name.classList.toggle('changed', nv !== DEFAULT_TIMING[k]);
      const next: Partial<FoldyTiming> = { ...settings.foldyTiming, [k]: nv };
      if (nv === DEFAULT_TIMING[k]) delete next[k];
      setSettings({ foldyTiming: next });
    }, { label });
    s.dataset.key = k;
    return h('div', { class: 'ftune-row' }, name, s, out);
  };
  render();
  const body = h(
    'div',
    { class: 'ftune' },
    h('p', { class: 'ftune-help' }, 'Changes apply at once and are saved in this browser. Bold names differ from the defaults.'),
    cols,
    h(
      'div',
      { class: 'ftune-btns' },
      button('Say a test line', () => foldy.help(TEST_LINES[testN++ % TEST_LINES.length]), { cls: 'default' }),
      button('Pain glitch', () => {
        foldy.player.painGlitch();
      }),
      button('Reset to defaults', () => {
        setSettings({ foldyTiming: {} });
        render();
      }),
      button('Close', () => getWin('foldy-tuning')?.close()),
    ),
  );
  openWindow({ id: 'foldy-tuning', title: 'Foldy Timing', short: 'Timing', icon: 'folder', body, width: 640, height: 470, resizable: false });
}

function fmt(v: number, unit: string): string {
  return unit ? `${v} ${unit}` : String(v);
}
