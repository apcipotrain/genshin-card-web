export interface PublicRoomSlot {
  index: number;
  occupied: boolean;
  accountName: string | null;
  avatar: string | null;
  nickname: string | null;
  ready: boolean;
  isHost: boolean;
  connected: boolean;
  heroId?: string;
}

export interface PublicRoom {
  id: string;
  name: string;
  hasPassword: boolean;
  playerCount: number;
  maxSlots: number;
  aiFill: number;
  slots: PublicRoomSlot[];
}
