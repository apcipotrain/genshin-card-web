import { socketManager } from '../network/SocketManager';
import { CHAT_HISTORY_LIMIT, CHAT_MAX_LENGTH, normalizeChatText, type ChatMessage } from '../network/ChatProtocol';

/** Chat owns its subscriptions and pending UI; it never touches game-rule state. */
export class ChatPanel {
  private messages: ChatMessage[] = [];
  private pending = new Map<string, { text: string; failed: boolean; sending: boolean }>();
  private unsubs: (() => void)[] = [];
  private active = true;
  private finished = false;
  private unread = 0;
  private list: HTMLElement;
  private input: HTMLTextAreaElement;
  private status: HTMLElement;
  private count: HTMLElement;
  private sendButton: HTMLButtonElement;
  private newButton: HTMLButtonElement;
  private selfId = socketManager.account?.id || 'local';

  constructor(private root: HTMLElement, private roomId: string, private online: boolean) {
    root.innerHTML = `<h4>旅伴频道 <span class="sidebar-caption">COMPANIONS · ${online ? '房间公开聊天' : '本局留言 · 仅自己可见'}</span></h4>
      <div class="chat-messages" role="log" aria-label="旅伴消息" aria-live="polite"></div>
      <button class="chat-unread" type="button" hidden></button>
      <div class="chat-quick"><button type="button">你好，旅行者！</button><button type="button">配合愉快！</button><button type="button">稍等一下～</button></div>
      <form class="chat-form"><textarea rows="2" maxlength="400" aria-label="聊天内容" placeholder="说点什么… Enter发送，Shift+Enter换行"></textarea>
      <div class="chat-compose-footer"><span class="chat-count">0/${CHAT_MAX_LENGTH}</span><button type="submit">发送</button></div></form>
      <div class="chat-status" role="status"></div>`;
    this.list = root.querySelector('.chat-messages')!;
    this.input = root.querySelector('textarea')!;
    this.status = root.querySelector('.chat-status')!;
    this.count = root.querySelector('.chat-count')!;
    this.sendButton = root.querySelector('[type=submit]')!;
    this.newButton = root.querySelector('.chat-unread')!;
    root.querySelector('form')!.addEventListener('submit', e => { e.preventDefault(); this.compose(); });
    // Do not let chat typing activate game shortcuts or IME Enter submit a message.
    this.input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); this.compose(); }
    });
    this.input.addEventListener('input', () => this.updateState());
    root.querySelectorAll<HTMLButtonElement>('.chat-quick button').forEach(button => {
      button.onclick = () => { this.input.value = button.textContent!; this.compose(); };
    });
    this.newButton.onclick = () => { this.list.scrollTop = this.list.scrollHeight; this.clearUnread(); };
    this.list.onscroll = () => { if (this.nearBottom()) this.clearUnread(); };
    if (online) {
      this.unsubs.push(socketManager.on('chat_message', message => this.receive(message)));
      this.unsubs.push(socketManager.on('game_start', () => { this.updateState(); void this.sync(); }));
      this.unsubs.push(socketManager.on('__disconnected', () => this.updateState('连接已断开，重连后可重试失败消息')));
      this.unsubs.push(socketManager.on('logged_in', () => { this.updateState(); void this.sync(); }));
      this.unsubs.push(socketManager.on('game_over', data => { if (data?.roomId === this.roomId) this.finish(); }));
      void this.sync();
    }
    this.render(true);
    this.updateState();
  }

  private nearBottom(): boolean { return this.list.scrollHeight - this.list.clientHeight - this.list.scrollTop < 48; }
  private clearUnread(): void { this.unread = 0; this.newButton.hidden = true; }

  private updateState(reason = ''): void {
    if (!this.active) return;
    const disabled = this.finished || (this.online && !socketManager.isConnected);
    this.input.disabled = disabled;
    this.sendButton.disabled = disabled || !normalizeChatText(this.input.value);
    this.count.textContent = `${[...this.input.value].length}/${CHAT_MAX_LENGTH}`;
    this.root.querySelectorAll<HTMLButtonElement>('.chat-quick button').forEach(b => b.disabled = disabled);
    this.status.textContent = reason || (this.finished ? '对局已结束，频道已关闭' : this.online ? '所有房间玩家可见 · 最近100条' : '本地记录，不会发送给AI或其他玩家');
  }

  private compose(): void {
    if (!this.active || this.finished) return;
    const text = normalizeChatText(this.input.value);
    if (!text) { this.updateState('请输入1～200字的消息'); return; }
    if (this.online && !socketManager.isConnected) { this.updateState('连接已断开，请重连后发送'); return; }
    if (this.pending.size >= 5) { this.updateState('请先重试或移除待确认消息'); return; }
    const clientId = crypto.randomUUID();
    this.input.value = '';
    this.updateState();
    if (!this.online) {
      this.receive({ id: clientId, clientId, roomId: this.roomId, sequence: this.messages.length ? this.messages.at(-1)!.sequence + 1 : 1,
        senderId: this.selfId, senderName: socketManager.account?.nickname || socketManager.account?.name || '旅行者', text, sentAt: Date.now() });
      this.render(true);
      return;
    }
    this.pending.set(clientId, { text, failed: false, sending: false });
    void this.send(clientId);
  }

  private async send(clientId: string): Promise<void> {
    const pending = this.pending.get(clientId);
    if (!pending || pending.sending || !this.active || this.finished) return;
    pending.sending = true;
    pending.failed = false;
    this.render(true);
    const result = await socketManager.requestChat('chat_send', { roomId: this.roomId, clientId, text: pending.text });
    if (!this.active || this.finished) return;
    // Broadcast can arrive before the acknowledgment. Do not resurrect a confirmed row.
    if (result?.success) { this.receive(result.message); this.updateState(); }
    else if (this.pending.has(clientId)) {
      pending.sending = false;
      pending.failed = true;
      this.updateState(result?.reason || '发送失败，请重试');
      this.render();
    }
  }

  private async sync(): Promise<void> {
    if (!this.active || this.finished) return;
    const result = await socketManager.requestChat('chat_history', { roomId: this.roomId });
    if (!this.active || this.finished) return;
    if (result?.success && result.roomId === this.roomId && Array.isArray(result.messages)) {
      for (const message of result.messages) this.receive(message, true);
      this.render();
    } else this.updateState(result?.reason || '历史记录暂不可用');
  }

  private receive(message: ChatMessage, history = false): void {
    if (!this.active || message?.roomId !== this.roomId || typeof message.text !== 'string') return;
    const atBottom = this.nearBottom();
    if (message.senderId === this.selfId) this.pending.delete(message.clientId);
    if (this.messages.some(m => m.id === message.id)) { this.render(); return; }
    this.messages.push(message);
    this.messages.sort((a, b) => a.sequence - b.sequence);
    this.messages = this.messages.slice(-CHAT_HISTORY_LIMIT);
    if (!history && !atBottom && message.senderId !== this.selfId) {
      this.unread++;
      this.newButton.textContent = `${this.unread}条新消息 ↓`;
      this.newButton.hidden = false;
    }
    this.render(atBottom);
  }

  private render(scroll = false): void {
    const top = this.list.scrollTop;
    this.list.replaceChildren();
    if (!this.messages.length && !this.pending.size) {
      const empty = document.createElement('p');
      empty.className = 'chat-empty'; empty.textContent = '相逢即是旅伴，打个招呼吧。'; this.list.append(empty);
    }
    for (const message of this.messages) {
      const row = document.createElement('article');
      row.className = `chat-message${message.senderId === this.selfId ? ' own' : ''}`;
      const meta = document.createElement('div'); meta.className = 'chat-meta';
      const name = document.createElement('strong'); name.textContent = message.senderName + (message.senderId === this.selfId ? '（你）' : '');
      const time = document.createElement('time'); time.textContent = new Date(message.sentAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      meta.append(name, time);
      const body = document.createElement('p'); body.textContent = message.text;
      row.append(meta, body); this.list.append(row);
    }
    for (const [id, pending] of this.pending) {
      const row = document.createElement('article'); row.className = 'chat-message own pending';
      const body = document.createElement('p'); body.textContent = pending.text;
      const label = document.createElement('span'); label.textContent = pending.failed ? '发送失败 ' : '发送中…';
      row.append(body, label);
      if (pending.failed && !this.finished) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试'; retry.onclick = () => void this.send(id);
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除'; remove.onclick = () => { this.pending.delete(id); this.render(); };
        row.append(retry, remove);
      }
      this.list.append(row);
    }
    this.list.scrollTop = scroll ? this.list.scrollHeight : top;
  }

  finish(): void { this.finished = true; this.updateState(); this.render(); }
  dispose(): void {
    this.active = false;
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.pending.clear();
    this.root.replaceChildren();
  }
}
