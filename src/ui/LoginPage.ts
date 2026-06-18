// ============================================================
// LoginPage.ts — 登录 / 注册页面
// ============================================================

import { router } from './router';
import { socketManager } from '../network/SocketManager';

export class LoginPage {
  private el!: HTMLElement;
  private mode: 'login' | 'signup' = 'login';
  private submitTimeout: number | null = null;
  private unsubAuth: Array<() => void> = [];
  private authHandler: ((data: any) => void) | null = null;
  private domRefs: {
    errorEl: HTMLElement;
    submitBtn: HTMLButtonElement;
    restoreBtn: () => void;
  } | null = null;

  render(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'page login-page';
    container.innerHTML = `
      <div class="login-bg">
        <div class="login-card">
          <div class="login-title">原 神 杀</div>
          <div class="login-subtitle">GENSHIN CARD</div>
          <div class="login-form">
            <div class="form-group">
              <label>玩家名称</label>
              <input class="form-input" id="login-name" placeholder="输入你的昵称..." maxlength="12" autofocus />
            </div>
            <div class="form-group">
              <label>密码</label>
              <input class="form-input" id="login-password" type="password" placeholder="输入密码..." />
            </div>
            <div class="form-group" id="confirm-group" style="display:none;">
              <label>确认密码</label>
              <input class="form-input" id="login-confirm" type="password" placeholder="再次输入密码..." />
            </div>
            <div class="login-error" id="login-error"></div>
            <button class="btn btn-gold login-btn" id="login-submit">登 录</button>
            <div class="login-switch">
              <span id="switch-text">还没有账号？</span>
              <a href="#" id="switch-link">立即注册</a>
            </div>
          </div>
        </div>
      </div>
    `;

    // 绑定事件
    const nameInput = container.querySelector('#login-name') as HTMLInputElement;
    const pwInput = container.querySelector('#login-password') as HTMLInputElement;
    const confirmInput = container.querySelector('#login-confirm') as HTMLInputElement;
    const confirmGroup = container.querySelector('#confirm-group') as HTMLElement;
    const errorEl = container.querySelector('#login-error') as HTMLElement;
    const submitBtn = container.querySelector('#login-submit') as HTMLButtonElement;
    const switchText = container.querySelector('#switch-text') as HTMLElement;
    const switchLink = container.querySelector('#switch-link') as HTMLElement;

    const toggleMode = () => {
      this.mode = this.mode === 'login' ? 'signup' : 'login';
      confirmGroup.style.display = this.mode === 'signup' ? 'block' : 'none';
      submitBtn.textContent = this.mode === 'login' ? '登 录' : '注 册';
      switchText.textContent = this.mode === 'login' ? '还没有账号？' : '已有账号？';
      switchLink.textContent = this.mode === 'login' ? '立即注册' : '去登录';
      errorEl.textContent = '';
      nameInput.focus();
    };

    switchLink.addEventListener('click', (e) => { e.preventDefault(); toggleMode(); });

    // 回车提交
    const restoreButton = () => {
      if (this.submitTimeout) { clearTimeout(this.submitTimeout); this.submitTimeout = null; }
      submitBtn.disabled = false;
      submitBtn.textContent = this.mode === 'login' ? '登 录' : '注 册';
    };

    const trySubmit = () => {
      const name = nameInput.value.trim();
      const pw = pwInput.value;
      const confirm = confirmInput.value;

      if (!name) { errorEl.textContent = '请输入名称'; return; }
      if (name.length > 12) { errorEl.textContent = '名称最多12字符'; return; }
      if (!pw || pw.length < 3) { errorEl.textContent = '密码至少3位'; return; }

      if (this.mode === 'signup') {
        if (pw !== confirm) { errorEl.textContent = '两次密码不一致'; return; }
      }

      if (!socketManager.isConnected) {
        errorEl.textContent = '未连接到服务器，请确认服务器已启动';
        return;
      }

      errorEl.textContent = '';
      submitBtn.disabled = true;
      submitBtn.textContent = '...';

      if (this.mode === 'signup') {
        socketManager.emit('signup', { name, password: pw });
      } else {
        socketManager.emit('login', { name, password: pw });
      }

      // 超时保护：10秒无响应恢复按钮
      if (this.submitTimeout) clearTimeout(this.submitTimeout);
      this.submitTimeout = window.setTimeout(() => {
        if (submitBtn.disabled) {
          errorEl.textContent = '服务器无响应，请确认网络连接';
          restoreButton();
        }
      }, 10000);
    };

    submitBtn.addEventListener('click', trySubmit);
    container.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') trySubmit();
    });

    // 服务器响应处理器（保存引用，以便 show/hide 中挂载/卸载）
    this.authHandler = (data: any) => {
      console.log('[LoginPage] ★ 收到认证响应:', JSON.stringify(data));
      restoreButton();
      if (data.success) {
        console.log('[LoginPage] ★ 认证成功，准备跳转到 home');
        try {
          socketManager.setAccount(data.account);
          socketManager.setToken(data.token);
          socketManager.emit('logged_in', { account: data.account, token: data.token });
          // 显示成功反馈
          errorEl.style.color = '#4caf50';
          errorEl.textContent = `✓ ${this.mode === 'signup' ? '注册' : '登录'}成功，正在进入游戏...`;
          // 短暂延迟后跳转到主页，让用户看到反馈
          setTimeout(() => {
            console.log('[LoginPage] ★ 调用 router.navigate("home")');
            router.navigate('home');
          }, 300);
        } catch (e) {
          console.error('[LoginPage] ★ 跳转异常:', e);
          errorEl.style.color = '#ff5757';
          errorEl.textContent = '跳转失败: ' + (e instanceof Error ? e.message : String(e));
        }
      } else {
        console.log('[LoginPage] 认证失败:', data.reason);
        errorEl.style.color = '#ff5757';
        errorEl.textContent = data.reason || '登录失败';
      }
    };

    // 保存 DOM 引用
    this.domRefs = { errorEl, submitBtn, restoreBtn: restoreButton };

    this.el = container;
    return container;
  }

  show(): void {
    this.el.classList.add('active');
    // 重置错误颜色
    if (this.domRefs) {
      this.domRefs.errorEl.style.color = '#ff5757';
    }
    const nameInput = this.el.querySelector('#login-name') as HTMLInputElement;
    if (nameInput) setTimeout(() => nameInput.focus(), 100);

    // 每次显示时重新注册认证事件监听器
    if (this.authHandler) {
      this.unsubAuth.push(socketManager.on('login_result', this.authHandler));
      this.unsubAuth.push(socketManager.on('signup_result', this.authHandler));
      console.log('[LoginPage] 已注册 auth 监听器，当前登录模式:', this.mode);
    }
  }

  hide(): void {
    this.el.classList.remove('active');
    // 离开登录页时清理认证事件监听
    for (const unsub of this.unsubAuth) {
      unsub();
    }
    this.unsubAuth = [];
  }
}
