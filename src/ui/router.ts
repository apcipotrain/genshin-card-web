// ============================================================
// router.ts — 多页面路由系统
// ============================================================

export type PageId = 'home' | 'chapters' | 'match' | 'waiting' | 'game' | 'result' | 'login';

export interface RouteState {
  page: PageId;
  params?: Record<string, unknown>;
}

type RouteListener = (state: RouteState) => void;

class Router {
  private current: RouteState = { page: 'home' };
  private listeners: RouteListener[] = [];
  private history: RouteState[] = [];

  navigate(page: PageId, params?: Record<string, unknown>): void {
    this.history.push({ ...this.current });
    this.current = { page, params };
    this.notify();
  }

  back(): void {
    const prev = this.history.pop();
    if (prev) {
      this.current = prev;
      this.notify();
    }
  }

  getState(): RouteState {
    return { ...this.current };
  }

  onNavigate(fn: RouteListener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter(l => l !== fn);
    };
  }

  private notify(): void {
    const state = this.getState();
    this.listeners.forEach(fn => fn(state));
  }
}

export const router = new Router();
