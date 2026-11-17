/** Joystick geometry in CSS pixels. */
export const STICK = { dead: 14, jump: 30, max: 40 };

export interface StickRead {
  dir: -1 | 0 | 1;
  /** true once per upward push */
  jump: boolean;
  /** whether the next upward push may jump */
  armed: boolean;
  /** knob offset, clamped to the ring */
  kx: number;
  ky: number;
}

/** One control for walking and jumping: sideways walks, a push up jumps (once per push). */
export function readStick(dx: number, dy: number, armed: boolean): StickRead {
  const d = Math.hypot(dx, dy);
  const k = d > STICK.max ? STICK.max / d : 1;
  const dir: -1 | 0 | 1 = Math.abs(dx) > STICK.dead ? (dx > 0 ? 1 : -1) : 0;
  const up = dy < -STICK.jump;
  const jump = armed && up;
  const rearm = dy > -STICK.jump * 0.5;
  return { dir, jump, armed: jump ? false : armed || rearm, kx: dx * k, ky: dy * k };
}
