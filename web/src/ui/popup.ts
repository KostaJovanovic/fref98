// The lifecycle every popup shares (menus with their submenus, drop-down lists): one popup at a time, and
// while one is open it gets the keyboard first, a press outside it and a window resize close it.

let current: (() => void) | null = null;

/** Starts a popup's lifecycle and closes the popup that was open before. `close` closes this popup (it is
 *  called when another one opens and on a resize); the popup's own close must call the returned `end`,
 *  which removes the listeners. `onOutside` sees every pointer press (it decides what counts as outside),
 *  from the next task on, so the press that opened the popup isn't one. */
export function popupLifecycle(o: { close: () => void; onOutside: (e: PointerEvent) => void; onKey: (e: KeyboardEvent) => void }): () => void {
  current?.();
  current = o.close;
  let ended = false;
  const onResize = () => o.close();
  const t = setTimeout(() => !ended && addEventListener('pointerdown', o.onOutside, true), 0);
  addEventListener('keydown', o.onKey, true);
  addEventListener('resize', onResize);
  return () => {
    if (ended) return;
    ended = true;
    clearTimeout(t);
    removeEventListener('pointerdown', o.onOutside, true);
    removeEventListener('keydown', o.onKey, true);
    removeEventListener('resize', onResize);
    if (current === o.close) current = null;
  };
}

/** Closes the open popup, if any. */
export function closePopup() {
  current?.();
}
