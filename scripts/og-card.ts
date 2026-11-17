// Renders public/og-card.jpg (1200x630 link preview) from a real match scene.
import { chromium } from "playwright";
import { startServer } from "../src/server/server.ts";

const server = startServer({ port: 0, staticDir: "dist", hostname: "127.0.0.1" });
const url = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch();
const view = { viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 };
const a = await (await browser.newContext(view)).newPage();
const b = await (await browser.newContext(view)).newPage();
await a.goto(url + "/?hud=bar");
await a.fill("#name", "Ada");
await a.click("#create");
await a.waitForSelector("#lobby:not([hidden])");
const code = (await a.textContent("#room-code"))!.trim();
await b.goto(`${url}/?room=${code}`);
await b.fill("#name", "Bo");
await b.click("#join");
await a.waitForFunction(() => document.querySelector('[data-seat="1"] .seat-name')?.textContent === "Bo");
await a.click("#ready");
await b.waitForFunction(() => document.querySelector('[data-seat="0"]')?.classList.contains("is-ready"));
await b.click("#ready");
await a.waitForFunction(() => (window as any).__wriggle.snapshot()?.worms?.length === 6);
await b.waitForFunction(() => (window as any).__wriggle.snapshot()?.worms?.length === 6);
await b.waitForTimeout(2500);
// player two is not on turn, so a drag pans: zoom out a little and slide the field right of the title
const shot = b;
await shot.mouse.move(600, 315);
await shot.mouse.wheel(0, 140);
await shot.waitForTimeout(200);
await shot.mouse.move(500, 300);
await shot.mouse.down();
await shot.mouse.move(800, 270, { steps: 8 });
await shot.mouse.up();
await shot.addStyleTag({ content: `
  #hud, #conn { display: none !important; }
  .og { position: fixed; inset: 0; z-index: 50; pointer-events: none;
        background: linear-gradient(90deg, rgba(20,15,38,.9) 0%, rgba(20,15,38,.72) 38%, rgba(20,15,38,0) 66%); }
  .og-in { position: absolute; left: 72px; top: 0; bottom: 0; display: flex; flex-direction: column; justify-content: center; gap: 18px; width: 560px; }
  .og-eyebrow { font: 800 16px var(--font); letter-spacing: .2em; text-transform: uppercase; color: var(--ink-dim); }
  .og-mark { font: 800 128px/1.08 var(--font); padding-bottom: 0.06em; letter-spacing: -0.03em; margin: 0;
             background: linear-gradient(100deg, var(--p1), var(--gold) 50%, var(--p2)); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .og-sub { font: 600 27px/1.35 var(--font); color: var(--ink); margin: 0; }
  .og-chip { align-self: flex-start; font: 800 20px var(--font); color: #2a1a10; padding: 12px 20px; border-radius: 14px;
             background: linear-gradient(180deg, var(--gold), var(--gold-deep)); }
  .og-foot { position: absolute; left: 72px; bottom: 40px; font: 800 14px var(--font); letter-spacing: .22em; text-transform: uppercase; color: var(--ink-faint); }
` });
await shot.evaluate(() => {
  const d = document.createElement("div");
  d.className = "og";
  d.innerHTML = `<div class="og-in"><div class="og-eyebrow">Two-player artillery</div><h1 class="og-mark">Wriggle</h1>
    <p class="og-sub">Destructible ground, shifting wind and gravity wells that bend every shot.</p>
    <div class="og-chip">Tap the link to join the match</div></div>
    <div class="og-foot">A Manteiga Foundation game</div>`;
  document.body.appendChild(d);
});
await shot.waitForTimeout(300);
await shot.screenshot({ path: "public/og-card.jpg", type: "jpeg", quality: 86 });
await browser.close();
server.stop(true);
console.log("wrote public/og-card.jpg");
