// ============================================================
// main.ts — 原神杀网页游戏总入口（多页面路由 + PVP网络）
// ============================================================

import './ui/main.css';
import './ui/home.css';
import './ui/chapters.css';
import './ui/match.css';
import './ui/game.css';
import './ui/login.css';

import { router, RouteState } from './ui/router';
import { HomePage } from './ui/HomePage';
import { ChaptersPage } from './ui/ChaptersPage';
import { MatchPage } from './ui/MatchPage';
import { WaitingPage } from './ui/WaitingPage';
import { GamePage } from './ui/GamePage';
import { LoginPage } from './ui/LoginPage';
import { socketManager } from './network/SocketManager';

// ---------- 应用入口 ----------
class App {
  private appEl: HTMLElement;
  private pages = new Map<string, { show: () => void; hide: () => void; onEnter?: (s: RouteState) => void }>();
  private currentPage: string | null = null;

  private homePage!: HomePage;
  private chaptersPage!: ChaptersPage;
  private matchPage!: MatchPage;
  private waitingPage!: WaitingPage;
  private gamePage!: GamePage;
  private loginPage!: LoginPage;

  constructor() {
    this.appEl = document.getElementById('app')!;
  }

  init(): void {
    this.homePage = new HomePage();
    this.chaptersPage = new ChaptersPage();
    this.matchPage = new MatchPage();
    this.waitingPage = new WaitingPage();
    this.gamePage = new GamePage();
    this.loginPage = new LoginPage();

    this.registerPage('home', this.homePage);
    this.registerPage('chapters', this.chaptersPage);
    this.registerPage('match', this.matchPage);
    this.registerPage('waiting', this.waitingPage);
    this.registerPage('game', this.gamePage);
    this.registerPage('login', this.loginPage);

    router.onNavigate((state) => {
      this.switchPage(state);
    });

    // 连接 PVP 服务器
    socketManager.connect();
    socketManager.on('__connected', () => {
      console.log('%c原神杀 v2.0%c 已启动 · PVP服务器已连接', 'font-size:20px;color:#ffd700;', '');
      // 尝试自动登录
      const savedToken = socketManager.getSavedToken();
      if (savedToken) {
        socketManager.setToken(savedToken);
        socketManager.emit('auth_token', { token: savedToken });
      }
    });

    socketManager.on('logged_in', (data: any) => {
      if (data?.account) {
        socketManager.setAccount(data.account);
        socketManager.setToken(data.token);
        console.log('[App] 已登录:', data.account.name, '当前页:', this.currentPage);
        // 登录成功统一进入主页
        if (this.currentPage === 'login') {
          console.log('[App] 从登录页自动跳转到 home');
          router.navigate('home');
        }
      }
    });

    socketManager.on('auth_failed', () => {
      socketManager.setToken(null);
    });

    // 服务器重连旧房间：如果旧房间有活动游戏则不再自动拉回（避免重复进入旧对局）
    // 用户可以自行在 MatchPage 创建新房间，create_room 会自动清理旧房间
    socketManager.on('reconnected', (data: any) => {
      console.log('[App] 服务器重连旧房间:', data.roomId, '当前页:', this.currentPage);
      // 不自动跳转 — 让用户自己决定是否回到旧房间
      // 如果想恢复旧房间，可以导航到 waiting 页面：
      // router.navigate('waiting', { roomId: data.roomId, ... });
    });

    // 启动时先进入登录页（有 token 的话会通过 auth_token 自动登录跳转）
    this.switchPage({ page: 'login' });

    console.log('%c原神杀 v2.0%c 已启动', 'font-size:20px;color:#ffd700;', '');
    console.log('模式：PVE闯关 + PVP联机（WebSocket）');
    console.log('从22位武将中选将，1主/2忠/4反/1内');
  }

  private registerPage(
    id: string,
    page: { render: () => HTMLElement; show: () => void; hide: () => void; onEnter?: (s: RouteState) => void }
  ): void {
    const el = page.render();
    this.appEl.appendChild(el);
    this.pages.set(id, {
      show: () => page.show(),
      hide: () => page.hide(),
      onEnter: page.onEnter ? (s: RouteState) => page.onEnter!(s) : undefined,
    });
  }

  private switchPage(state: RouteState): void {
    if (this.currentPage) {
      const current = this.pages.get(this.currentPage);
      current?.hide();
    }

    const next = this.pages.get(state.page);
    if (next) {
      next.show();
      if (next.onEnter) {
        next.onEnter(state);
      }
      this.currentPage = state.page;
    }
  }
}

// 启动
const app = new App();
app.init();
