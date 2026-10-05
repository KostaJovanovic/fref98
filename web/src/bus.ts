// A tiny app-wide event bus (Foldy and the tutorial listen to what the user does).

export type BusEvent =
  | 'photo-loaded'
  | 'preset-chosen'
  | 'stack-changed'
  | 'exported'
  | 'long-start'
  | 'long-end'
  | 'heavy-damage'
  | 'clean'
  | 'decode-events'
  | 'step-added'
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
