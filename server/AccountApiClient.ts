import { randomUUID } from 'node:crypto';
import type { Account, LoginResult, PVPStats } from './AccountManager.js';

export type PublicAccount = Omit<Account, 'passwordHash'> & {
  pveStars?: Record<number, number>;
  settings?: Record<string, unknown>;
  stats?: PVPStats;
};
export interface ExpResult {
  success: boolean;
  oldLevel: number;
  newLevel: number;
  totalExp: number;
  leveledUp: boolean;
}

/** The game server owns live matches; Java is the sole writer of account data. */
export class AccountApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!serviceKey.trim()) throw new Error('缺少 GAME_SERVICE_KEY，请通过 npm start 或启动脚本运行');
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('ACCOUNT_API_URL 必须是 HTTP 地址');
  }

  private async request<T>(path: string, method = 'GET', body?: unknown, token?: string, internal = false): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(internal ? { 'X-Game-Service-Key': this.serviceKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    });
    if (response.status >= 500) throw new Error(`账号服务返回 HTTP ${response.status}`);
    const result = await response.json() as T;
    return result;
  }

  async health(): Promise<boolean> {
    const result = await this.request<{ status: string }>('/api/health');
    return result.status === 'ok';
  }

  signup(name: string, password: string): Promise<LoginResult> {
    return this.request('/api/auth/signup', 'POST', { name, password });
  }

  login(name: string, password: string): Promise<LoginResult> {
    return this.request('/api/auth/login', 'POST', { name, password });
  }

  async validateToken(token: string): Promise<PublicAccount | null> {
    if (!token || typeof token !== 'string') return null;
    const result = await this.request<{ success: boolean; account?: PublicAccount }>('/api/account', 'GET', undefined, token);
    return result.success ? result.account ?? null : null;
  }

  async logout(token: string): Promise<void> {
    await this.request('/api/auth/logout', 'POST', undefined, token);
  }

  updateProfile(token: string, data: { nickname?: string; avatar?: string }): Promise<{ success: boolean; account?: PublicAccount; reason?: string }> {
    return this.request('/api/account/profile', 'PATCH', data, token);
  }

  async saveSettings(token: string, settings: Record<string, unknown>): Promise<boolean> {
    const result = await this.request<{ success: boolean }>('/api/account/settings', 'PUT', settings, token);
    return result.success;
  }

  async savePVEStars(token: string, stars: Record<number, number>): Promise<boolean> {
    const result = await this.request<{ success: boolean }>('/api/account/pve-stars', 'PUT', { stars }, token);
    return result.success;
  }

  /** PVE is currently simulated in the browser; the existing reward report is retained. */
  async addExp(token: string, amount: number, operationId = randomUUID()): Promise<ExpResult | null> {
    const account = await this.validateToken(token);
    if (!account) return null;
    const result = await this.request<ExpResult>(`/internal/accounts/${encodeURIComponent(account.id)}/exp`,
      'POST', { amount, operationId }, undefined, true);
    if (!result.success) throw new Error('经验结算被账号服务拒绝');
    return result;
  }

  async settlePVP(accountId: string, amount: number, role: string, won: boolean, operationId: string): Promise<ExpResult> {
    const result = await this.request<ExpResult>(`/internal/accounts/${encodeURIComponent(accountId)}/pvp-result`,
      'POST', { amount, role, won, operationId }, undefined, true);
    if (!result.success) throw new Error('对局结算被账号服务拒绝');
    return result;
  }
}
