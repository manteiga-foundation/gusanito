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
  jpg: "image/jpeg",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  sh: "text/plain; charset=utf-8",
};

export interface ServerOptions {
  port: number;
  hostname?: string;
  staticDir: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The one public address search engines should list, whichever host served the page. */
export const CANONICAL = "https://gusanito.manteiga.org/";
const REPOSITORY = "https://github.com/manteiga-foundation/gusanito";

const GENERIC = {
  title: "Gusanito: free online artillery game for 2 to 6 players",
  description:
    "Free online artillery game for 2 to 6 players, in the spirit of Worms. Play in the browser on a phone or computer: destructible ground, shifting wind and gravity wells. A Manteiga Foundation game.",
};

/** schema.org VideoGame description for search engines (rich results). */
const STRUCTURED = {
  "@context": "https://schema.org",
  "@type": "VideoGame",
  name: "Gusanito",
  url: CANONICAL,
  description: GENERIC.description,
  image: `${CANONICAL}og-card.jpg`,
  genre: ["Artillery", "Strategy", "Party game"],
  gamePlatform: ["Web browser", "Android", "iOS", "macOS", "Windows", "Linux"],
  applicationCategory: "Game",
  operatingSystem: "Any (web browser)",
  playMode: ["MultiPlayer", "CoOp"],
  numberOfPlayers: { "@type": "QuantitativeValue", minValue: 2, maxValue: 6 },
  inLanguage: "en",
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD", availability: "https://schema.org/InStock" },
  author: { "@type": "Organization", name: "Manteiga Foundation", url: "https://manteiga.org" },
  publisher: { "@type": "Organization", name: "Manteiga Foundation", url: "https://manteiga.org" },
  license: "https://opensource.org/licenses/MIT",
  sameAs: [REPOSITORY],
};
// "<" escaped so no value can close the script element early
const STRUCTURED_JSON = JSON.stringify(STRUCTURED).replace(/</g, "\\u003c");

/** Fills the page's link-preview tags; an invite link names the host and the match code. */
export function renderPage(template: string, origin: string, room: string | null, host: string | null, inviteLink = !!room): string {
  const invite = room && host;
  const fields: Record<string, string> = {
    title: invite ? `${host} invites you to Gusanito` : GENERIC.title,
    description: invite
      ? `Tap to join match ${room}. Up to six players, destructible ground, wind and gravity wells. A Manteiga Foundation game.`
      : GENERIC.description,
    url: invite ? `${origin}/?room=${room}` : `${origin}/`,
    image: `${origin}/og-card.jpg`,
    canonical: CANONICAL,
    // invite links are one match's door, not a page to list
    robots: inviteLink ? "noindex, follow" : "index, follow",
  };
  return template
    .replace("{{structured}}", () => STRUCTURED_JSON)
    .replace(/\{\{(\w+)\}\}/g, (_, k: string) => esc(fields[k] ?? ""));
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
      if (path === "/" || path === "/index.html") {
        const page = Bun.file(resolve(root, "index.html"));
        if (!(await page.exists())) return new Response("not found", { status: 404 });
        const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host).split(",")[0].trim();
        const local = /^(localhost|127\.|\[::1\])/.test(host);
        const origin = `${local ? url.protocol.replace(":", "") : "https"}://${host}`;
        const code = (url.searchParams.get("room") ?? "").toUpperCase();
        const seat = /^[A-Z]{4}$/.test(code) ? rooms.get(code)?.seats[0] : undefined;
        const html = renderPage(await page.text(), origin, seat ? code : null, seat?.name ?? null, url.searchParams.has("room"));
        return new Response(html, { headers: { "content-type": TYPES.html, "cache-control": "no-cache", "x-content-type-options": "nosniff" } });
      }
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
