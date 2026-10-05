// The taskbar's notification area: sunken 98 tray with the Network: blocked icon, Foldy and the clock (the
// date in its tooltip; double-click or right-click ▸ Adjust Date/Time).
import { h, setText } from '../ui/dom';
import { iconImg } from '../ui/art';
import { message } from '../ui/dialog';
import { openApp } from '../apps/registry';
import { foldy } from '../foldy/foldy';

const longDate = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const shortTime = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export function adjustDateTime() {
  const d = new Date();
  message('Date/Time Properties', `Today is ${longDate(d)}, ${shortTime(d)}.\n\nFile Refragmenter reads your computer's clock but can't set it. Change it in your own system's settings.`, 'info');
}

export function buildTray(): HTMLElement {
  const net = h(
    'button',
    { class: 'tray-ico netbadge', type: 'button', 'data-tip': 'Network: blocked. Nothing leaves this computer.', 'aria-label': 'Network: blocked. Click for privacy details.', onclick: () => void openApp('about', 'privacy') },
    iconImg('network', 16),
  );
  const foldyBtn = h('button', { class: 'tray-ico', type: 'button', 'data-tip': 'Foldy', 'aria-label': 'Show Foldy', onclick: () => (foldy.enabled ? foldy.tip() : foldy.show()) }, iconImg('folder', 16));
  const clock = h('div', { class: 'clock', role: 'timer', 'aria-live': 'off' }, '');
  clock.addEventListener('dblclick', adjustDateTime);
  let lastTip = '';
  const tick = () => {
    const d = new Date();
    setText(clock, shortTime(d));
    const tip = longDate(d);
    if (tip !== lastTip) {
      clock.dataset.tip = lastTip = tip;
      clock.setAttribute('aria-label', `${shortTime(d)}, ${tip}`);
    }
  };
  tick();
  // next whole minute, then every minute
  setTimeout(() => {
    tick();
    setInterval(tick, 60_000);
  }, 60_000 - (Date.now() % 60_000) + 50);
  return h('div', { class: 'tray', role: 'group', 'aria-label': 'Notification area' }, net, foldyBtn, clock);
}
