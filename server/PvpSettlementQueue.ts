import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ExpResult } from './AccountApiClient.js';

export interface PendingSettlement {
  accountId: string;
  operationId: string;
  amount: number;
  role: string;
  won: boolean;
}

/** Persist before sending. Java's account + operation ID makes retries safe after a crash. */
export class PvpSettlementQueue {
  private pending = new Map<string, PendingSettlement>();
  private inFlight = new Map<string, Promise<ExpResult | null>>();

  constructor(private readonly file: string,
    private readonly send: (entry: PendingSettlement) => Promise<ExpResult>) {
    if (existsSync(file)) {
      // A damaged journal must be surfaced instead of silently discarding earned rewards.
      const entries: PendingSettlement[] = JSON.parse(readFileSync(file, 'utf8'));
      for (const entry of entries) this.pending.set(this.key(entry), entry);
    }
  }

  private key(entry: PendingSettlement): string {
    return `${entry.operationId}:${entry.accountId}`;
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify([...this.pending.values()]), 'utf8');
    renameSync(`${this.file}.tmp`, this.file);
  }

  enqueue(entries: PendingSettlement[]): void {
    for (const entry of entries) this.pending.set(this.key(entry), entry);
    this.save();
  }

  async attempt(entry: PendingSettlement): Promise<ExpResult | null> {
    const key = this.key(entry);
    const active = this.inFlight.get(key);
    if (active) return active;
    const task = (async () => {
      try {
        const result = await this.send(entry);
        if (!result.success) return null;
        this.pending.delete(key);
        try { this.save(); }
        catch (error) { this.pending.set(key, entry); throw error; }
        return result;
      } catch {
        console.warn('[Settlement] 对局奖励暂未入库，已保留并会自动重试');
        return null;
      }
    })();
    this.inFlight.set(key, task);
    try { return await task; }
    finally { this.inFlight.delete(key); }
  }

  async flush(): Promise<void> {
    for (const entry of [...this.pending.values()]) await this.attempt(entry);
  }

  get size(): number { return this.pending.size; }
}
