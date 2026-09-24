import { randomBytes, randomUUID } from "node:crypto";

export type RoomMode = "harness";
export type HarnessKind = "pi";
export type RoomState = "ready" | "closed";
export type AdapterTurn = { turnId: string; message: string; cwd?: string; harness: HarnessKind };

type QueuedTurn = AdapterTurn & { delivered: boolean };
export type MeldivoRoom = {
  id: string;
  token: string;
  mode: RoomMode;
  harness: HarnessKind;
  cwd?: string;
  label?: string;
  state: RoomState;
  createdAt: number;
  updatedAt: number;
  queuedTurns: QueuedTurn[];
};

export type PublicRoom = {
  id: string;
  mode: RoomMode;
  harness: HarnessKind;
  cwd?: string;
  label?: string;
  state: RoomState;
  createdAt: string;
};

// A room is a single Pi session's voice capability: one bearer token grants
// access to its chat turns and adapter queue. Rooms are pruned after
// `roomTtlMs` of inactivity so a crashed or forgotten Pi session does not
// linger forever.
export class MeldivoHub {
  private readonly rooms = new Map<string, MeldivoRoom>();

  constructor(private readonly roomTtlMs: number) {}

  create(input: { harness: HarnessKind; cwd?: string; label?: string }): { room: PublicRoom; token: string } {
    this.prune();
    const now = Date.now();
    const room: MeldivoRoom = {
      id: randomUUID(),
      token: randomBytes(32).toString("base64url"),
      mode: "harness",
      harness: input.harness,
      cwd: input.cwd,
      label: input.label,
      state: "ready",
      createdAt: now,
      updatedAt: now,
      queuedTurns: [],
    };
    this.rooms.set(room.id, room);
    return { room: publicRoom(room), token: room.token };
  }

  authorize(roomId: string | undefined, token: string | undefined): MeldivoRoom | undefined {
    this.prune();
    if (!roomId || !token) return undefined;
    const room = this.rooms.get(roomId);
    if (!room || room.state !== "ready" || !timingSafeEqual(room.token, token)) return undefined;
    room.updatedAt = Date.now();
    return room;
  }

  // A trusted (bootstrap-secret-authenticated) caller may look up a room by id
  // alone, without presenting its capability token.
  get(roomId: string): MeldivoRoom | undefined {
    this.prune();
    const room = this.rooms.get(roomId);
    return room && room.state === "ready" ? room : undefined;
  }

  // Voice endpoints are not scoped to one room in their URL, so this checks
  // whether a token belongs to any currently open room.
  authorizeToken(token: string | undefined): MeldivoRoom | undefined {
    this.prune();
    if (!token) return undefined;
    for (const room of this.rooms.values()) {
      if (room.state === "ready" && timingSafeEqual(room.token, token)) return room;
    }
    return undefined;
  }

  public(room: MeldivoRoom): PublicRoom {
    return publicRoom(room);
  }

  size(): number {
    this.prune();
    return this.rooms.size;
  }

  close(room: MeldivoRoom): void {
    room.state = "closed";
    room.queuedTurns = [];
    room.updatedAt = Date.now();
    this.rooms.delete(room.id);
  }

  enqueueTurn(room: MeldivoRoom, message: string): AdapterTurn {
    const turn: QueuedTurn = { turnId: randomUUID(), message, cwd: room.cwd, harness: room.harness, delivered: false };
    room.queuedTurns.push(turn);
    room.updatedAt = Date.now();
    return turn;
  }

  nextTurn(room: MeldivoRoom): AdapterTurn | undefined {
    const turn = room.queuedTurns.find((item) => !item.delivered);
    if (!turn) return undefined;
    turn.delivered = true;
    room.updatedAt = Date.now();
    return { turnId: turn.turnId, message: turn.message, cwd: turn.cwd, harness: turn.harness };
  }

  removeTurn(room: MeldivoRoom, turnId: string): void {
    room.queuedTurns = room.queuedTurns.filter((turn) => turn.turnId !== turnId);
    room.updatedAt = Date.now();
  }

  removeTurnById(roomId: string, turnId: string): void {
    const room = this.rooms.get(roomId);
    if (room) this.removeTurn(room, turnId);
  }

  private prune(): void {
    if (this.roomTtlMs <= 0) return;
    const threshold = Date.now() - this.roomTtlMs;
    for (const [id, room] of this.rooms) {
      if (room.updatedAt < threshold) this.rooms.delete(id);
    }
  }
}

function publicRoom(room: MeldivoRoom): PublicRoom {
  return {
    id: room.id,
    mode: room.mode,
    harness: room.harness,
    ...(room.cwd ? { cwd: room.cwd } : {}),
    ...(room.label ? { label: room.label } : {}),
    state: room.state,
    createdAt: new Date(room.createdAt).toISOString(),
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  // Tokens are fixed-size values when created by this hub. Avoid an early-return
  // comparison so a room URL cannot be guessed by timing requests.
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index++) result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return result === 0;
}
