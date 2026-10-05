// A tiny app-wide event bus (Foldy and the tutorial listen to what the user does).

export type BusEvent =
  | 'photo-loaded'
  | 'preset-chosen'
  | 'exported'
  | 'long-start'
  | 'long-end'
  /** The result is badly damaged; data `{ grey: true }` when almost nothing survived. */
  | 'heavy-damage'
  /** "How bad?" reached an end: data = 'low' | 'max'. */
  | 'slider-end'
  | 'another-roll'
  | 'undo'
  /** A dropped or picked file is not something the app can open. */
  | 'unreadable'
  /** Emitted by the card workspace after a carve (no listener yet: the card's Foldy reactions come with the card rework). */
  | 'card-carved'
  | 'error'
  | 'explain-image'
  /** The editor switched between simple and expert mode, or closed: data = 'simple' | 'expert' | 'closed'. */
  | 'mode-changed';

type Handler = (data?: any) => void;
const handlers = new Map<BusEvent, Set<Handler>>();

export function on(ev: BusEvent, f: Handler): () => void {
  let s = handlers.get(ev);
  if (!s) handlers.set(ev, (s = new Set()));
  s.add(f);
  return () => s!.delete(f);
}

export function emit(ev: BusEvent, data?: any) {
  for (const f of handlers.get(ev) ?? []) {
    try {
      f(data);
    } catch (e) {
      console.warn('bus handler', ev, e);
    }
  }
}
