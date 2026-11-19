import { GameSession } from '../core/GameSession';

export type BattleActionKind = 'play' | 'discard' | 'response' | 'reveal';

export interface BattleActor {
  name: string;
  imageSrc?: string;
  element?: string;
}

export interface BattleCardAction {
  kind: BattleActionKind;
  playerId: number;
  cardName: string;
  imageSrc: string;
  suit?: string;
  number?: number;
}

interface PresentedCard {
  element: HTMLElement;
  timers: Set<ReturnType<typeof setTimeout>>;
  animations: Set<Animation>;
}

interface PresentedSkill extends PresentedCard {
  playerId: number;
  skillName: string;
  count: number;
  lastTriggeredAt: number;
  countElement: HTMLElement;
}

const ACTION_LABEL: Record<BattleActionKind, string> = {
  play: '出牌', discard: '弃牌', response: '响应', reveal: '展示',
};
const SUITS: Record<string, string> = { Spade: '♠', Heart: '♥', Club: '♣', Diamond: '♦' };
const RANKS: Record<number, string> = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
const ELEMENT_COLOR: Record<string, string> = {
  风: '#7ed6bf', 岩: '#e7c277', 雷: '#c4a3ef', 草: '#b5d77e',
  水: '#89c9ee', 火: '#f0a185', 冰: '#a4dfeb',
};

/** A bounded display of public actions. It never advances or delays game rules. */
export class BattlePresentation {
  private readonly overlay: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly caption: HTMLElement;
  private readonly cardTrack: HTMLElement;
  private readonly skillTrack: HTMLElement;
  private readonly cards: PresentedCard[] = [];
  private readonly skills: PresentedSkill[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly resizeObserver: ResizeObserver | null;
  private readonly releaseSession: () => void;
  private disposed = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly battlefield: HTMLElement,
    private readonly session: GameSession,
    private readonly getActor: (playerId: number) => BattleActor | undefined,
    private readonly getSeat: (playerId: number) => HTMLElement | null,
  ) {
    this.overlay = this.node('div', 'battle-presentation');
    this.overlay.dataset.compact = 'false';
    this.stage = this.node('section', 'battle-action-stage');
    this.stage.dataset.empty = 'true';
    this.stage.setAttribute('role', 'log');
    this.stage.setAttribute('aria-live', 'polite');
    this.stage.setAttribute('aria-label', '对局动作记录');

    const header = this.node('div', 'battle-stage-header');
    header.append(this.node('span', 'battle-stage-eyebrow', 'BATTLE ACTIONS'));
    this.caption = this.node('span', 'battle-stage-caption', '牌局进行中');
    header.append(this.caption);
    this.cardTrack = this.node('div', 'battle-card-track');
    const empty = this.node('div', 'battle-stage-empty');
    empty.append(this.node('span', 'battle-stage-empty-mark', '✧'), this.node('span', '', '等待下一次行动'));
    this.stage.append(header, empty, this.cardTrack);

    this.skillTrack = this.node('div', 'battle-skill-track');
    this.skillTrack.setAttribute('role', 'status');
    this.skillTrack.setAttribute('aria-live', 'polite');
    this.skillTrack.setAttribute('aria-label', '技能发动提示');
    this.overlay.append(this.stage, this.skillTrack);
    this.root.append(this.overlay);

    this.resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(this.position);
    this.resizeObserver?.observe(this.root);
    this.resizeObserver?.observe(this.battlefield);
    window.addEventListener('resize', this.position);
    window.addEventListener('scroll', this.position, true);
    this.motion.addEventListener('change', this.onMotionChange);
    this.releaseSession = this.session.onDispose(() => this.dispose());
    this.position();
  }

  card(action: BattleCardAction): void {
    if (!this.active || !action.cardName) return;
    this.position();
    const actor = this.getActor(action.playerId);
    const actorName = actor?.name || (action.kind === 'discard' ? '弃牌区' : '公共牌区');
    const label = ACTION_LABEL[action.kind];
    const element = this.node('article', 'battle-action-card');
    element.dataset.kind = action.kind;
    element.setAttribute('aria-label', `${actorName}${label}：${action.cardName}`);

    const face = this.node('div', 'battle-card-face');
    const image = this.node('img', 'battle-card-art') as HTMLImageElement;
    image.src = action.imageSrc;
    image.alt = '';
    image.draggable = false;
    image.addEventListener('error', () => {
      image.hidden = true;
      face.classList.add('has-art-fallback');
    }, { once: true });
    const fallback = this.node('span', 'battle-card-art-fallback', action.cardName);
    fallback.setAttribute('aria-hidden', 'true');
    const corner = this.node('span', 'battle-card-suit');
    corner.dataset.red = String(action.suit === 'Heart' || action.suit === 'Diamond');
    const rank = action.number ? (RANKS[action.number] || String(action.number)) : '';
    corner.append(this.node('span', '', SUITS[action.suit || ''] || ''), this.node('span', '', rank));
    corner.hidden = !rank && !SUITS[action.suit || ''];
    face.append(image, fallback, corner, this.node('span', 'battle-card-kind', label));

    const caption = this.node('div', 'battle-card-caption');
    caption.append(this.node('span', 'battle-card-actor', actorName), this.node('strong', 'battle-card-name', action.cardName));
    element.append(face, caption);
    const entry: PresentedCard = { element, timers: new Set(), animations: new Set() };
    this.cards.push(entry);
    while (this.cards.length > 3) this.removeCard(this.cards[0]);
    this.cardTrack.append(element);
    this.updateCards();
    this.caption.textContent = `${actorName} · ${label}`;

    const source = this.getSeat(action.playerId)?.getBoundingClientRect();
    const destination = element.getBoundingClientRect();
    if (!this.motion.matches && source?.width && destination.width) {
      const dx = source.left + source.width / 2 - destination.left - destination.width / 2;
      const dy = source.top + source.height / 2 - destination.top - destination.height / 2;
      const tilt = dx < 0 ? -11 : 11;
      this.animate(entry, [
        { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(.36) rotate(${tilt}deg)` },
        { opacity: 1, transform: 'translate(0, -5px) scale(1.03) rotate(0deg)', offset: .8 },
        { opacity: 1, transform: 'none' },
      ], 380);
    }
    this.schedule(entry, () => this.leave(entry, () => this.removeCard(entry)), 4700);
  }

  skill(playerId: number, skillName: string): void {
    if (!this.active || !skillName) return;
    this.position();
    const now = Date.now();
    const repeated = this.skills.find(entry => entry.playerId === playerId && entry.skillName === skillName && now - entry.lastTriggeredAt < 2000);
    if (repeated) {
      repeated.count++;
      repeated.lastTriggeredAt = now;
      repeated.countElement.textContent = `×${repeated.count}`;
      repeated.countElement.hidden = false;
      repeated.element.classList.remove('is-leaving');
      this.cancelTimers(repeated);
      this.cancelAnimations(repeated);
      this.schedule(repeated, () => this.leave(repeated, () => this.removeSkill(repeated)), 2700);
      return;
    }

    const actor = this.getActor(playerId);
    const element = this.node('div', 'battle-skill-banner');
    element.dataset.element = actor?.element || '';
    element.style.setProperty('--skill-accent', ELEMENT_COLOR[actor?.element || ''] || '#e7c277');
    if (actor?.imageSrc) {
      const portrait = this.node('img', 'battle-skill-portrait') as HTMLImageElement;
      portrait.src = actor.imageSrc;
      portrait.alt = '';
      portrait.addEventListener('error', () => { portrait.hidden = true; }, { once: true });
      element.append(portrait);
    }
    const meta = this.node('div', 'battle-skill-meta');
    meta.append(this.node('span', 'battle-skill-owner', actor?.name || '玩家'), this.node('strong', 'battle-skill-name', skillName));
    const type = this.node('span', 'battle-skill-type', '技能发动');
    const countElement = this.node('span', 'battle-skill-count');
    countElement.hidden = true;
    element.append(meta, type, countElement);
    const entry: PresentedSkill = {
      element, playerId, skillName, count: 1, lastTriggeredAt: now, countElement,
      timers: new Set(), animations: new Set(),
    };
    this.skills.push(entry);
    while (this.skills.length > 2) this.removeSkill(this.skills[0]);
    this.skillTrack.append(element);
    this.animate(entry, [{ opacity: 0, transform: 'translateY(8px) scale(.97)' }, { opacity: 1, transform: 'none' }], 220);
    this.schedule(entry, () => this.leave(entry, () => this.removeSkill(entry)), 2700);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.position);
    window.removeEventListener('scroll', this.position, true);
    this.motion.removeEventListener('change', this.onMotionChange);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const entry of [...this.cards, ...this.skills]) this.cancelAnimations(entry);
    this.cards.length = 0;
    this.skills.length = 0;
    this.overlay.remove();
    this.releaseSession?.();
  }

  private get active(): boolean { return !this.disposed && this.session.active; }

  private node(tag: string, className: string, text?: string): HTMLElement {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  private position = (): void => {
    if (!this.active) return;
    const bounds = this.battlefield.getBoundingClientRect();
    const root = this.root.getBoundingClientRect();
    this.overlay.hidden = bounds.width === 0 || bounds.height === 0;
    if (this.overlay.hidden) return;
    const width = Math.max(120, Math.min(560, bounds.width - 360));
    const left = bounds.left - root.left + bounds.width / 2;
    const row = this.battlefield.querySelector('#top-row')?.getBoundingClientRect();
    const hand = this.root.querySelector('.player-zone')?.getBoundingClientRect();
    const gapTop = row ? row.bottom - root.top + 8 : bounds.top - root.top + bounds.height * .4;
    const gapBottom = hand ? hand.top - root.top - 8 : bounds.bottom - root.top - 30;
    const short = gapBottom - gapTop < 300;
    const top = (gapTop + gapBottom) / 2 - (short ? 0 : 32);
    this.overlay.dataset.short = String(short);
    this.overlay.dataset.compact = String(width < 380);
    this.stage.style.left = `${left}px`;
    this.stage.style.top = `${top}px`;
    this.stage.style.setProperty('--battle-stage-width', `${width}px`);
    this.skillTrack.style.left = `${short ? left + width * .3 : left}px`;
    this.skillTrack.style.top = `${short ? top - 42 : top + 145}px`;
    this.skillTrack.style.setProperty('--battle-stage-width', `${short ? width * .36 : width}px`);
  };

  private onMotionChange = (): void => {
    if (!this.motion.matches) return;
    for (const entry of [...this.cards, ...this.skills]) this.cancelAnimations(entry);
  };

  private updateCards(): void {
    this.stage.dataset.empty = String(this.cards.length === 0);
    this.cards.forEach((entry, index) => { entry.element.dataset.latest = String(index === this.cards.length - 1); });
    if (!this.cards.length) this.caption.textContent = '牌局进行中';
  }

  private schedule(entry: PresentedCard, callback: () => void, delay: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      entry.timers.delete(timer);
      if (this.active) callback();
    }, delay);
    this.timers.add(timer);
    entry.timers.add(timer);
  }

  private cancelTimers(entry: PresentedCard): void {
    for (const timer of entry.timers) {
      clearTimeout(timer);
      this.timers.delete(timer);
    }
    entry.timers.clear();
  }

  private animate(entry: PresentedCard, frames: Keyframe[], duration: number): void {
    if (this.motion.matches || typeof entry.element.animate !== 'function') return;
    const animation = entry.element.animate(frames, { duration, easing: 'cubic-bezier(.2,.75,.25,1)' });
    entry.animations.add(animation);
    animation.addEventListener('finish', () => entry.animations.delete(animation), { once: true });
    animation.addEventListener('cancel', () => entry.animations.delete(animation), { once: true });
  }

  private cancelAnimations(entry: PresentedCard): void {
    for (const animation of entry.animations) animation.cancel();
    entry.animations.clear();
  }

  private leave(entry: PresentedCard, remove: () => void): void {
    if (this.motion.matches) { remove(); return; }
    entry.element.classList.add('is-leaving');
    this.schedule(entry, remove, 220);
  }

  private removeCard(entry: PresentedCard): void {
    this.cancelTimers(entry);
    this.cancelAnimations(entry);
    entry.element.remove();
    const index = this.cards.indexOf(entry);
    if (index >= 0) this.cards.splice(index, 1);
    this.updateCards();
  }

  private removeSkill(entry: PresentedSkill): void {
    this.cancelTimers(entry);
    this.cancelAnimations(entry);
    entry.element.remove();
    const index = this.skills.indexOf(entry);
    if (index >= 0) this.skills.splice(index, 1);
  }
}
