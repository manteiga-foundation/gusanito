import { describe, expect, test } from "bun:test";
import { soundsFor } from "../../src/client/sounds.ts";
import type { WormView } from "../../src/shared/protocol.ts";

const worms: WormView[] = [
  { id: 0, team: 0, x: 0, y: 0, hp: 0, alive: false, facing: 1 },
  { id: 1, team: 1, x: 0, y: 0, hp: 0, alive: false, facing: 1 },
];

describe("sound cues", () => {
  test("a worm dying plays the death cue", () => {
    expect(soundsFor({ t: "die", id: 1 }, 0, worms)).toContain("death");
  });

  test("a drowning plays the splash and the death cue", () => {
    expect(soundsFor({ t: "drown", id: 1 }, 0, worms)).toEqual(["splash", "death"]);
  });

  test("losing one of your own worms is marked so it can feel different", () => {
    expect(soundsFor({ t: "die", id: 0 }, 0, worms)).toEqual(["death-own"]);
    expect(soundsFor({ t: "die", id: 1 }, 0, worms)).toEqual(["death"]);
  });

  test("blasts, shots and splashes keep their cues", () => {
    expect(soundsFor({ t: "boom", x: 0, y: 0, r: 40 }, 0, worms)).toEqual(["boom"]);
    expect(soundsFor({ t: "fire", seat: 0, weapon: "rocket", x: 0, y: 0 }, 0, worms)).toEqual(["fire"]);
    expect(soundsFor({ t: "splash", x: 0 }, 0, worms)).toEqual(["splash"]);
  });
});
