/** The lifetime of one match, independent of a page, socket or OS thread. */
export class GameSessionCancelled extends Error {
  constructor() { super('Game session ended'); this.name = 'GameSessionCancelled'; }
}

/** Stops an in-flight rule when a death determines the winner. */
export class GameResolutionEnded extends Error {
  constructor() { super('Winner determined'); this.name = 'GameResolutionEnded'; }
}

export class GameSession {
  private ended = false;
  private cleanups = new Set<() => void>();

  get active(): boolean { return !this.ended; }

  assertActive(): void {
    if (this.ended) throw new GameSessionCancelled();
  }

  /** Register cleanup; returns a function that unregisters it without executing it. */
  onDispose(cleanup: () => void): () => void {
    if (this.ended) { cleanup(); return () => {}; }
    this.cleanups.add(cleanup);
    return () => this.cleanups.delete(cleanup);
  }

  /** Cancel pending interaction instead of silently abandoning its Promise. */
  wait<T>(executor: (resolve: (value: T) => void, reject: (error: unknown) => void) => void | (() => void)): Promise<T> {
    const promise = new Promise<T>((resolve, reject) => {
      if (this.ended) { reject(new GameSessionCancelled()); return; }
      let settled = false;
      let release: (() => void) | undefined;
      let unregister = () => {};
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        unregister();
        release?.();
        callback();
      };
      unregister = this.onDispose(() => finish(() => reject(new GameSessionCancelled())));
      try {
        const result = executor(value => finish(() => resolve(value)), error => finish(() => reject(error)));
        if (typeof result === 'function') {
          release = result;
          if (settled) release();
        }
      } catch (error) { finish(() => reject(error)); }
    });
    // Some UI-only callers intentionally ignore a Promise. Keep cancellation handled
    // while returning the original rejection to callers awaiting the game loop.
    void promise.catch(() => {});
    return promise;
  }

  delay(ms: number): Promise<void> {
    return this.wait<void>(resolve => {
      const timer = setTimeout(() => resolve(), ms);
      return () => clearTimeout(timer);
    });
  }

  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      unregister();
      if (this.active) callback();
    }, ms);
    const unregister = this.onDispose(() => clearTimeout(timer));
    return timer;
  }

  setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval> {
    const timer = setInterval(() => { if (this.active) callback(); }, ms);
    this.onDispose(() => clearInterval(timer));
    return timer;
  }

  dispose(): void {
    if (this.ended) return;
    this.ended = true;
    const pending = [...this.cleanups];
    this.cleanups.clear();
    for (const cleanup of pending) cleanup();
  }
}
