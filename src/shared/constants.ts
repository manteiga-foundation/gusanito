export const WORLD_W = 2000;
export const WORLD_H = 1000;
export const WATER_Y = 940;
export const TICK = 1 / 60;

export const GRAVITY = 420;
export const WORM_R = 8;
export const WALK_SPEED = 55;
export const STEP_UP = 5;
export const JUMP_VY = -230;
export const JUMP_VX = 110;
export const FALL_SAFE_SPEED = 330;

// Both players act at once: a short countdown, a fixed match clock, rising water at the end.
export const COUNTDOWN_SECONDS = 3;
export const MATCH_SECONDS = 180;
export const RISE_LAST_SECONDS = 60;
export const RISE_SPEED = 1.5;
export const WIND_SECONDS = 15;

export const MAX_POWER = 700;
export const WIND_ACCEL = 110;
export const WELL_G = 4_000_000;
export const WELL_SOFT = 40;
export const WELL_CORE = 14;

export const FORFEIT_SECONDS = 90;
/** One player per team colour. */
export const MAX_PLAYERS = 6;
export const WORMS_PER_TEAM = 3;
export const MAX_NAME = 16;

export type WeaponId = "rocket" | "grenade" | "cluster" | "shotgun";

export interface WeaponSpec {
  id: WeaponId;
  label: string;
  radius: number;
  damage: number;
  knock: number;
  wind: boolean;
  fuse: number; // seconds; 0 = explodes on impact
  ammo: number; // -1 = unlimited
  reload: number; // seconds before the same player can fire again
}

export const WEAPONS: Record<WeaponId, WeaponSpec> = {
  rocket: { id: "rocket", label: "Rocket", radius: 42, damage: 65, knock: 340, wind: true, fuse: 0, ammo: -1, reload: 1.6 },
  grenade: { id: "grenade", label: "Grenade", radius: 44, damage: 62, knock: 330, wind: false, fuse: 3, ammo: -1, reload: 1.6 },
  cluster: { id: "cluster", label: "Cluster", radius: 32, damage: 40, knock: 250, wind: false, fuse: 3, ammo: 2, reload: 2.4 },
  shotgun: { id: "shotgun", label: "Shotgun", radius: 12, damage: 34, knock: 160, wind: false, fuse: 0, ammo: -1, reload: 0.9 },
};

export const BOMBLET = { radius: 20, damage: 24, knock: 180, count: 5 };
export const WEAPON_ORDER: WeaponId[] = ["rocket", "grenade", "cluster", "shotgun"];

/** Team colours a player can choose in the lobby; no two players share one. */
export const PALETTE = {
  coral: { label: "Coral", hex: "#ff7a59" },
  teal: { label: "Teal", hex: "#3fc8b6" },
  sky: { label: "Sky", hex: "#5aa9ff" },
  lime: { label: "Lime", hex: "#9bd84e" },
  rose: { label: "Rose", hex: "#ff5c9a" },
  sun: { label: "Sun", hex: "#ffd447" },
} as const;
export type ColorId = keyof typeof PALETTE;
export const COLOR_ORDER = Object.keys(PALETTE) as ColorId[];
export const DEFAULT_COLORS: ColorId[] = ["coral", "teal", "sky", "lime", "rose", "sun"];
