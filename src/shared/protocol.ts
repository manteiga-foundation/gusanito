import type { ColorId, WeaponId } from "./constants.ts";

/** A player slot: a lobby seat (0..5) or a team in a match (0..players-1). */
export type Seat = number;
export type Phase = "countdown" | "play" | "over";

export type GameInput =
  | { t: "move"; dir: -1 | 0 | 1 }
  | { t: "jump" }
  | { t: "aim"; angle: number }
  | { t: "weapon"; id: WeaponId }
  | { t: "fire"; power: number }
  /** take control of another of your own living worms */
  | { t: "select"; id: number };

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
  seats: SeatView[];
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
  /** playing in the current match (false for someone who joined mid-match) */
  inMatch: boolean;
}

export type ServerMsg =
  | { t: "joined"; code: string; seat: Seat; token: string }
  | { t: "lobby"; code: string; players: (LobbyPlayer | null)[]; wins: number[]; playing: boolean }
  /** `team` is this player's team in the match; names and colors are indexed by team */
  | { t: "start"; team: Seat; names: string[]; colors: ColorId[]; terrain: { w: number; h: number; rle: number[] } }
  | { t: "state"; s: Snapshot }
  | { t: "events"; list: GameEvent[] }
  | { t: "error"; reason: "full" | "not-found" | "bad-request" };
