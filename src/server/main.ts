import { startServer } from "./server.ts";

const port = Number(process.env.PORT ?? 8080);
const s = startServer({ port, staticDir: process.env.STATIC_DIR ?? "dist" });
console.log(`wriggle listening on :${s.port}`);
