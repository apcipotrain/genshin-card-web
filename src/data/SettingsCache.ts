// ============================================================
// SettingsCache.ts — 内存设置缓存（替代 localStorage）
// 服务端 sync → 使用 → save到服务端
// ============================================================

const cache: Record<string, any> = {};

/** 缓存数值（从服务端同步时调用） */
export function cacheSet(key: string, value: any): void {
  cache[key] = value;
}

/** 读取缓存（默认值兜底） */
export function cacheGet(key: string, defaultValue: any): any {
  if (key in cache) return cache[key];
  return defaultValue;
}

/** 保存到服务端（异步，不阻塞） */
export function cacheSave(key: string, value: any, emit?: (data: Record<string, any>) => void): void {
  cache[key] = value;
  if (emit) emit({ [key]: value });
}

/** 从服务端同步完整设置数据 */
export function syncAllSettings(settings: Record<string, any>): void {
  Object.assign(cache, settings);
}

/** 获取所有设置（用于批量保存） */
export function getAllSettings(): Record<string, any> {
  return { ...cache };
}
