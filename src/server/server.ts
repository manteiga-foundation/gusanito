import { resolve, sep } from "node:path";
import { Rooms } from "./rooms.ts";

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  map: "application/json",
  json: "application/json",
  webmanifest: "application/manifest+json",
  svg: "image/svg+xml",
  png: "image/png",
};

export interface ServerOptions {
  port: number;
  hostname?: string;
  staticDir: string;
}

export function startServer(opts: ServerOptions) {
  const rooms = new Rooms();
  const root = resolve(opts.staticDir);
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    rooms.tick(Math.min(0.1, (now - last) / 1000));
    last = now;
  }, 1000 / 30);

  const server = Bun.serve<{ id: number }, never>({
    port: opts.port,
    hostname: opts.hostname ?? "0.0.0.0",
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (srv.upgrade(req, { data: { id: 0 } })) return;
        return new Response("upgrade required", { status: 426 });
      }
      if (url.pathname === "/health") return Response.json({ ok: true, rooms: rooms.size });
      let path: string;
      try {
        path = decodeURIComponent(url.pathname);
      } catch {
        return new Response("not found", { status: 404 });
      }
      if (path === "/") path = "/index.html";
      const file = resolve(root, "." + path);
      if (!file.startsWith(root + sep)) return new Response("not found", { status: 404 });
      const f = Bun.file(file);
      if (!(await f.exists())) return new Response("not found", { status: 404 });
      const ext = file.split(".").pop() ?? "";
      return new Response(f, {
        headers: {
          "content-type": TYPES[ext] ?? "application/octet-stream",
          "cache-control": ext === "html" ? "no-cache" : "public, max-age=300",
          "x-content-type-options": "nosniff",
        },
      });
    },
    websocket: {
      maxPayloadLength: 4096,
      idleTimeout: 60,
      sendPings: true,
      open(ws) {
        ws.data.id = rooms.connect((m) => ws.send(JSON.stringify(m)));
      },
      message(ws, msg) {
        rooms.message(ws.data.id, typeof msg === "string" ? msg : msg.toString());
      },
      close(ws) {
        rooms.close(ws.data.id);
      },
    },
  });

  return {
    port: server.port,
    rooms,
    stop(force = false) {
      clearInterval(timer);
      server.stop(force);
    },
  };
}
