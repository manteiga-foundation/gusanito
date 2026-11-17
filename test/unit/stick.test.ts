import { describe, expect, test } from "bun:test";
import { STICK, readStick } from "../../src/client/stick.ts";

describe("joystick", () => {
  test("a small nudge does nothing", () => {
    const r = readStick(STICK.dead - 2, -STICK.dead + 2, true);
    expect(r.dir).toBe(0);
    expect(r.jump).toBe(false);
  });

  test("pushing sideways walks that way", () => {
    expect(readStick(30, 0, true).dir).toBe(1);
    expect(readStick(-30, 5, true).dir).toBe(-1);
  });

  test("pushing up jumps once, and again only after the stick comes back down", () => {
    const first = readStick(0, -STICK.jump - 4, true);
    expect(first.jump).toBe(true);
    const held = readStick(0, -STICK.jump - 10, first.armed);
    expect(held.jump).toBe(false);
    const back = readStick(0, -4, held.armed);
    expect(back.jump).toBe(false);
    expect(readStick(0, -STICK.jump - 4, back.armed).jump).toBe(true);
  });

  test("up and to the side walks and jumps that way", () => {
    const r = readStick(-30, -STICK.jump - 4, true);
    expect(r.dir).toBe(-1);
    expect(r.jump).toBe(true);
  });

  test("the knob stays inside the ring", () => {
    const r = readStick(200, -200, true);
    expect(Math.hypot(r.kx, r.ky)).toBeCloseTo(STICK.max, 5);
  });
});
