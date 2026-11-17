import { describe, expect, test } from "bun:test";
import { Terrain } from "../../src/shared/terrain.ts";
import { WORLD_W, WORLD_H, WATER_Y } from "../../src/shared/constants.ts";

describe("terrain", () => {
  test("generation is deterministic per seed and differs across seeds", () => {
    const a = Terrain.generate(42);
    const b = Terrain.generate(42);
    const c = Terrain.generate(43);
    expect(a.w).toBe(WORLD_W);
    expect(a.h).toBe(WORLD_H);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    expect(Buffer.from(a.data).equals(Buffer.from(c.data))).toBe(false);
  });

  test("generated land has both ground and sky, and the sky is open at the top", () => {
    const t = Terrain.generate(7);
    let solid = 0;
    for (let i = 0; i < t.data.length; i++) solid += t.data[i];
    const share = solid / t.data.length;
    expect(share).toBeGreaterThan(0.15);
    expect(share).toBeLessThan(0.6);
    for (let x = 0; x < t.w; x += 50) expect(t.solid(x, 5)).toBe(false);
  });

  test("the map edges fall into the water so worms can be knocked off", () => {
    const t = Terrain.generate(9);
    for (let y = 0; y < WATER_Y; y++) {
      expect(t.solid(2, y)).toBe(false);
      expect(t.solid(t.w - 3, y)).toBe(false);
    }
  });

  test("solid() treats outside the map as air at the sides and top", () => {
    const t = Terrain.flat(500);
    expect(t.solid(-5, 600)).toBe(false);
    expect(t.solid(t.w + 5, 600)).toBe(false);
    expect(t.solid(100, -10)).toBe(false);
    expect(t.solid(100, 600)).toBe(true);
    expect(t.solid(100, 499)).toBe(false);
  });

  test("carve removes ground inside the circle only", () => {
    const t = Terrain.flat(500);
    t.carve(400, 500, 30);
    expect(t.solid(400, 510)).toBe(false);
    expect(t.solid(400, 528)).toBe(false);
    expect(t.solid(400, 535)).toBe(true);
    expect(t.solid(440, 510)).toBe(true);
  });

  test("RLE round-trip reproduces the mask exactly and is compact", () => {
    const t = Terrain.generate(3);
    t.carve(900, 500, 60);
    const rle = t.toRLE();
    const back = Terrain.fromRLE(t.w, t.h, rle);
    expect(Buffer.from(back.data).equals(Buffer.from(t.data))).toBe(true);
    expect(rle.length).toBeLessThan(t.w * 20);
  });

  test("surface normal on flat ground points up", () => {
    const t = Terrain.flat(500);
    const n = t.normal(300, 499);
    expect(n.y).toBeLessThan(-0.9);
    expect(Math.abs(n.x)).toBeLessThan(0.2);
  });

  test("groundBelow finds the first solid row under a point", () => {
    const t = Terrain.flat(500);
    expect(t.groundBelow(300, 100)).toBe(500);
    t.carve(300, 500, 20);
    expect(t.groundBelow(300, 100)).toBe(521);
  });
});
