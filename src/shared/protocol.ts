import type { ColorId, WeaponId } from "./constants.ts";

export type Seat = 0 | 1;
export type Phase = "countdown" | "play" | "over";

export type GameInput =
  | { t: "move"; dir: -1 | 0 | 1 }
  | { t: "jump" }
  | { t: "aim"; angle: number }
  | { t: "weapon"; id: WeaponId }
  | { t: "fire"; power: number };

export type ClientMsg =
  | { t: "create"; name: string; token?: string }
  | { t: "join"; code: string; name: string; token?: string }
  | { t: "ready"; ready: boolean }
  | { t: "color"; color: ColorId }
  | { t: "leave" }
  | GameInput;

export interface WormView {
  id: number;
  team: Seat;
  x: number;
  y: number;
  hp: number;
  alive: boolean;
  facing: 1 | -1;
}

export interface ProjView {
  id: number;
  team: Seat;
  k: "rocket" | "grenade" | "cluster" | "bomblet";
  x: number;
  y: number;
  vx: number;
  vy: number;
  fuse: number;
}

/** What one player is doing right now; both players act at the same time. */
export interface SeatView {
  active: number;
  aim: number;
  weapon: WeaponId;
  /** seconds until this player can fire again */
  reload: number;
  /** the reload's full length, for drawing progress */
  reloadOf: number;
  ammo: Record<WeaponId, number>;
}

export interface Snapshot {
  phase: Phase;
  /** whole seconds left in the opening countdown */
  countdown: number;
  /** whole seconds left on the match clock */
  clock: number;
  wind: number;
  wells: { x: number; y: number }[];
  worms: WormView[];
  proj: ProjView[];
  seats: [SeatView, SeatView];
  waterY: number;
  winner: Seat | -1 | null;
}

export type GameEvent =
  | { t: "boom"; x: number; y: number; r: number; team?: Seat }
  | { t: "hurt"; id: number; amount: number }
  | { t: "drown"; id: number }
  | { t: "die"; id: number }
  | { t: "fire"; seat: Seat; weapon: WeaponId; x: number; y: number }
  | { t: "shot"; seat: Seat; x0: number; y0: number; x1: number; y1: number }
  | { t: "fizzle"; x: number; y: number }
  | { t: "splash"; x: number }
  | { t: "switch"; seat: Seat; active: number };

export interface LobbyPlayer {
  name: string;
  ready: boolean;
  connected: boolean;
  color: ColorId;
}

export type ServerMsg =
  | { t: "joined"; code: string; seat: Seat; token: string }
  | { t: "lobby"; code: string; players: [LobbyPlayer | null, LobbyPlayer | null]; wins: [number, number]; playing: boolean }
  | { t: "start"; seat: Seat; names: [string, string]; colors: [ColorId, ColorId]; terrain: { w: number; h: number; rle: number[] } }
  | { t: "state"; s: Snapshot }
  | { t: "events"; list: GameEvent[] }
  | { t: "error"; reason: "full" | "not-found" | "bad-request" };
