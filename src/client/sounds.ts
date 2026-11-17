import type { GameEvent, Seat, WormView } from "../shared/protocol.ts";

export type Cue = "boom" | "fire" | "splash" | "death" | "death-own";

/** Which sounds an event plays for this reader; losing your own worm gets its own cue. */
export function soundsFor(e: GameEvent, seat: Seat | null, worms: WormView[]): Cue[] {
  const death = (id: number): Cue => (worms.find((w) => w.id === id)?.team === seat ? "death-own" : "death");
  switch (e.t) {
    case "boom":
      return ["boom"];
    case "fire":
      return ["fire"];
    case "splash":
      return ["splash"];
    case "drown":
      return ["splash", death(e.id)];
    case "die":
      return [death(e.id)];
    default:
      return [];
  }
}
