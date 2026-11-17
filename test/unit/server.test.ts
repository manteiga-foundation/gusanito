import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer } from "../../src/server/server.ts";
import type { ServerMsg } from "../../src/shared/protocol.ts";

let server: ReturnType<typeof startServer>;
let base = "";

beforeAll(() => {
  server = startServer({ port: 0, staticDir: "public" });
  base = `127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

function ws() {
  const sock = new WebSocket(`ws://${base}/ws`);
  const inbox: ServerMsg[] = [];
  const waiters: [(m: ServerMsg) => boolean, (m: ServerMsg) => void][] = [];
  sock.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as ServerMsg;
    inbox.push(m);
    for (const w of [...waiters]) if (w[0](m)) { waiters.splice(waiters.indexOf(w), 1); w[1](m); }
  };
  const open = new Promise((r) => (sock.onopen = r));
  return {
    open,
    send: (m: object) => sock.send(JSON.stringify(m)),
    wait: <T extends ServerMsg["t"]>(t: T, pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true) =>
      new Promise<Extract<ServerMsg, { t: T }>>((res, rej) => {
        const found = inbox.find((m) => m.t === t && pred(m as never));
        if (found) return res(found as never);
        waiters.push([(m) => m.t === t && pred(m as never), res as never]);
        setTimeout(() => rej(new Error("timeout waiting for " + t)), 4000);
      }),
    close: () => sock.close(),
  };
}

test("health endpoint answers", async () => {
  const r = await fetch(`http://${base}/health`);
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ ok: true });
});

test("the game page is served with mobile viewport settings", async () => {
  const r = await fetch(`http://${base}/`);
  expect(r.status).toBe(200);
  const html = await r.text();
  expect(html).toContain('name="viewport"');
  expect(r.headers.get("content-type")).toContain("text/html");
});

test("unknown paths and path traversal get 404", async () => {
  expect((await fetch(`http://${base}/nope.js`)).status).toBe(404);
  expect((await fetch(`http://${base}/..%2fpackage.json`)).status).toBe(404);
});

test("two sockets create, join, ready up, and receive a live match", async () => {
  const a = ws();
  const b = ws();
  await Promise.all([a.open, b.open]);
  a.send({ t: "create", name: "Ada" });
  const { code } = await a.wait("joined");
  b.send({ t: "join", code, name: "Bo" });
  await b.wait("joined");
  await a.wait("lobby", (l) => l.players[1]?.name === "Bo");
  a.send({ t: "ready", ready: true });
  b.send({ t: "ready", ready: true });
  const start = await b.wait("start");
  expect(start.seat).toBe(1);
  const s = await a.wait("state", (m) => m.s.worms.length === 6);
  expect(s.s.phase).toBe("countdown");
  a.close();
  b.close();
});

test("the page carries a generic link preview card", async () => {
  const html = await (await fetch(`http://${base}/`, { headers: { host: "gusanito.example" } })).text();
  expect(html).toContain('<meta property="og:title" content="Wriggle');
  expect(html).toContain('<meta property="og:image" content="https://gusanito.example/og-card.jpg"');
  expect(html).toContain('<meta name="twitter:card" content="summary_large_image"');
  expect(html).toContain("Manteiga Foundation");
  expect(html).not.toContain("{{");
});

test("an invite link previews who is inviting and the match code, safely escaped", async () => {
  const a = ws();
  await a.open;
  a.send({ t: "create", name: 'Ada "<b>&' });
  const { code } = await a.wait("joined");
  const html = await (await fetch(`http://${base}/?room=${code}`, { headers: { host: "gusanito.example" } })).text();
  // names lose angle brackets at the door; quotes and ampersands are escaped in the tags
  expect(html).toContain(`<meta property="og:title" content="Ada &quot;b&amp; invites you to Wriggle">`);
  expect(html).toContain(`match ${code}`);
  expect(html).toContain(`<meta property="og:url" content="https://gusanito.example/?room=${code}">`);
  expect(html).not.toContain("<b>&");
  a.close();
});

test("an unknown room code falls back to the generic card", async () => {
  const html = await (await fetch(`http://${base}/?room=QQQQ`)).text();
  expect(html).not.toContain("invites you");
});

test("the preview image is served as a jpeg", async () => {
  const r = await fetch(`http://${base}/og-card.jpg`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("image/jpeg");
});
