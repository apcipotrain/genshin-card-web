// ============================================================
// ChaptersPage.ts — PVE 闯关选择页面（使用动态关卡数据）
// ============================================================

import { router } from './router';
import { CHAPTERS, getPVEStarRecords, getChapterStars, isChapterUnlocked, getLevelById, PVEChapter } from '../data/PVELevels';
import { socketManager } from '../network/SocketManager';
import { getHeroById } from '../data/heroes';

const DIFFICULTY_COLORS: Record<string, string> = {
  '简单': '#4caf50', '普通': '#ff9800', '困难': '#f44336', '极难': '#9c27b0',
};

/** 获取当前玩家等级（优先从服务器账号，否则从本地存储） */
function getPlayerLevel(): number {
  if (socketManager.account?.level) return socketManager.account.level;
  try {
    const raw = localStorage.getItem('genshin_card_local_exp');
    if (raw) return JSON.parse(raw).level || 1;
  } catch { }
  return 1;
}

export class ChaptersPage {
  private el!: HTMLElement;
  private currentIndex = 0;
  private trackEl!: HTMLElement;
  private dotsEl!: HTMLElement;

  render(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'page chapters-page';
    container.innerHTML = `
      <button class="btn btn-ghost back-btn" id="chapters-back">← 返回主页</button>
      <div class="chapter-scroll" id="chapter-scroll">
        <div class="chapter-track" id="chapter-track"></div>
        <button class="scroll-arrow left" id="arrow-left">◀</button>
        <button class="scroll-arrow right" id="arrow-right">▶</button>
      </div>
      <div class="chapter-dots" id="chapter-dots"></div>
    `;
    this.trackEl = container.querySelector('#chapter-track')!;
    this.dotsEl = container.querySelector('#chapter-dots')!;

    const playerLv = getPlayerLevel();
    CHAPTERS.forEach((ch, i) => {
      const card = document.createElement('div');
      card.className = `chapter-card chapter-${ch.cssClass}`;
      const unlocked = isChapterUnlocked(ch, playerLv);
      const starsRecord = getPVEStarRecords();
      const totalStars = ch.levels.reduce((s, l) => s + (starsRecord[l.id] || 0), 0);
      const hasContent = ch.levels.length > 0;

      let statusHtml = '';
      if (ch.placeholder) {
        statusHtml = '<div class="chapter-status locked-status">🚧 该地图暂未制作</div>';
      } else if (!unlocked) {
        const prevIdx = CHAPTERS.findIndex(c => c.id === ch.id) - 1;
        const prevChapter = prevIdx >= 0 ? CHAPTERS[prevIdx] : null;
        if (playerLv < ch.requiredLevel) {
          statusHtml = `<div class="chapter-status locked-status">🔒 需要等级 ${ch.requiredLevel} 解锁</div>`;
        } else if (prevChapter) {
          const prevStars = getChapterStars(prevChapter.id);
          statusHtml = `<div class="chapter-status locked-status">🔒 需${prevChapter.name}累计${prevStars}/20星</div>`;
        } else {
          statusHtml = '<div class="chapter-status locked-status">🔒 未解锁</div>';
        }
      } else if (hasContent) {
        const maxStars = ch.levels.length * 3;
        statusHtml = `<div class="chapter-status">⭐ ${totalStars}/${maxStars} 星 · 已开放</div>`;
      }

      card.innerHTML = `
        <div class="chapter-content">
          <div class="chapter-number">第${this.toChineseNum(i + 1)}章</div>
          <div class="chapter-name">${ch.name}</div>
          <div class="chapter-name-en">${ch.nameEn}</div>
          <div class="chapter-desc">${ch.desc}</div>
          <div class="chapter-progress">${hasContent ? `共${ch.levels.length}关` : '暂无关卡'}</div>
          ${statusHtml}
          <div class="chapter-hint">点击进入关卡 →</div>
        </div>
      `;
      card.addEventListener('click', () => this.openLevels(ch, playerLv));
      this.trackEl.appendChild(card);

      const dot = document.createElement('div');
      dot.className = `chapter-dot${i === 0 ? ' active' : ''}`;
      dot.addEventListener('click', () => this.scrollTo(i));
      this.dotsEl.appendChild(dot);
    });

    container.querySelector('#chapters-back')!.addEventListener('click', () => router.navigate('home'));
    container.querySelector('#arrow-left')!.addEventListener('click', () => this.scrollPrev());
    container.querySelector('#arrow-right')!.addEventListener('click', () => this.scrollNext());

    let touchStartX = 0;
    const scrollArea = container.querySelector('#chapter-scroll')!;
    scrollArea.addEventListener('touchstart', e => { touchStartX = (e as TouchEvent).touches[0].clientX; });
    scrollArea.addEventListener('touchend', e => {
      const dx = (e as TouchEvent).changedTouches[0].clientX - touchStartX;
      if (dx > 50) this.scrollPrev(); else if (dx < -50) this.scrollNext();
    });

    this.el = container;
    return container;
  }

  private scrollTo(index: number): void {
    if (index < 0 || index >= CHAPTERS.length) return;
    this.currentIndex = index;
    this.trackEl.style.transform = `translateX(-${index * 100}vw)`;
    this.dotsEl.querySelectorAll('.chapter-dot').forEach((d, i) => d.classList.toggle('active', i === index));
  }
  private scrollPrev(): void { this.scrollTo(this.currentIndex - 1); }
  private scrollNext(): void { this.scrollTo(this.currentIndex + 1); }

  private openLevels(chapter: PVEChapter, playerLv: number): void {
    const unlocked = isChapterUnlocked(chapter, playerLv);
    if (!unlocked) {
      if (chapter.placeholder) {
        alert('🚧 该地图暂未制作，敬请期待！');
      } else {
        alert('🔒 等级 / 星级未满足解锁地图的需求。');
      }
      return;
    }
    if (chapter.levels.length === 0) {
      alert('该章节暂无关卡数据。');
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay level-modal';
    const starsRecord = getPVEStarRecords();
    const totalAvailableStars = chapter.levels.length * 3;
    const currentStars = getChapterStars(chapter.id);

    overlay.innerHTML = `
      <div class="modal-box level-modal-box">
        <h2>${chapter.name} · 关卡选择</h2>
        <p style="text-align:center;color:var(--text-secondary);">⭐ 累计 ${currentStars}/${totalAvailableStars} 星</p>
        <div class="level-list">
          ${chapter.levels.map((lv, idx) => {
            const stars = starsRecord[lv.id] || 0;
            const starStr = '⭐'.repeat(stars) + '☆'.repeat(3 - stars);
            return `
              <div class="level-item" data-level="${lv.id}" data-chapter="${chapter.id}">
                <div class="level-left">
                  <div class="level-num">第${idx + 1}关</div>
                  <div class="level-name">${lv.name}</div>
                </div>
                <div class="level-right">
                  <div class="level-stars">${starStr}</div>
                  <span class="level-go">进入 ▶</span>
                </div>
              </div>
            `;
          }).join('')}
        </div>
        <div style="text-align:center;margin-top:16px;">
          <button class="btn btn-ghost" id="level-close">关闭</button>
        </div>
      </div>
    `;

    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#level-close')!.addEventListener('click', () => overlay.remove());
    overlay.querySelectorAll('.level-item').forEach(item => {
      item.addEventListener('click', () => {
        const el = item as HTMLElement;
        const levelId = el.dataset.level!;
        const chapterId = el.dataset.chapter!;
        overlay.remove();
        router.navigate('game', { mode: 'pve', chapterId, levelId: parseInt(levelId) });
      });
    });

    document.body.appendChild(overlay);
  }

  private toChineseNum(n: number): string {
    const map = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    return map[n] || String(n);
  }

  show(): void { this.el.classList.add('active'); }
  hide(): void { this.el.classList.remove('active'); }
}
