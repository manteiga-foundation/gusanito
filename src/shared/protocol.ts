import type { ColorId, WeaponId } from "./constants.ts";

export type Seat = 0 | 1;
export type Phase = "aim" | "retreat" | "settle" | "over";

export type GameInput =
  | { t: "move"; dir: -1 | 0 | 1 }
  | { t: "jump" }
  | { t: "aim"; angle: number }
  | { t: "weapon"; id: WeaponId }
  | { t: "fire"; power: number }
  | { t: "skip" };

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
  k: "rocket" | "grenade" | "cluster" | "bomblet";
  x: number;
  y: number;
  vx: number;
  vy: number;
  fuse: number;
}

export interface Snapshot {
  phase: Phase;
  turn: number;
  team: Seat;
  active: number;
  timer: number;
  retreat: number;
  wind: number;
  wells: { x: number; y: number }[];
  worms: WormView[];
  proj: ProjView[];
  weapon: WeaponId;
  aim: number;
  shots: number;
  ammo: Record<WeaponId, number>;
  waterY: number;
  winner: Seat | -1 | null;
}

export type GameEvent =
  | { t: "boom"; x: number; y: number; r: number }
  | { t: "hurt"; id: number; amount: number }
  | { t: "drown"; id: number }
  | { t: "die"; id: number }
  | { t: "fire"; weapon: WeaponId; x: number; y: number }
  | { t: "shot"; x0: number; y0: number; x1: number; y1: number }
  | { t: "fizzle"; x: number; y: number }
  | { t: "splash"; x: number }
  | { t: "turn"; team: Seat; active: number };

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
