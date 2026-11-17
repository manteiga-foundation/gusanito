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

  test("up to six players fit; a seventh is turned away and an unknown code is reported", () => {
    const { rooms, code } = pair();
    const more = ["Cy", "Di", "Ed", "Flo"].map((n) => {
      const c = client(rooms);
      c.send({ t: "join", code, name: n });
      return c;
    });
    expect(more.map((c) => c.last("joined")!.seat)).toEqual([2, 3, 4, 5]);
    const l = more[3].last("lobby")!;
    expect(l.players.map((p) => p?.name)).toEqual(["Ada", "Bo", "Cy", "Di", "Ed", "Flo"]);
    expect(new Set(l.players.map((p) => p!.color)).size).toBe(6);
    const g = client(rooms);
    g.send({ t: "join", code, name: "Gus" });
    expect(g.last("error")!.reason).toBe("full");
    g.send({ t: "join", code: "ZZZZ", name: "Gus" });
    expect(g.last("error")!.reason).toBe("not-found");
  });

  test("three players: the match waits for everyone, then brings three teams of worms", () => {
    const { rooms, a, b, code } = pair();
    const c = client(rooms);
    c.send({ t: "join", code, name: "Cy" });
    a.send({ t: "ready", ready: true });
    b.send({ t: "ready", ready: true });
    expect(a.count("start")).toBe(0);
    c.send({ t: "ready", ready: true });
    const s = c.last("start")!;
    expect(s.team).toBe(2);
    expect(s.names).toEqual(["Ada", "Bo", "Cy"]);
    expect(s.colors.length).toBe(3);
    expect(rooms.get(code)!.game!.worms.length).toBe(9);
  });

  test("a lone ready player does not start a match", () => {
    const rooms = new Rooms();
    const a = client(rooms);
    a.send({ t: "create", name: "Ada" });
    a.send({ t: "ready", ready: true });
    expect(a.count("start")).toBe(0);
  });

  test("someone joining mid-match waits in the lobby for the next round", () => {
    const { rooms, a, b, code } = pair();
    a.send({ t: "ready", ready: true });
    b.send({ t: "ready", ready: true });
    const c = client(rooms);
    c.send({ t: "join", code, name: "Cy" });
    expect(c.last("joined")!.seat).toBe(2);
    expect(c.count("start")).toBe(0);
    const l = c.last("lobby")!;
    expect(l.playing).toBe(true);
    expect(l.players[2]).toMatchObject({ name: "Cy", inMatch: false });
    expect(l.players[0]).toMatchObject({ inMatch: true });
    expect(rooms.get(code)!.game!.worms.length).toBe(6);
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
    rooms.tick(3.1); // countdown
    const x0 = g.activeWorm(0).x;
    const x1 = g.activeWorm(1).x;
    a.send({ t: "move", dir: 1 });
    b.send({ t: "move", dir: -1 });
    rooms.tick(0.5);
    expect(g.activeWorm(0).x).toBeGreaterThan(x0);
    expect(g.activeWorm(1).x).toBeLessThan(x1);
    expect(a.count("state")).toBeGreaterThan(3);
    expect(b.last("state")!.s.worms.length).toBe(6);
  });

  test("worm selection travels from the player to their team", () => {
    const { rooms, a, b, code } = pair();
    a.send({ t: "ready", ready: true });
    b.send({ t: "ready", ready: true });
    const g = rooms.get(code)!.game!;
    rooms.tick(3.1);
    const mine = g.worms.filter((w) => w.team === 1);
    b.send({ t: "select", id: mine[2].id });
    expect(g.activeWorm(1).id).toBe(mine[2].id);
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
    rooms.tick(1);
    expect(g.winner).toBe(0);
    const l = a.last("lobby")!;
    expect(l.players[0]!.ready).toBe(false);
    expect(l.players[1]!.ready).toBe(false);
    expect(l.wins).toEqual([1, 0, 0, 0, 0, 0]);
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

describe("player colours", () => {
  test("seats start with distinct default colours", () => {
    const { a } = pair();
    const l = a.last("lobby")!;
    expect(l.players[0]!.color).toBe("coral");
    expect(l.players[1]!.color).toBe("teal");
  });

  test("a player picks a free colour and both players see it", () => {
    const { a, b } = pair();
    a.send({ t: "color", color: "lime" });
    expect(b.last("lobby")!.players[0]!.color).toBe("lime");
  });

  test("the opponent's colour and unknown colours are refused", () => {
    const { a, b } = pair();
    a.send({ t: "color", color: "teal" });
    a.send({ t: "color", color: "#ff0000" });
    expect(b.last("lobby")!.players[0]!.color).toBe("coral");
  });

  test("a joiner whose default is taken gets the first free colour", () => {
    const rooms = new Rooms();
    const a = client(rooms);
    a.send({ t: "create", name: "Ada" });
    a.send({ t: "color", color: "teal" });
    const code = a.last("joined")!.code;
    const b = client(rooms);
    b.send({ t: "join", code, name: "Bo" });
    expect(b.last("lobby")!.players[1]!.color).toBe("coral");
  });

  test("colours travel with the match start and are locked while playing", () => {
    const { rooms, a, b, code } = pair();
    b.send({ t: "color", color: "rose" });
    a.send({ t: "ready", ready: true });
    b.send({ t: "ready", ready: true });
    expect(a.last("start")!.colors).toEqual(["coral", "rose"]);
    expect(a.last("start")!.team).toBe(0);
    a.send({ t: "color", color: "sky" });
    expect(rooms.get(code)!.seats[0]!.color).toBe("coral");
  });
});
