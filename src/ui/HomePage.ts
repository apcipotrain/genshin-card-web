// ============================================================
// HomePage.ts — 主页面（左侧竖排导航 + PVE/PVP 入口 + 弹窗内容）
// ============================================================

import { router } from './router';
import { socketManager } from '../network/SocketManager';
import { ALL_HEROES, HeroData, getHeroById } from '../data/heroes';
import { VoiceManager } from '../audio/VoiceManager';
import { cacheGet, cacheSave, syncAllSettings } from '../data/SettingsCache';
import { syncPVEStarsFromServer } from '../data/PVELevels';

export class HomePage {
  private el!: HTMLElement;
  private avatarPreview: string = '';
  private currentPanel: 'account' | 'achievement' | 'compendium' | 'settings' | null = null;
  private overlay: HTMLElement | null = null;

  render(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'page home-page';
    container.innerHTML = `
      <!-- ========== 左侧竖排导航 ========== -->
      <div class="home-sidebar">
        <div class="sidebar-item" data-panel="account">
          <span class="sidebar-icon">👤</span>
          <span class="sidebar-label">账号管理</span>
        </div>
        <div class="sidebar-item" data-panel="achievement">
          <span class="sidebar-icon">🏅</span>
          <span class="sidebar-label">成就系统</span>
        </div>
        <div class="sidebar-item" data-panel="compendium">
          <span class="sidebar-icon">📖</span>
          <span class="sidebar-label">图 鉴</span>
        </div>
        <div class="sidebar-item" data-panel="settings">
          <span class="sidebar-icon">⚙️</span>
          <span class="sidebar-label">设 置</span>
        </div>
        <div class="sidebar-divider"></div>
        <div class="sidebar-item sidebar-logout" id="btn-logout">
          <span class="sidebar-icon">🚪</span>
          <span class="sidebar-label">退出账号</span>
        </div>
      </div>

      <!-- ========== 中间主区域 ========== -->
      <div class="home-main">
        <div class="home-header">
          <div class="home-title">原 神 杀</div>
          <div class="home-subtitle">GENSHIN CARD · 八人军争</div>
          <div class="home-status" id="home-status"></div>
        </div>
        <div class="home-modes">
          <div class="mode-card pve" id="btn-pve">
            <div class="mode-icon">⚔️</div>
            <div class="mode-name">P V E</div>
            <div class="mode-desc">闯关模式<br/>选择章节，与人机对战<br/>逐步解锁更多关卡</div>
          </div>
          <div class="mode-card pvp" id="btn-pvp">
            <div class="mode-icon">🏆</div>
            <div class="mode-name">P V P</div>
            <div class="mode-desc">联机模式<br/>创建或加入房间<br/>与真实玩家对战</div>
          </div>
        </div>
        <div class="home-footer" id="home-footer">v2.0 · 原神杀 · 八人军争</div>
      </div>

      <!-- ========== 弹窗遮罩（所有面板共用） ========== -->
      <div class="home-overlay" id="home-overlay"></div>
    `;

    // ---- 模式卡片 ----
    container.querySelector('#btn-pve')!.addEventListener('click', () => router.navigate('chapters'));
    container.querySelector('#btn-pvp')!.addEventListener('click', () => {
      router.navigate('match');
    });

    // ---- 侧边栏点击事件 ----
    const sidebarItems = container.querySelectorAll('.sidebar-item[data-panel]');
    sidebarItems.forEach(item => {
      item.addEventListener('click', () => {
        const panel = (item as HTMLElement).dataset.panel as 'account' | 'achievement' | 'compendium' | 'settings';
        this.openPanel(panel);
      });
    });

    // ---- 退出账号 ----
    container.querySelector('#btn-logout')!.addEventListener('click', () => {
      this.logout();
    });

    // ---- 遮罩层点击关闭 ----
    this.overlay = container.querySelector('#home-overlay');
    this.overlay!.addEventListener('click', () => {
      this.closePanel();
    });

    this.el = container;
    return container;
  }

  // ==================== 弹窗系统 ====================

  private openPanel(panel: 'account' | 'achievement' | 'compendium' | 'settings'): void {
    this.currentPanel = panel;

    // 高亮侧边栏
    this.el.querySelectorAll('.sidebar-item[data-panel]').forEach(item => {
      item.classList.toggle('active', (item as HTMLElement).dataset.panel === panel);
    });

    // 生成内容
    const overlay = this.overlay!;
    overlay.innerHTML = this.renderPanelContent(panel);
    overlay.classList.add('active');

    // 绑定内容中的事件
    this.bindPanelEvents(panel);
  }

  private closePanel(): void {
    this.currentPanel = null;
    this.el.querySelectorAll('.sidebar-item[data-panel]').forEach(item => item.classList.remove('active'));
    const overlay = this.overlay!;
    overlay.classList.remove('active');
    overlay.innerHTML = '';
  }

  /** 生成各面板的 HTML */
  private renderPanelContent(panel: 'account' | 'achievement' | 'compendium' | 'settings'): string {
    const acc = socketManager.account;

    const pdata = (this as any)._profileData;
    const lvl = pdata?.level ?? acc?.level ?? 1;
    // 经验进度：优先 pdata.progress → acc 上的计算值 → 兜底
    const currentExp = pdata?.progress?.currentExp ?? acc?.currentLevelExp ?? 0;
    const nextExp = pdata?.progress?.nextExp ?? acc?.nextLevelExp ?? 100;
    const expPct = nextExp > 0 ? Math.min(100, Math.round((currentExp / nextExp) * 100)) : 100;

    if (panel === 'account') {
      return `
        <div class="panel-modal" onclick="event.stopPropagation()">
          <div class="panel-modal-header">
            <h2>👤 账号管理</h2>
            <button class="panel-close-btn" id="panel-close">✕</button>
          </div>
          <div class="panel-modal-body">
            <div class="account-layout">
              <div class="account-avatar-section">
                <div class="avatar-wrapper" id="avatar-wrapper" title="点击上传头像">
                  <img class="avatar-img" id="avatar-img" src="${acc?.avatar || ''}" alt="头像" style="${acc?.avatar ? 'display:block' : 'display:none'}" />
                  <div class="avatar-placeholder" id="avatar-placeholder" style="${acc?.avatar ? 'display:none' : 'display:flex'}">点击<br/>上传</div>
                </div>
                <input type="file" id="avatar-file-input" accept="image/*" style="display:none" />
                <div class="account-level-badge">Lv.${lvl}</div>
              </div>
              <div class="account-info-section">
                <div class="account-field">
                  <span class="field-label">用户名</span>
                  <span class="field-value" id="acc-username">${acc?.name || '—'}</span>
                </div>
                <div class="account-field">
                  <span class="field-label">游戏昵称</span>
                  <input class="field-input" id="acc-nickname" placeholder="输入昵称..." maxlength="12" value="${acc?.nickname || acc?.name || ''}" />
                </div>
                ${lvl < 60 ? `
                <div class="account-exp-bar">
                  <div class="exp-bar-label">经验 ${currentExp}/${nextExp}</div>
                  <div class="exp-bar-track"><div class="exp-bar-fill" style="width:${expPct}%"></div></div>
                </div>` : '<div class="account-exp-bar" style="color:var(--gold);">🎉 已满级 Lv.60</div>'}
                <div class="account-field-hint">头像和昵称在PVP等待界面显示</div>
                <button class="btn btn-gold btn-sm" id="btn-save-profile">保存资料</button>
                <span class="profile-msg" id="profile-msg"></span>
              </div>
            </div>
          </div>
        </div>`;
    }

    if (panel === 'achievement') {
      return `
        <div class="panel-modal" onclick="event.stopPropagation()">
          <div class="panel-modal-header">
            <h2>🏅 成就系统</h2>
            <button class="panel-close-btn" id="panel-close">✕</button>
          </div>
          <div class="panel-modal-body">
            <div class="panel-placeholder">
              <div class="placeholder-icon">🏅</div>
              <div>成就系统开发中，敬请期待…</div>
            </div>
          </div>
        </div>`;
    }

    if (panel === 'compendium') {
      return this.renderCompendiumContent();
    }

    // settings
    const voiceMgr = VoiceManager.getInstance();
    const bgmEnabled = cacheGet('bgmEnabled', true); // 默认开
    const bgmVol = cacheGet('bgmVolume', 30);
    const voiceEnabled = voiceMgr.isEnabled;
    const voiceVol = Math.round(voiceMgr.getVolume() * 100);
    return `
      <div class="panel-modal" onclick="event.stopPropagation()">
        <div class="panel-modal-header">
          <h2>⚙️ 设 置</h2>
          <button class="panel-close-btn" id="panel-close">✕</button>
        </div>
        <div class="panel-modal-body">
          <div class="home-settings-section">
            <div class="home-settings-group-title">🔊 音频</div>
            <div class="home-settings-row">
              <span>背景音乐</span>
              <div class="toggle-switch ${bgmEnabled ? 'on' : ''}" id="home-bgm-toggle"></div>
            </div>
            <div class="home-settings-row">
              <span>音乐音量</span>
              <input type="range" min="0" max="100" value="${bgmVol}" class="home-slider" id="home-bgm-volume" />
              <span id="home-bgm-volume-label">${bgmVol}%</span>
            </div>
            <div class="home-settings-row">
              <span>角色语音</span>
              <div class="toggle-switch ${voiceEnabled ? 'on' : ''}" id="home-voice-toggle"></div>
            </div>
            <div class="home-settings-row">
              <span>语音音量</span>
              <input type="range" min="0" max="100" value="${voiceVol}" class="home-slider" id="home-voice-volume" />
              <span id="home-voice-volume-label">${voiceVol}%</span>
            </div>
          </div>
          <div class="home-settings-section">
            <div class="home-settings-group-title">🎮 游戏</div>
            <div class="home-settings-row">
              <span>AI出牌时间</span>
              <select class="settings-select" id="home-ai-delay">
                <option value="300">0.3秒（极速）</option>
                <option value="500">0.5秒（高速）</option>
                <option value="800">0.8秒（快速）</option>
                <option value="1200">1.2秒（中等）</option>
                <option value="1600" selected>1.6秒（推荐）</option>
                <option value="2000">2.0秒（慢速）</option>
                <option value="2500">2.5秒（较慢）</option>
                <option value="3000">3.0秒（悠闲）</option>
                <option value="5000">5.0秒（极慢）</option>
              </select>
            </div>
          </div>
        </div>
      </div>`;
  }

  /** 为面板内容绑定交互事件 */
  private bindPanelEvents(panel: 'account' | 'achievement' | 'compendium' | 'settings'): void {
    const overlay = this.overlay!;

    // 关闭按钮
    overlay.querySelector('#panel-close')?.addEventListener('click', () => this.closePanel());

    if (panel === 'account') {
      this.bindAccountEvents();
    }
    if (panel === 'compendium') {
      this.bindCompendiumEvents();
    }
    if (panel === 'settings') {
      this.bindHomeSettingsEvents();
    }
  }

  private bindAccountEvents(): void {
    const overlay = this.overlay!;

    // 头像上传
    const avatarWrapper = overlay.querySelector('#avatar-wrapper')!;
    const avatarImg = overlay.querySelector('#avatar-img') as HTMLImageElement;
    const avatarPlaceholder = overlay.querySelector('#avatar-placeholder') as HTMLElement;
    const fileInput = overlay.querySelector('#avatar-file-input') as HTMLInputElement;

    avatarWrapper.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        this.showProfileMsg('请选择图片文件', true);
        return;
      }
      this.cropToSquare(file).then(base64 => {
        this.avatarPreview = base64;
        avatarImg.src = base64;
        avatarImg.style.display = 'block';
        avatarPlaceholder.style.display = 'none';
      }).catch(() => {
        this.showProfileMsg('图片处理失败', true);
      });
    });

    // 保存资料
    overlay.querySelector('#btn-save-profile')!.addEventListener('click', () => {
      if (!socketManager.isConnected) {
        this.showProfileMsg('未连接服务器', true);
        return;
      }
      const nicknameInput = overlay.querySelector('#acc-nickname') as HTMLInputElement;
      const nickname = nicknameInput.value.trim();
      if (!nickname) {
        this.showProfileMsg('昵称不能为空', true);
        return;
      }

      const data: { nickname: string; avatar?: string } = { nickname };
      if (this.avatarPreview) {
        data.avatar = this.avatarPreview;
      }

      // 监听保存结果（一次性），同时处理成功和错误
      let resolved = false;
      const clean = () => { if (!resolved) { resolved = true; unsubSuccess(); unsubError(); } };
      const unsubSuccess = socketManager.on('profile_updated', (resp: any) => {
        if (resp?.account) {
          socketManager.setAccount(resp.account);
          this.showProfileMsg('保存成功！', false);
          // 刷新主界面状态
          const usernameEl = overlay.querySelector('#acc-username') as HTMLElement;
          if (usernameEl) usernameEl.textContent = resp.account.name;
          setTimeout(() => this.showProfileMsg('', false), 2000);
        }
        clean();
      });
      const unsubError = socketManager.on('error_msg', (resp: any) => {
        this.showProfileMsg(resp?.reason || '保存失败', true);
        clean();
      });
      // 8 秒超时保护
      setTimeout(() => { if (!resolved) { this.showProfileMsg('保存超时，请重试', true); clean(); } }, 8000);

      socketManager.emit('update_profile', data);
      this.showProfileMsg('保存中...', false);
    });
  }

  // ==================== 图鉴系统 ====================

  /** 构建按国家分组的英雄列表：神在前，然后首字母排序 */
  private buildCompendiumHeroes(): Map<string, HeroData[]> {
    const groups = new Map<string, HeroData[]>();
    const regionOrder = ['蒙德', '璃月', '稻妻', '须弥', '枫丹', '纳塔', '挪德卡莱'];

    for (const region of regionOrder) {
      const heroesOfRegion = ALL_HEROES.filter(h => h.region === region);
      if (heroesOfRegion.length === 0) continue;
      // 排序：神在前，非神按name首字母（中文拼音）
      const gods = heroesOfRegion.filter(h => h.isGod).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      const nonGods = heroesOfRegion.filter(h => !h.isGod).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      groups.set(region, [...gods, ...nonGods]);
    }
    return groups;
  }

  renderCompendiumContent(): string {
    const groups = this.buildCompendiumHeroes();
    const totalHeroes = ALL_HEROES.length;
    let html = `<div class="panel-modal panel-compendium" onclick="event.stopPropagation()">
      <div class="panel-modal-header">
        <h2>📖 神将图鉴 <span style="font-size:14px;color:var(--text-dim);font-weight:400;">（共${totalHeroes}位角色）</span></h2>
        <button class="panel-close-btn" id="panel-close">✕</button>
      </div>
      <div class="panel-modal-body compendium-body">`;

    for (const [region, heroes] of groups) {
      const regionEmoji: Record<string, string> = {
        '蒙德': '🕊️', '璃月': '🏮', '稻妻': '⛩️', '须弥': '🌿',
        '枫丹': '⚖️', '纳塔': '🔥', '挪德卡莱': '❄️'
      };
      html += `<div class="compendium-region">
        <div class="compendium-region-header">${regionEmoji[region] || '📍'} ${region}（${heroes.length}人）</div>
        <div class="compendium-hero-grid">`;

      for (const hero of heroes) {
        const imgSrc = `Resources/Characters/${hero.name}.png`;
        const godBadge = hero.isGod ? '<span class="hero-god-badge">★神</span>' : '';
        const elemClass = `card-${(hero.element || '无')}`;
        html += `<div class="compendium-hero-card ${elemClass}" data-hero-id="${hero.id}">
          <div class="compendium-hero-img">
            <img src="${imgSrc}" alt="${hero.name}" loading="lazy"
                 onerror="this.style.display='none';this.parentElement.querySelector('.hero-fb').style.display='flex';">
            <div class="hero-fb" style="display:none;">${hero.name.charAt(0)}</div>
          </div>
          <div class="compendium-hero-name">${godBadge}${hero.name}</div>
          <div class="compendium-hero-title">${hero.title}</div>
          <div class="compendium-hero-meta">${hero.element} · ${hero.maxHp}血</div>
        </div>`;
      }

      html += `</div></div>`;
    }

    html += `</div></div>`;
    return html;
  }

  private bindCompendiumEvents(): void {
    const overlay = this.overlay!;
    overlay.querySelector('#panel-close')?.addEventListener('click', () => this.closePanel());

    // 点击英雄卡片显示详细信息
    const heroCards = overlay.querySelectorAll('.compendium-hero-card');
    heroCards.forEach(card => {
      card.addEventListener('click', () => {
        const heroId = (card as HTMLElement).dataset.heroId!;
        this.showCompendiumHeroDetail(heroId);
      });
    });
  }

  /** 显示英雄详细资料弹窗 */
  private showCompendiumHeroDetail(heroId: string): void {
    const hero = getHeroById(heroId);
    if (!hero) return;

    const imgSrc = `Resources/Characters/${hero.name}.png`;
    const godBadge = hero.isGod ? ' <span style="color:var(--gold);">★神</span>' : '';
    const roleTag = (hero as any).role
      ? ` <span class="hero-role-tag role-${(hero as any).role}">${(hero as any).role}</span>` : '';
    const skillsHtml = hero.skills
      ? hero.skills.map(s => `<div class="compendium-skill"><strong>${s.name}</strong>：${s.desc}</div>`).join('')
      : '<div class="compendium-skill">暂无技能描述</div>';

    const detailOverlay = document.createElement('div');
    detailOverlay.className = 'game-modal-overlay compendium-detail-overlay';
    detailOverlay.id = 'compendium-detail-overlay';
    detailOverlay.innerHTML = `
      <div class="hero-info-popup compendium-detail-popup" onclick="event.stopPropagation()">
        <button class="hero-info-close" id="compendium-detail-close">✕</button>
        <div class="hero-info-layout">
          <div class="hero-info-img">
            <img src="${imgSrc}" alt="${hero.name}"
                 onerror="this.style.display='none';this.parentElement.querySelector('.char-fallback').style.display='flex';">
            <div class="char-fallback" style="display:none;width:100%;height:100%;">${hero.name.charAt(0)}</div>
          </div>
          <div class="hero-info-detail">
            <h2>${hero.name}${godBadge}${roleTag}</h2>
            <div class="hero-info-subtitle">${hero.title} · ${hero.region} · ${hero.element} · ${hero.gender === 'male' ? '♂男' : '♀女'}</div>
            <div class="hero-info-meta">
              <span class="hero-info-tag">❤ 体力上限${hero.maxHp}</span>
            </div>
            <div class="hero-info-skills-title">技能</div>
            <div class="hero-info-skills">${skillsHtml}</div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(detailOverlay);

    detailOverlay.querySelector('#compendium-detail-close')!.addEventListener('click', () => detailOverlay.remove());
    detailOverlay.addEventListener('click', e => { if (e.target === detailOverlay) detailOverlay.remove(); });
  }

  // ==================== 主页设置事件 ====================

  private bindHomeSettingsEvents(): void {
    const overlay = this.overlay!;
    const voiceMgr = VoiceManager.getInstance();

    // 背景音乐开关
    overlay.querySelector('#home-bgm-toggle')?.addEventListener('click', (e) => {
      const toggle = e.currentTarget as HTMLElement;
      const isOn = !toggle.classList.contains('on');
      toggle.classList.toggle('on', isOn);
      cacheSave('bgmEnabled', isOn, (d) => socketManager.emit('save_settings', d));
    });
    // 背景音乐音量
    const bgmSlider = overlay.querySelector('#home-bgm-volume') as HTMLInputElement;
    const bgmLabel = overlay.querySelector('#home-bgm-volume-label') as HTMLElement;
    if (bgmSlider) {
      bgmSlider.addEventListener('input', () => {
        const vol = parseInt(bgmSlider.value);
        bgmLabel.textContent = vol + '%';
        cacheSave('bgmVolume', vol, (d) => socketManager.emit('save_settings', d));
      });
    }
    // 角色语音开关
    overlay.querySelector('#home-voice-toggle')?.addEventListener('click', (e) => {
      const toggle = e.currentTarget as HTMLElement;
      const isOn = !toggle.classList.contains('on');
      toggle.classList.toggle('on', isOn);
      voiceMgr.setEnabled(isOn);
    });
    // 语音音量
    const voiceSlider = overlay.querySelector('#home-voice-volume') as HTMLInputElement;
    const voiceLabel = overlay.querySelector('#home-voice-volume-label') as HTMLElement;
    if (voiceSlider) {
      voiceSlider.addEventListener('input', () => {
        const vol = parseInt(voiceSlider.value) / 100;
        voiceMgr.setVolume(vol);
        voiceLabel.textContent = Math.round(vol * 100) + '%';
      });
    }
    // AI出牌时间
    const aiDelaySelect = overlay.querySelector('#home-ai-delay') as HTMLSelectElement;
    if (aiDelaySelect) {
      aiDelaySelect.value = String(cacheGet('aiDelay', 1600));
      aiDelaySelect.addEventListener('change', () => {
        cacheSave('aiDelay', parseInt(aiDelaySelect.value), (d) => socketManager.emit('save_settings', d));
      });
    }
  }

  // ==================== 退出登录 ====================

  private logout(): void {
    this.closePanel();
    // 通知服务端下线
    socketManager.emit('logout');
    // 清除本地凭证
    socketManager.setToken(null);
    socketManager.setAccount(null);
    router.navigate('login');
  }

  // ==================== 生命周期 ====================

  private _profileDataUnsub: (() => void) | null = null;

  show(): void {
    this.el.classList.add('active');
    // 清理旧的监听
    if (this._profileDataUnsub) { this._profileDataUnsub(); this._profileDataUnsub = null; }
    // 拉取等级数据
    if (socketManager.isConnected) {
      socketManager.emit('get_profile');
      this._profileDataUnsub = socketManager.on('profile_data', (data: any) => {
        (this as any)._profileData = data;
        // 同步 PVE 星级到内存
        if (data?.account?.pveStars) syncPVEStarsFromServer(data.account.pveStars);
        // 同步用户偏好设置到内存
        if (data?.account?.settings) syncAllSettings(data.account.settings);
        // 同步到 socketManager.account，确保 currentLevelExp/nextLevelExp 随时可用
        if (data?.account && socketManager.account) {
          socketManager.setAccount({
            ...socketManager.account,
            ...data.account,
            level: data.level ?? data.account.level,
            exp: data.exp ?? data.account.exp,
            currentLevelExp: data.progress?.currentExp,
            nextLevelExp: data.progress?.nextExp,
          });
        }
        this.refreshUI();
      });
    }
    this.refreshUI();
  }

  hide(): void {
    this.el.classList.remove('active');
    this.closePanel();
  }

  /** 刷新主界面状态 */
  private refreshUI(): void {
    const statusEl = this.el.querySelector('#home-status') as HTMLElement;
    const footerEl = this.el.querySelector('#home-footer') as HTMLElement;

    const acc = socketManager.account;
    const pdata = (this as any)._profileData;
    const lvl = pdata?.level ?? acc?.level ?? 1;

    if (acc) {
      statusEl.innerHTML = `已登录: ${acc.nickname || acc.name} <span style="color:var(--gold);">[Lv.${lvl}]</span>`;
    } else {
      statusEl.textContent = '';
    }

    if (socketManager.isConnected) {
      footerEl.textContent = 'v2.0 · 原神杀 · 八人军争 · 已连接服务器';
    } else {
      footerEl.textContent = 'v2.0 · 原神杀 · 八人军争 · 连接中...';
    }
  }

  private showProfileMsg(msg: string, isError: boolean): void {
    const el = this.overlay?.querySelector('#profile-msg') as HTMLElement;
    if (el) {
      el.textContent = msg;
      el.style.color = isError ? 'var(--accent-red)' : 'var(--accent-green)';
    }
  }

  /** 裁剪图片为正方形（居中裁剪 + 缩放至128x128） */
  private cropToSquare(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const size = Math.min(img.width, img.height);
          const sx = (img.width - size) / 2;
          const sy = (img.height - size) / 2;

          const canvas = document.createElement('canvas');
          canvas.width = 128;
          canvas.height = 128;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(img, sx, sy, size, size, 0, 0, 128, 128);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.onerror = reject;
        img.src = reader.result as string;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
}
