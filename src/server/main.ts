import { networkInterfaces } from "node:os";
import { startServer } from "./server.ts";
import { startupLines } from "./startup.ts";

const port = Number(process.env.PORT ?? 8080);
const s = startServer({ port, staticDir: process.env.STATIC_DIR ?? "dist" });
console.log(startupLines(s.port ?? port, networkInterfaces()).join("\n"));
