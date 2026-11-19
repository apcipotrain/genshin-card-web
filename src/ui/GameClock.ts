/** Measure time from a monotonic clock, even when browser timer callbacks are throttled. */
export class GameClock {
  private origin: number | null = null;
  private frozen = 0;
  private duration = 0;
  constructor(private readonly now: () => number = () => performance.now()) {}
  start(durationMs = 0): void {
    this.origin = this.now();
    this.frozen = 0;
    this.duration = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
  }
  stop(): void { this.frozen = this.elapsedMs; this.origin = null; }
  get running(): boolean { return this.origin !== null; }
  get elapsedMs(): number { return this.origin === null ? this.frozen : Math.max(0, this.now() - this.origin); }
  get elapsedSeconds(): number { return Math.floor(this.elapsedMs / 1000); }
  get remainingMs(): number { return Math.max(0, this.duration - this.elapsedMs); }
  get remainingSeconds(): number { return Math.ceil(this.remainingMs / 1000); }
  get percent(): number { return this.duration ? Math.min(100, this.remainingMs / this.duration * 100) : 0; }
}
