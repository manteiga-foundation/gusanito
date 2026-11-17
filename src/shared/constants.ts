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

export const TURN_SECONDS = 45;
export const RETREAT_SECONDS = 3;
export const SETTLE_MIN_SECONDS = 0.5;
export const SUDDEN_DEATH_TURN = 24;
export const SUDDEN_DEATH_RISE = 15;

export const MAX_POWER = 700;
export const WIND_ACCEL = 110;
export const WELL_G = 4_000_000;
export const WELL_SOFT = 40;
export const WELL_CORE = 14;

export const FORFEIT_SECONDS = 90;
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
  shots: number;
}

export const WEAPONS: Record<WeaponId, WeaponSpec> = {
  rocket: { id: "rocket", label: "Rocket", radius: 42, damage: 48, knock: 340, wind: true, fuse: 0, ammo: -1, shots: 1 },
  grenade: { id: "grenade", label: "Grenade", radius: 44, damage: 46, knock: 330, wind: false, fuse: 3, ammo: -1, shots: 1 },
  cluster: { id: "cluster", label: "Cluster", radius: 32, damage: 30, knock: 250, wind: false, fuse: 3, ammo: 2, shots: 1 },
  shotgun: { id: "shotgun", label: "Shotgun", radius: 12, damage: 25, knock: 160, wind: false, fuse: 0, ammo: -1, shots: 2 },
};

export const BOMBLET = { radius: 20, damage: 18, knock: 180, count: 5 };
export const WEAPON_ORDER: WeaponId[] = ["rocket", "grenade", "cluster", "shotgun"];
