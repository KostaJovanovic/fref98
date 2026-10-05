// Unlimited undo/redo over serialised states. Consecutive edits with the same merge key (slider drags)
// within a short time collapse into one undo step (Q15).

export class History<T> {
  private past: string[] = [];
  private future: string[] = [];
  private lastKey: string | null = null;
  private lastTime = 0;
  private current: string;

  constructor(initial: T, private mergeMs = 1200) {
    this.current = JSON.stringify(initial);
  }

  /** Record a new state. Returns false when nothing changed. */
  push(state: T, mergeKey: string | null = null, now = Date.now()): boolean {
    const s = JSON.stringify(state);
    if (s === this.current) return false;
    const merge = mergeKey !== null && mergeKey === this.lastKey && now - this.lastTime < this.mergeMs && this.past.length > 0;
    if (!merge) this.past.push(this.current);
    this.current = s;
    this.future = [];
    this.lastKey = mergeKey;
    this.lastTime = now;
    return true;
  }

  /** Replace the current state without creating an undo step (e.g. after load). */
  reset(state: T) {
    this.past = [];
    this.future = [];
    this.current = JSON.stringify(state);
    this.lastKey = null;
  }

  /** Rewrites every state (past, current and future), e.g. to drop something that was deleted for good. */
  rewrite(f: (state: T) => T) {
    const g = (s: string) => JSON.stringify(f(JSON.parse(s) as T));
    this.past = this.past.map(g);
    this.future = this.future.map(g);
    this.current = g(this.current);
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get depth(): number {
    return this.past.length;
  }

  undo(): T | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(this.current);
    this.current = prev;
    this.lastKey = null;
    return JSON.parse(prev) as T;
  }

  redo(): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(this.current);
    this.current = next;
    this.lastKey = null;
    return JSON.parse(next) as T;
  }

  peek(): T {
    return JSON.parse(this.current) as T;
  }
}
