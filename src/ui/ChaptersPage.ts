import { router } from './router';
import { CHAPTERS, getChapterStars, getPVEStarRecords, isChapterUnlocked, type PVEChapter } from '../data/PVELevels';
import { socketManager } from '../network/SocketManager';
import { getHeroById } from '../data/heroes';
import { getPVEBackground, toCssImage } from './BackgroundAssets';

const CHAPTER_NUMBERS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

function getPlayerLevel(): number {
  const level = socketManager.account?.level;
  return typeof level === 'number' && level > 0 ? level : 1;
}

export class ChaptersPage {
  private el!: HTMLElement;
  private currentIndex = 0;
  private chapterButtons: HTMLButtonElement[] = [];
  private detailEl!: HTMLElement;
  private playerLevelEl!: HTMLElement;

  render(): HTMLElement {
    this.el = document.createElement('div');
    this.el.className = 'page chapters-page';
    this.el.innerHTML = `
      <header class="pve-header">
        <button class="pve-back" id="chapters-back" type="button">← 返回主页</button>
        <h1>PVE 闯关</h1>
        <span class="pve-player-level"></span>
      </header>
      <div class="pve-layout">
        <nav class="pve-regions" aria-label="章节地区">
          <h2>地区</h2>
          <div class="pve-region-list"></div>
        </nav>
        <div class="pve-detail"></div>
      </div>
    `;
    this.detailEl = this.el.querySelector('.pve-detail')!;
    this.playerLevelEl = this.el.querySelector('.pve-player-level')!;
    const chapterList = this.el.querySelector('.pve-region-list')!;
    this.chapterButtons = CHAPTERS.map((chapter, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pve-region';
      button.style.setProperty('--chapter-scene', toCssImage(getPVEBackground(chapter.id, chapter.region)));
      button.innerHTML = `
        <span class="pve-region-image" aria-hidden="true"></span>
        <span class="pve-region-text">
          <strong>${chapter.name}</strong>
          <span class="pve-region-status"></span>
        </span>
      `;
      button.addEventListener('click', () => this.selectChapter(index));
      button.addEventListener('keydown', event => this.navigateChapters(event, index));
      chapterList.appendChild(button);
      return button;
    });

    this.el.querySelector('#chapters-back')!.addEventListener('click', () => router.navigate('home'));
    this.detailEl.addEventListener('click', event => {
      if (!(event.target instanceof Element)) return;
      const levelButton = event.target.closest<HTMLButtonElement>('button[data-level-id]');
      if (!levelButton) return;
      const chapter = CHAPTERS[this.currentIndex];
      const levelId = Number(levelButton.dataset.levelId);
      if (!isChapterUnlocked(chapter, getPlayerLevel())) {
        this.refresh();
        return;
      }
      if (chapter.levels.some(level => level.id === levelId)) {
        router.navigate('game', { mode: 'pve', chapterId: chapter.id, levelId });
      }
    });

    this.refresh();
    return this.el;
  }

  private navigateChapters(event: KeyboardEvent, index: number): void {
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = Math.max(0, index - 1);
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = Math.min(CHAPTERS.length - 1, index + 1);
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = CHAPTERS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.selectChapter(nextIndex);
    this.chapterButtons[nextIndex].focus();
  }

  private selectChapter(index: number): void {
    if (index === this.currentIndex) return;
    this.currentIndex = index;
    this.refresh();
    this.detailEl.scrollTop = 0;
  }

  private refresh(): void {
    const playerLevel = getPlayerLevel();
    const records = getPVEStarRecords();
    const levelStars = (id: number) => Math.min(3, Math.max(0, Math.trunc(Number(records[id]) || 0)));
    this.playerLevelEl.textContent = `冒险等级 ${playerLevel}`;
    CHAPTERS.forEach((chapter, index) => {
      const button = this.chapterButtons[index];
      const isCurrent = index === this.currentIndex;
      if (isCurrent) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
      const unlocked = isChapterUnlocked(chapter, playerLevel);
      const stars = chapter.levels.reduce((sum, level) => sum + levelStars(level.id), 0);
      button.dataset.state = chapter.placeholder ? 'unavailable' : unlocked ? 'open' : 'locked';
      button.querySelector('.pve-region-status')!.textContent = chapter.placeholder
        ? '暂未开放'
        : unlocked ? `${stars} / ${chapter.levels.length * 3} 星` : '待解锁';
    });

    const chapter = CHAPTERS[this.currentIndex];
    const unlocked = isChapterUnlocked(chapter, playerLevel);
    const stars = chapter.levels.reduce((sum, level) => sum + levelStars(level.id), 0);
    const completed = chapter.levels.filter(level => levelStars(level.id) > 0).length;
    const maxStars = chapter.levels.length * 3;
    this.detailEl.style.setProperty('--chapter-scene', toCssImage(getPVEBackground(chapter.id, chapter.region)));
    this.detailEl.innerHTML = `
      <section class="pve-banner" aria-labelledby="pve-chapter-title">
        <div class="pve-banner-copy">
          <p class="pve-chapter-index">第${CHAPTER_NUMBERS[this.currentIndex] ?? this.currentIndex + 1}章</p>
          <h2 id="pve-chapter-title">${chapter.name}</h2>
          <p class="pve-chapter-desc">${chapter.desc}</p>
        </div>
        ${unlocked && maxStars ? `
          <div class="pve-progress">
            <div class="pve-progress-title">
              <span>章节星级</span>
              <strong>${stars}<small> / ${maxStars}</small></strong>
            </div>
            <progress aria-label="章节累计星级" max="${maxStars}" value="${stars}"></progress>
            <p>已通关 ${completed} / ${chapter.levels.length} 关</p>
          </div>
        ` : ''}
      </section>
      ${unlocked && chapter.levels.length ? `
        <section class="pve-missions" aria-labelledby="pve-missions-title">
          <h3 id="pve-missions-title">关卡</h3>
          <div class="pve-level-grid">
            ${chapter.levels.map((level, index) => {
              const enemies = level.enemyHeroes.map(getHeroById);
              const hero = enemies.find(enemy => enemy && level.name.includes(enemy.name)) ?? enemies[0];
              const stars = levelStars(level.id);
              return `
                <button class="pve-level-card" type="button" data-level-id="${level.id}">
                  <span class="pve-level-art" aria-hidden="true">
                    <span>${hero?.name.charAt(0) ?? '·'}</span>
                    ${hero ? `<img src="Resources/Characters/${hero.name}.png" alt="" loading="lazy" decoding="async">` : ''}
                  </span>
                  <span class="pve-level-copy">
                    <span class="pve-level-number">第 ${index + 1} 关</span>
                    <strong class="pve-level-name">${level.name}</strong>
                    <span class="pve-level-teams">我方 ${level.allyCount} 人 · 敌方 ${level.enemyCount} 人</span>
                  </span>
                  <span class="pve-level-footer">
                    <span class="pve-level-stars" role="img" aria-label="最高 ${stars} 星，共 3 星">
                      <span aria-hidden="true">${'★'.repeat(stars)}</span><span class="pve-unearned" aria-hidden="true">${'☆'.repeat(3 - stars)}</span>
                    </span>
                    <span class="pve-level-action">开始 <span aria-hidden="true">→</span></span>
                  </span>
                </button>
              `;
            }).join('')}
          </div>
        </section>
      ` : this.renderChapterAvailability(chapter, playerLevel, unlocked)}
    `;

    this.detailEl.querySelectorAll<HTMLImageElement>('.pve-level-art img').forEach(img => {
      img.addEventListener('error', () => { img.hidden = true; }, { once: true });
    });
  }

  private renderChapterAvailability(chapter: PVEChapter, playerLevel: number, unlocked: boolean): string {
    if (chapter.placeholder || unlocked) {
      return '<section class="pve-availability"><h3>该地区暂未开放</h3></section>';
    }
    const previous = CHAPTERS[this.currentIndex - 1];
    const previousStars = previous ? Number(getChapterStars(previous.id)) || 0 : 0;
    return `
      <section class="pve-availability">
        <h3>解锁条件</h3>
        <ul>
          <li>
            <span>冒险等级达到 ${chapter.requiredLevel} 级</span>
            <span class="pve-condition" data-met="${playerLevel >= chapter.requiredLevel}">当前 ${playerLevel} 级</span>
          </li>
          ${previous && chapter.id !== 'mondstadt' ? `
            <li>
              <span>${previous.name}累计获得 20 星</span>
              <span class="pve-condition" data-met="${previousStars >= 20}">当前 ${previousStars} 星</span>
            </li>
          ` : ''}
        </ul>
      </section>
    `;
  }

  show(): void {
    this.el.classList.add('active');
    this.refresh();
  }

  hide(): void {
    this.el.classList.remove('active');
  }
}
