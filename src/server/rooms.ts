import { COLOR_ORDER, DEFAULT_COLORS, FORFEIT_SECONDS, MAX_NAME, PALETTE, TICK, WEAPONS, type ColorId, type WeaponId } from "../shared/constants.ts";
import { Game } from "../shared/game.ts";
import type { ClientMsg, GameInput, LobbyPlayer, Seat, ServerMsg } from "../shared/protocol.ts";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const MAX_ROOMS = 2000;
const IDLE_ROOM_SECONDS = 600;

type Send = (m: ServerMsg) => void;

interface Conn {
  id: number;
  send: Send;
  room?: string;
  seat?: Seat;
}

interface SeatState {
  name: string;
  token: string;
  ready: boolean;
  color: ColorId;
  conn: number | null;
  awaySeconds: number;
}

export interface Room {
  code: string;
  seats: [SeatState | null, SeatState | null];
  /** the current match, or the last finished one while back in the lobby */
  game: Game | null;
  playing: boolean;
  wins: [number, number];
  idleSeconds: number;
  carry: number;
}

const DEFAULT_NAMES = ["Player One", "Player Two"];

function cleanName(raw: unknown, seat: Seat): string {
  const s = typeof raw === "string" ? raw.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, MAX_NAME) : "";
  return s || DEFAULT_NAMES[seat];
}

function parseInput(m: Record<string, unknown>): GameInput | null {
  switch (m.t) {
    case "move":
      return m.dir === -1 || m.dir === 0 || m.dir === 1 ? { t: "move", dir: m.dir } : null;
    case "jump":
    case "skip":
      return { t: m.t };
    case "aim":
      return typeof m.angle === "number" && Number.isFinite(m.angle) ? { t: "aim", angle: m.angle } : null;
    case "fire":
      return typeof m.power === "number" && Number.isFinite(m.power) ? { t: "fire", power: m.power } : null;
    case "weapon":
      return typeof m.id === "string" && m.id in WEAPONS ? { t: "weapon", id: m.id as WeaponId } : null;
    default:
      return null;
  }
}

/** Transport-independent room and lobby logic; the WebSocket server wires `send` and calls `tick`. */
export class Rooms {
  private rooms = new Map<string, Room>();
  private conns = new Map<number, Conn>();
  private nextConn = 1;

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  get size(): number {
    return this.rooms.size;
  }

  connect(send: Send): number {
    const id = this.nextConn++;
    this.conns.set(id, { id, send });
    return id;
  }

  message(connId: number, raw: string): void {
    const conn = this.conns.get(connId);
    if (!conn || raw.length > 2000) return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    const msg = m as ClientMsg;
    switch (msg.t) {
      case "create":
        return this.create(conn, msg.name, msg.token);
      case "join":
        return this.join(conn, String(msg.code ?? "").toUpperCase(), msg.name, msg.token);
      case "ready":
        return this.setReady(conn, msg.ready === true);
      case "color":
        return this.setColor(conn, msg.color);
      case "leave":
        return this.detach(conn, true);
    }
    const input = parseInput(m);
    if (!input || conn.room === undefined || conn.seat === undefined) return;
    this.rooms.get(conn.room)?.game?.handle(conn.seat, input);
  }

  close(connId: number): void {
    const conn = this.conns.get(connId);
    if (!conn) return;
    this.detach(conn, false);
    this.conns.delete(connId);
  }

  tick(dt: number): void {
    for (const room of this.rooms.values()) {
      const connected = room.seats.some((s) => s && s.conn !== null);
      room.idleSeconds = connected ? 0 : room.idleSeconds + dt;
      if (room.idleSeconds > IDLE_ROOM_SECONDS) {
        this.rooms.delete(room.code);
        continue;
      }
      const g = room.game;
      if (!g || !room.playing) continue;
      room.seats.forEach((s, i) => {
        if (!s || s.conn !== null) return;
        s.awaySeconds += dt;
        if (s.awaySeconds > FORFEIT_SECONDS) g.forfeit(i as Seat);
      });
      room.carry += dt;
      while (room.carry >= TICK - 1e-9) {
        g.step();
        room.carry -= TICK;
      }
      const events = g.drainEvents();
      if (events.length) this.broadcast(room, { t: "events", list: events });
      this.broadcast(room, { t: "state", s: g.snapshot() });
      if (g.winner !== null) this.finish(room);
    }
  }

  // ---------- lobby ----------

  private newCode(): string {
    for (;;) {
      let c = "";
      for (let i = 0; i < 4; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      if (!this.rooms.has(c)) return c;
    }
  }

  private create(conn: Conn, name: unknown, _token: unknown): void {
    if (this.rooms.size >= MAX_ROOMS) return conn.send({ t: "error", reason: "full" });
    this.detach(conn, true);
    const code = this.newCode();
    const room: Room = { code, seats: [null, null], game: null, playing: false, wins: [0, 0], idleSeconds: 0, carry: 0 };
    this.rooms.set(code, room);
    this.seat(conn, room, 0, cleanName(name, 0));
  }

  private join(conn: Conn, code: string, name: unknown, token: unknown): void {
    const room = this.rooms.get(code);
    if (!room) return conn.send({ t: "error", reason: "not-found" });
    // reclaim by token
    const idx = room.seats.findIndex((s) => s && typeof token === "string" && s.token === token);
    if (idx >= 0) {
      const s = room.seats[idx]!;
      if (s.conn !== null && s.conn !== conn.id) {
        const old = this.conns.get(s.conn);
        if (old) {
          old.room = undefined;
          old.seat = undefined;
        }
      }
      if (conn.room !== code || conn.seat !== idx) this.detach(conn, true);
      s.conn = conn.id;
      s.awaySeconds = 0;
      conn.room = code;
      conn.seat = idx as Seat;
      conn.send({ t: "joined", code, seat: idx as Seat, token: s.token });
      if (room.playing && room.game) {
        this.sendStart(room, conn, idx as Seat);
        room.game.paused = room.seats.some((x) => x && x.conn === null);
      }
      this.broadcastLobby(room);
      return;
    }
    const free = room.seats.findIndex((s) => s === null);
    if (free < 0) return conn.send({ t: "error", reason: "full" });
    this.detach(conn, true);
    this.seat(conn, room, free as Seat, cleanName(name, free as Seat));
  }

  private seat(conn: Conn, room: Room, seat: Seat, name: string): void {
    const token = crypto.randomUUID();
    const taken = room.seats[1 - seat]?.color;
    const color = DEFAULT_COLORS[seat] !== taken ? DEFAULT_COLORS[seat] : COLOR_ORDER.find((c) => c !== taken)!;
    room.seats[seat] = { name, token, ready: false, color, conn: conn.id, awaySeconds: 0 };
    conn.room = room.code;
    conn.seat = seat;
    conn.send({ t: "joined", code: room.code, seat, token });
    this.broadcastLobby(room);
  }

  private setReady(conn: Conn, ready: boolean): void {
    if (conn.room === undefined || conn.seat === undefined) return;
    const room = this.rooms.get(conn.room);
    if (!room || room.playing) return;
    room.seats[conn.seat]!.ready = ready;
    this.broadcastLobby(room);
    if (room.seats.every((s) => s && s.ready && s.conn !== null)) this.start(room);
  }

  private setColor(conn: Conn, color: unknown): void {
    if (conn.room === undefined || conn.seat === undefined) return;
    const room = this.rooms.get(conn.room);
    if (!room || room.playing || typeof color !== "string" || !(color in PALETTE)) return;
    if (room.seats[1 - conn.seat]?.color === color) return;
    room.seats[conn.seat]!.color = color as ColorId;
    this.broadcastLobby(room);
  }

  private start(room: Room): void {
    const names = room.seats.map((s) => s!.name) as [string, string];
    room.game = new Game({ seed: Math.floor(Math.random() * 2 ** 31), names });
    room.playing = true;
    room.carry = 0;
    room.seats.forEach((s, i) => {
      const c = s && s.conn !== null ? this.conns.get(s.conn) : undefined;
      if (c) this.sendStart(room, c, i as Seat);
    });
    this.broadcastLobby(room);
    this.broadcast(room, { t: "state", s: room.game.snapshot() });
  }

  private sendStart(room: Room, conn: Conn, seat: Seat): void {
    const g = room.game!;
    const colors = room.seats.map((s, i) => s?.color ?? DEFAULT_COLORS[i]) as [ColorId, ColorId];
    conn.send({ t: "start", seat, names: g.names, colors, terrain: { w: g.terrain.w, h: g.terrain.h, rle: g.terrain.toRLE() } });
    conn.send({ t: "state", s: g.snapshot() });
  }

  private finish(room: Room): void {
    const g = room.game!;
    if (g.winner === 0 || g.winner === 1) room.wins[g.winner]++;
    room.playing = false;
    for (const s of room.seats) if (s) s.ready = false;
    // seats whose player is gone for good are released so a new opponent can join
    room.seats.forEach((s, i) => {
      if (s && s.conn === null) room.seats[i] = null;
    });
    this.broadcastLobby(room);
  }

  private detach(conn: Conn, explicit: boolean): void {
    if (conn.room === undefined || conn.seat === undefined) return;
    const room = this.rooms.get(conn.room);
    const seat = conn.seat;
    conn.room = undefined;
    conn.seat = undefined;
    if (!room) return;
    const s = room.seats[seat];
    if (!s || s.conn !== conn.id) return;
    if (room.playing && room.game) {
      s.conn = null;
      room.game.paused = true;
      if (explicit) room.game.forfeit(seat);
    } else {
      room.seats[seat] = null;
    }
    if (room.seats.every((x) => x === null)) this.rooms.delete(room.code);
    else this.broadcastLobby(room);
  }

  private lobbyPlayers(room: Room): [LobbyPlayer | null, LobbyPlayer | null] {
    return room.seats.map((s) => (s ? { name: s.name, ready: s.ready, connected: s.conn !== null, color: s.color } : null)) as [LobbyPlayer | null, LobbyPlayer | null];
  }

  private broadcastLobby(room: Room): void {
    this.broadcast(room, { t: "lobby", code: room.code, players: this.lobbyPlayers(room), wins: [...room.wins] as [number, number], playing: room.playing });
  }

  private broadcast(room: Room, msg: ServerMsg): void {
    for (const s of room.seats) {
      if (!s || s.conn === null) continue;
      this.conns.get(s.conn)?.send(msg);
    }
  }
}
