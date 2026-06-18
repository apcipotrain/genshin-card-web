// ============================================================
// AccountManager.ts — 账号管理（内存 + 文件持久化）
// 数据文件: server/accounts.json
// ============================================================

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname_esm = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_FILE = path.resolve(__dirname_esm, 'accounts.json');

export interface Account {
  id: string;
  name: string;
  passwordHash: string;
  nickname: string;
  avatar: string;
  level: number;
  exp: number;
  createdAt: number;
}

/** 经验等级系统
 * 1-55级：每级升下一级所需经验 = 当前等级 × 100
 * 56级：56000 | 57级：57000 | 58级：58000 | 59级：59000 | 60级封顶
 */
function buildCumulative(): { level: number; totalExp: number }[] {
  const cumul: { level: number; totalExp: number }[] = [];
  let total = 0;
  cumul.push({ level: 1, totalExp: 0 });
  for (let lv = 1; lv < 60; lv++) {
    let need: number;
    if (lv <= 55) { need = lv * 100; }
    else if (lv === 56) { need = 56000; }
    else if (lv === 57) { need = 57000; }
    else if (lv === 58) { need = 58000; }
    else { need = 59000; } // lv === 59
    total += need;
    cumul.push({ level: lv + 1, totalExp: total });
  }
  return cumul;
}
const CUMULATIVE = buildCumulative();

export function getLevelAndProgress(exp: number): { level: number; currentExp: number; nextExp: number } {
  for (let i = CUMULATIVE.length - 1; i >= 0; i--) {
    if (exp >= CUMULATIVE[i].totalExp) {
      const next = i + 1 < CUMULATIVE.length ? CUMULATIVE[i + 1] : null;
      return {
        level: CUMULATIVE[i].level,
        currentExp: exp - CUMULATIVE[i].totalExp,
        nextExp: next ? next.totalExp - CUMULATIVE[i].totalExp : 0,
      };
    }
  }
  return { level: 1, currentExp: 0, nextExp: 100 };
}

export function getLevelByExp(exp: number): number {
  return getLevelAndProgress(exp).level;
}

export interface LoginResult {
  success: boolean;
  account?: Omit<Account, 'passwordHash'>;
  token?: string;
  reason?: string;
}

export class AccountManager {
  private accounts: Map<string, Account> = new Map(); // id → Account
  private nameIndex: Map<string, Account> = new Map(); // name → Account
  private tokens: Map<string, string> = new Map(); // token → accountId

  constructor() {
    this.loadFromFile();
  }

  // ============ 文件持久化 ============

  private loadFromFile(): void {
    try {
      if (fs.existsSync(ACCOUNTS_FILE)) {
        const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
        const list: any[] = JSON.parse(raw);
        for (const item of list) {
          // 兼容旧格式：补全字段
          if (!item.nickname) item.nickname = item.name || '';
          if (!item.avatar) item.avatar = '';
          if (item.level === undefined) item.level = 1;
          if (item.exp === undefined) item.exp = 0;
          const acc = item as Account;
          this.accounts.set(acc.id, acc);
          this.nameIndex.set(acc.name, acc);
        }
        console.log(`[AccountManager] 从文件加载了 ${list.length} 个账号`);
      }
    } catch (e) {
      console.warn('[AccountManager] 加载账号文件失败，使用全新存储:', e);
    }
  }

  private saveToFile(): void {
    try {
      const list = Array.from(this.accounts.values());
      fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(list, null, 2), 'utf-8');
    } catch (e) {
      console.error('[AccountManager] 保存账号文件失败:', e);
    }
  }

  // ============ 业务逻辑 ============

  private hashPassword(password: string): string {
    return crypto.createHash('sha256').update(password).digest('hex');
  }

  private generateToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  private sanitize(acc: Account): Omit<Account, 'passwordHash'> {
    return { id: acc.id, name: acc.name, nickname: acc.nickname, avatar: acc.avatar, level: acc.level ?? 1, exp: acc.exp ?? 0, createdAt: acc.createdAt };
  }

  signup(name: string, password: string): LoginResult {
    if (!name || name.trim().length === 0) {
      return { success: false, reason: '名称不能为空' };
    }
    if (name.trim().length > 12) {
      return { success: false, reason: '名称不能超过12个字符' };
    }
    if (!password || password.length < 3) {
      return { success: false, reason: '密码至少3位' };
    }
    const normalizedName = name.trim();
    if (this.nameIndex.has(normalizedName)) {
      return { success: false, reason: '该名称已被注册' };
    }

    const id = crypto.randomBytes(8).toString('hex');
    const account: Account = {
      id,
      name: normalizedName,
      passwordHash: this.hashPassword(password),
      nickname: normalizedName,
      avatar: '',
      level: 1,
      exp: 0,
      createdAt: Date.now(),
    };

    this.accounts.set(id, account);
    this.nameIndex.set(normalizedName, account);
    this.saveToFile(); // 持久化

    const token = this.generateToken();
    this.tokens.set(token, id);

    return { success: true, account: this.sanitize(account), token };
  }

  login(name: string, password: string): LoginResult {
    const normalizedName = name.trim();
    const account = this.nameIndex.get(normalizedName);
    if (!account) {
      return { success: false, reason: '账号不存在' };
    }
    if (account.passwordHash !== this.hashPassword(password)) {
      return { success: false, reason: '密码错误' };
    }

    const token = this.generateToken();
    this.tokens.set(token, account.id);

    return { success: true, account: this.sanitize(account), token };
  }

  /** 验证 token 并返回账号信息 */
  validateToken(token: string): Omit<Account, 'passwordHash'> | null {
    const accountId = this.tokens.get(token);
    if (!accountId) return null;
    const account = this.accounts.get(accountId);
    if (!account) return null;
    return this.sanitize(account);
  }

  /** 登出（清除 token） */
  logout(token: string): void {
    this.tokens.delete(token);
  }

  getAccountByToken(token: string): Account | null {
    const accountId = this.tokens.get(token);
    if (!accountId) return null;
    return this.accounts.get(accountId) || null;
  }

  /** 增加经验值，返回 { oldLevel, newLevel, totalExp }，可能触发升级
   *  60级封顶：溢出经验截断，exp 精确停在 60 级所需经验值 */
  addExp(token: string, amount: number): { oldLevel: number; newLevel: number; totalExp: number; leveledUp: boolean } | null {
    console.log(`[AccountManager] addExp token=${token?.substring(0,8)}... amount=${amount}`);
    const account = this.getAccountByToken(token);
    if (!account) { console.warn(`[AccountManager] addExp FAILED: token not in tokens map`); return null; }
    const oldLevel = account.level;
    account.exp += Math.max(0, amount);
    const { level: newLevel } = getLevelAndProgress(account.exp);
    account.level = Math.min(newLevel, 60);
    if (account.level >= 60) account.exp = CUMULATIVE[CUMULATIVE.length - 1].totalExp;
    this.saveToFile();
    console.log(`[AccountManager] addExp OK: ${account.name} Lv${oldLevel}→${account.level} exp=${account.exp}`);
    return { oldLevel, newLevel: account.level, totalExp: account.exp, leveledUp: account.level > oldLevel };
  }

  /** 通过 accountId 直接增加经验（服务端结算专用，绕过 tokens map 过期问题） */
  addExpByAccountId(accountId: string, amount: number): { oldLevel: number; newLevel: number; totalExp: number; leveledUp: boolean } | null {
    const account = this.accounts.get(accountId);
    if (!account) { console.warn(`[AccountManager] addExpById FAILED: id=${accountId}`); return null; }
    const oldLevel = account.level;
    account.exp += Math.max(0, amount);
    const { level: newLevel } = getLevelAndProgress(account.exp);
    account.level = Math.min(newLevel, 60);
    if (account.level >= 60) account.exp = CUMULATIVE[CUMULATIVE.length - 1].totalExp;
    this.saveToFile();
    console.log(`[AccountManager] addExpById OK: ${account.name} Lv${oldLevel}→${account.level} exp=${account.exp}`);
    return { oldLevel, newLevel: account.level, totalExp: account.exp, leveledUp: account.level > oldLevel };
  }

  /** 更新用户资料（昵称、头像） */
  updateProfile(token: string, data: { nickname?: string; avatar?: string }): { success: boolean; account?: Omit<Account, 'passwordHash'>; reason?: string } {
    const account = this.getAccountByToken(token);
    if (!account) {
      return { success: false, reason: 'token无效' };
    }
    if (data.nickname !== undefined) {
      const trimmed = data.nickname.trim();
      if (trimmed.length === 0) {
        return { success: false, reason: '昵称不能为空' };
      }
      if (trimmed.length > 12) {
        return { success: false, reason: '昵称不能超过12个字符' };
      }
      account.nickname = trimmed;
    }
    if (data.avatar !== undefined) {
      account.avatar = data.avatar;
    }
    this.saveToFile();
    return { success: true, account: this.sanitize(account) };
  }
}
