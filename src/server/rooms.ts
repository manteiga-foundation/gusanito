import { COLOR_ORDER, FORFEIT_SECONDS, MAX_NAME, MAX_PLAYERS, PALETTE, TICK, WEAPONS, type ColorId, type WeaponId } from "../shared/constants.ts";
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
  /** this seat's team in the running match, or null when waiting for the next round */
  team: number | null;
}

export interface Room {
  code: string;
  seats: (SeatState | null)[];
  /** the current match, or the last finished one while back in the lobby */
  game: Game | null;
  playing: boolean;
  /** wins per seat */
  wins: number[];
  idleSeconds: number;
  carry: number;
  /** colours by team for the running match */
  teamColors: ColorId[];
}

const DEFAULT_NAMES = ["Player One", "Player Two", "Player Three", "Player Four", "Player Five", "Player Six"];

function cleanName(raw: unknown, seat: Seat): string {
  const s = typeof raw === "string" ? raw.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, MAX_NAME) : "";
  return s || DEFAULT_NAMES[seat];
}

function parseInput(m: Record<string, unknown>): GameInput | null {
  switch (m.t) {
    case "move":
      return m.dir === -1 || m.dir === 0 || m.dir === 1 ? { t: "move", dir: m.dir } : null;
    case "jump":
      return { t: "jump" };
    case "aim":
      return typeof m.angle === "number" && Number.isFinite(m.angle) ? { t: "aim", angle: m.angle } : null;
    case "fire":
      return typeof m.power === "number" && Number.isFinite(m.power) ? { t: "fire", power: m.power } : null;
    case "select":
      return typeof m.id === "number" && Number.isInteger(m.id) ? { t: "select", id: m.id } : null;
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
    const room = this.rooms.get(conn.room);
    const team = room?.seats[conn.seat]?.team;
    if (room?.playing && team !== null && team !== undefined) room.game?.handle(team, input);
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
      for (const s of room.seats) {
        if (!s || s.conn !== null || s.team === null) continue;
        s.awaySeconds += dt;
        if (s.awaySeconds > FORFEIT_SECONDS && g.worms.some((w) => w.team === s.team && w.alive)) {
          g.forfeit(s.team);
          g.paused = this.anyAway(room);
        }
      }
      room.carry += dt;
      while (room.carry >= TICK - 1e-9) {
        g.step();
        room.carry -= TICK;
      }
      const events = g.drainEvents();
      if (events.length) this.broadcast(room, { t: "events", list: events }, true);
      this.broadcast(room, { t: "state", s: g.snapshot() }, true);
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
    const room: Room = { code, seats: Array(MAX_PLAYERS).fill(null), game: null, playing: false, wins: Array(MAX_PLAYERS).fill(0), idleSeconds: 0, carry: 0, teamColors: [] };
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
      if (room.playing && room.game && s.team !== null) {
        this.sendStart(room, conn, s.team);
        room.game.paused = this.anyAway(room);
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
    const taken = new Set(room.seats.map((s) => s?.color));
    const color = COLOR_ORDER.find((c) => !taken.has(c))!;
    room.seats[seat] = { name, token, ready: false, color, conn: conn.id, awaySeconds: 0, team: null };
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
    const present = room.seats.filter((s): s is SeatState => !!s && s.conn !== null);
    if (present.length >= 2 && present.every((s) => s.ready)) this.start(room);
  }

  private setColor(conn: Conn, color: unknown): void {
    if (conn.room === undefined || conn.seat === undefined) return;
    const room = this.rooms.get(conn.room);
    if (!room || room.playing || typeof color !== "string" || !(color in PALETTE)) return;
    if (room.seats.some((s, i) => s && i !== conn.seat && s.color === color)) return;
    room.seats[conn.seat]!.color = color as ColorId;
    this.broadcastLobby(room);
  }

  private start(room: Room): void {
    // every present player becomes a team, in seat order
    const players = room.seats.filter((s): s is SeatState => !!s && s.conn !== null);
    players.forEach((s, t) => (s.team = t));
    room.teamColors = players.map((s) => s.color);
    room.game = new Game({ seed: Math.floor(Math.random() * 2 ** 31), names: players.map((s) => s.name) });
    room.playing = true;
    room.carry = 0;
    for (const s of players) {
      const c = this.conns.get(s.conn!);
      if (c) this.sendStart(room, c, s.team!);
    }
    this.broadcastLobby(room);
    this.broadcast(room, { t: "state", s: room.game.snapshot() }, true);
  }

  private sendStart(room: Room, conn: Conn, team: Seat): void {
    const g = room.game!;
    conn.send({ t: "start", team, names: g.names, colors: [...room.teamColors], terrain: { w: g.terrain.w, h: g.terrain.h, rle: g.terrain.toRLE() } });
    conn.send({ t: "state", s: g.snapshot() });
  }

  private anyAway(room: Room): boolean {
    return room.seats.some((s) => s && s.team !== null && s.conn === null && room.game!.worms.some((w) => w.team === s.team && w.alive));
  }

  private finish(room: Room): void {
    const g = room.game!;
    const winnerSeat = room.seats.findIndex((s) => s && s.team !== null && s.team === g.winner);
    if (winnerSeat >= 0) room.wins[winnerSeat]++;
    room.playing = false;
    for (const s of room.seats) if (s) {
      s.ready = false;
      s.team = null;
    }
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
    if (room.playing && room.game && s.team !== null) {
      s.conn = null;
      if (explicit) room.game.forfeit(s.team);
      room.game.paused = this.anyAway(room);
    } else {
      room.seats[seat] = null;
    }
    if (room.seats.every((x) => x === null)) this.rooms.delete(room.code);
    else this.broadcastLobby(room);
  }

  private lobbyPlayers(room: Room): (LobbyPlayer | null)[] {
    return room.seats.map((s) => (s ? { name: s.name, ready: s.ready, connected: s.conn !== null, color: s.color, inMatch: room.playing && s.team !== null } : null));
  }

  private broadcastLobby(room: Room): void {
    this.broadcast(room, { t: "lobby", code: room.code, players: this.lobbyPlayers(room), wins: [...room.wins], playing: room.playing });
  }

  private broadcast(room: Room, msg: ServerMsg, matchOnly = false): void {
    for (const s of room.seats) {
      if (!s || s.conn === null || (matchOnly && s.team === null)) continue;
      this.conns.get(s.conn)?.send(msg);
    }
  }
}
