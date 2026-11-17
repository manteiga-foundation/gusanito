import { describe, expect, test } from "bun:test";
import { Rooms } from "../../src/server/rooms.ts";
import type { ServerMsg } from "../../src/shared/protocol.ts";

function client(rooms: Rooms) {
  const inbox: ServerMsg[] = [];
  const conn = rooms.connect((m) => inbox.push(m));
  return {
    conn,
    inbox,
    send: (m: object) => rooms.message(conn, JSON.stringify(m)),
    last: <T extends ServerMsg["t"]>(t: T) => [...inbox].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined,
    count: (t: ServerMsg["t"]) => inbox.filter((m) => m.t === t).length,
  };
}

function pair() {
  const rooms = new Rooms();
  const a = client(rooms);
  a.send({ t: "create", name: "Ada" });
  const code = a.last("joined")!.code;
  const b = client(rooms);
  b.send({ t: "join", code, name: "Bo" });
  return { rooms, a, b, code };
}

describe("lobby: Ready Player One / Ready Player Two", () => {
  test("creating a room seats player one and returns a four-letter code", () => {
    const rooms = new Rooms();
    const a = client(rooms);
    a.send({ t: "create", name: "Ada" });
    const j = a.last("joined")!;
    expect(j.code).toMatch(/^[A-Z]{4}$/);
    expect(j.seat).toBe(0);
    expect(j.token.length).toBeGreaterThan(10);
    const l = a.last("lobby")!;
    expect(l.players[0]).toMatchObject({ name: "Ada", ready: false, connected: true });
    expect(l.players[1]).toBeNull();
  });

  test("joining seats player two and both see each other, not ready", () => {
    const { a, b } = pair();
    expect(b.last("joined")!.seat).toBe(1);
    for (const c of [a, b]) {
      const l = c.last("lobby")!;
      expect(l.players[0]).toMatchObject({ name: "Ada", ready: false });
      expect(l.players[1]).toMatchObject({ name: "Bo", ready: false });
    }
  });

  test("a third player is turned away and an unknown code is reported", () => {
    const { rooms, code } = pair();
    const c = client(rooms);
    c.send({ t: "join", code, name: "Cy" });
    expect(c.last("error")!.reason).toBe("full");
    c.send({ t: "join", code: "ZZZZ", name: "Cy" });
    expect(c.last("error")!.reason).toBe("not-found");
  });

  test("the match starts only once both players are ready", () => {
    const { a, b } = pair();
    a.send({ t: "ready", ready: true });
    expect(b.last("lobby")!.players[0]!.ready).toBe(true);
    expect(a.count("start")).toBe(0);
    a.send({ t: "ready", ready: false });
    b.send({ t: "ready", ready: true });
    expect(a.count("start")).toBe(0);
    a.send({ t: "ready", ready: true });
    for (const c of [a, b]) {
      const s = c.last("start")!;
      expect(s.terrain.rle.length).toBeGreaterThan(100);
      expect(s.names).toEqual(["Ada", "Bo"]);
    }
  });

  test("a running match streams state to both players and routes input by seat", () => {
    const { rooms, a, b, code } = pair();
    a.send({ t: "ready", ready: true });
    b.send({ t: "ready", ready: true });
    const g = rooms.get(code)!.game!;
    const x0 = g.activeWorm().x;
    b.send({ t: "move", dir: 1 });
    rooms.tick(0.5);
    expect(g.activeWorm().x).toBe(x0);
    a.send({ t: "move", dir: 1 });
    rooms.tick(0.5);
    expect(g.activeWorm().x).not.toBe(x0);
    expect(a.count("state")).toBeGreaterThan(3);
    expect(b.last("state")!.s.worms.length).toBe(6);
  });

  test("leaving the lobby frees the seat", () => {
    const { rooms, a, b } = pair();
    rooms.close(b.conn);
    expect(a.last("lobby")!.players[1]).toBeNull();
  });

  test("a disconnect mid-match pauses it and the token reclaims the seat", () => {
    const { rooms, a, b, code } = pair();
    a.send({ t: "ready", ready: true });
    b.send({ t: "ready", ready: true });
    const token = b.last("joined")!.token;
    rooms.close(b.conn);
    expect(rooms.get(code)!.game!.paused).toBe(true);
    expect(a.last("lobby")!.players[1]!.connected).toBe(false);
    const b2 = client(rooms);
    b2.send({ t: "join", code, name: "Bo", token });
    expect(b2.last("joined")!.seat).toBe(1);
    expect(b2.count("start")).toBe(1);
    expect(rooms.get(code)!.game!.paused).toBe(false);
  });

  test("an opponent gone too long forfeits", () => {
    const { rooms, a, b, code } = pair();
    a.send({ t: "ready", ready: true });
    b.send({ t: "ready", ready: true });
    rooms.close(b.conn);
    rooms.tick(100);
    expect(rooms.get(code)!.game!.winner).toBe(0);
    expect(a.last("state")!.s.phase).toBe("over");
  });

  test("after a match both players return to the ready lobby for a rematch", () => {
    const { rooms, a, b, code } = pair();
    a.send({ t: "ready", ready: true });
    b.send({ t: "ready", ready: true });
    const g = rooms.get(code)!.game!;
    for (const w of g.worms) if (w.team === 1) w.y = 2000;
    a.send({ t: "skip" });
    rooms.tick(3);
    expect(g.winner).toBe(0);
    const l = a.last("lobby")!;
    expect(l.players[0]!.ready).toBe(false);
    expect(l.players[1]!.ready).toBe(false);
    expect(l.wins).toEqual([1, 0]);
    a.send({ t: "ready", ready: true });
    b.send({ t: "ready", ready: true });
    expect(a.count("start")).toBe(2);
  });

  test("malformed messages are ignored", () => {
    const rooms = new Rooms();
    const a = client(rooms);
    rooms.message(a.conn, "not json");
    rooms.message(a.conn, JSON.stringify({ t: "create", name: "x".repeat(500) }));
    expect(a.last("joined")!.code).toMatch(/^[A-Z]{4}$/);
    expect(a.last("lobby")!.players[0]!.name.length).toBeLessThanOrEqual(16);
  });
});
