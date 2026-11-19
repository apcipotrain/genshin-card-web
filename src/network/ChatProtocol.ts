export const CHAT_MAX_LENGTH = 200;
export const CHAT_HISTORY_LIMIT = 100;

export interface ChatMessage {
  id: string;
  clientId: string;
  roomId: string;
  sequence: number;
  senderId: string;
  senderName: string;
  text: string;
  sentAt: number;
}

export type ChatResult = { success: true; message: ChatMessage; duplicate?: boolean }
  | { success: false; reason: string };

export function normalizeChatText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').trim();
  return text.length > 0 && [...text].length <= CHAT_MAX_LENGTH ? text : null;
}
