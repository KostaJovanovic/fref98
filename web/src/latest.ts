// "Latest value wins" scheduling (pure). At most one run in flight plus the latest pending value: requests
// that arrive while a run is going overwrite each other, and only the newest one runs when it finishes. An idle
// runner starts at once (no debounce). `supersede` cancels the run in flight (its result would be useless, e.g.
// another photo); `cancel()` drops the pending value and cancels the run in flight.

export interface RunToken {
  readonly cancelled: boolean;
  /** Called once when the run is cancelled (immediately if it already was). */
  onCancel(f: () => void): void;
}

class Token implements RunToken {
  cancelled = false;
  private hooks: (() => void)[] = [];
  onCancel(f: () => void) {
    if (this.cancelled) f();
    else this.hooks.push(f);
  }
  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const f of this.hooks.splice(0)) {
      try {
        f();
      } catch {
        /* a cancel hook must not stop the others */
      }
    }
  }
}

export class LatestRunner<T> {
  private cur: { token: Token; value: T } | null = null;
  private next: { value: T } | null = null;

  constructor(private exec: (value: T, token: RunToken) => Promise<unknown> | unknown) {}

  /** A run is in flight (possibly cancelled and winding down). */
  get running(): boolean {
    return !!this.cur;
  }

  /** A newer value waits for the run in flight. */
  get pending(): boolean {
    return !!this.next;
  }

  /** The value of the run in flight. */
  get current(): T | undefined {
    return this.cur?.value;
  }

  request(value: T, supersede = false) {
    if (!this.cur) {
      this.start(value);
      return;
    }
    this.next = { value };
    if (supersede) this.cur.token.cancel();
  }

  cancel() {
    this.next = null;
    this.cur?.token.cancel();
  }

  private start(value: T) {
    const token = new Token();
    const cur = { token, value };
    this.cur = cur;
    let p: Promise<unknown>;
    try {
      p = Promise.resolve(this.exec(value, token));
    } catch (e) {
      p = Promise.reject(e);
    }
    void p
      .catch(() => {})
      .then(() => {
        if (this.cur !== cur) return;
        this.cur = null;
        const n = this.next;
        this.next = null;
        if (n) this.start(n.value);
      });
  }
}
