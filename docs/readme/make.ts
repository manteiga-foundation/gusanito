// Renders the README visuals from real matches on this machine:
//   docs/readme/match.gif   the hero (720 px, 10 fps, kept under 5 MB for the README): three phones playing one match, seen from player one's phone
//   docs/readme/match.mp4   the same clip at full frame rate
//   docs/readme/phones.jpg  invite, lobby and match side by side
// Usage: bun run build && bun docs/readme/make.ts [--takes 3]
// Needs ffmpeg. Each take is a fresh match; the clip comes from the take with the most damage dealt,
// so the README shows hits, not misses. Capture is a CDP screencast: an idle machine gives ~30 fps.
import { chromium, devices, type Page } from "playwright";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { startServer } from "../../src/server/server.ts";
import { GRAVITY, MAX_POWER } from "../../src/shared/constants.ts";

const OUT = join(import.meta.dir);
const takesArg = process.argv.indexOf("--takes");
const TAKES = takesArg > 0 ? Number(process.argv[takesArg + 1]) : 3;
const CLIP_MS = 8000;
const zoomArg = process.argv.indexOf("--zoom");
const ZOOM_IN = zoomArg > 0 ? Number(process.argv[zoomArg + 1]) : 120;
const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "gusanito-readme-"));

const server = startServer({ port: 0, staticDir: "dist", hostname: "127.0.0.1" });
const url = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch();
const phone = { ...devices["iPhone 13"], viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const portrait = { ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const snap = (p: Page) => p.evaluate(() => (window as any).__wriggle.snapshot());

async function open(device: typeof phone, path = "/") {
  const page = await (await browser.newContext(device)).newPage();
  await page.goto(url + path);
  return page;
}

/** Aim at the nearest opponent along a ballistic arc (gravity only; wind and wells bend it). */
async function shoot(p: Page, seat: number, weaponKey: string | null) {
  const s = await snap(p);
  if (!s) return;
  const me = s.worms.find((w: any) => w.id === s.seats[seat].active);
  const foes = s.worms.filter((w: any) => w.alive && w.team !== seat);
  if (!me?.alive || foes.length === 0) return;
  const foe = foes.sort((u: any, v: any) => Math.abs(u.x - me.x) - Math.abs(v.x - me.x))[0];
  const dx = foe.x - me.x;
  const up = me.y - foe.y;
  const x = Math.abs(dx);
  let theta = (52 * Math.PI) / 180;
  let denom = 2 * Math.cos(theta) ** 2 * (x * Math.tan(theta) - up);
  if (denom <= 0) {
    theta = (68 * Math.PI) / 180;
    denom = 2 * Math.cos(theta) ** 2 * (x * Math.tan(theta) - up);
  }
  const v = denom > 0 ? Math.sqrt((GRAVITY * x * x) / denom) : MAX_POWER;
  const power = Math.min(1, Math.max(0.2, v / MAX_POWER));
  if (weaponKey) await p.keyboard.press(weaponKey);
  const at = await p.evaluate(() => (window as any).__wriggle.activeScreen());
  const dir = Math.sign(dx) || 1;
  await p.mouse.click(at.x + dir * Math.cos(theta) * 90, at.y - Math.sin(theta) * 90);
  const box = (await p.locator("#fire").boundingBox())!;
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.down();
  await p.waitForTimeout(power * 1300);
  await p.mouse.up();
}

const teamHp = (s: any) => s.worms.reduce((t: number, w: any) => t + Math.max(0, w.hp), 0);

interface Take {
  dir: string;
  damage: number;
  frames: { file: string; t: number }[];
}

async function take(n: number, stills: boolean): Promise<Take> {
  const a = await open(phone);
  await a.fill("#name", "Ada");
  await a.tap("#create");
  await a.waitForSelector("#lobby:not([hidden])");
  const code = (await a.textContent("#room-code"))!.trim();
  if (stills) {
    const guest = await open(portrait, `/?room=${code}`);
    await guest.waitForSelector("#join-cta:not([hidden])");
    await guest.waitForTimeout(400);
    await guest.screenshot({ path: join(work, "invite.png") });
    await guest.context().close();
  }
  const pages = [a];
  for (const name of ["Bo", "Cy"]) {
    const p = await open(phone, `/?room=${code}`);
    await p.fill("#name", name);
    await p.tap("#join-cta");
    await p.waitForSelector("#lobby:not([hidden])");
    pages.push(p);
  }
  await a.waitForFunction(() => document.querySelectorAll("#seats .seat:not(.open)").length === 3);
  await pages[1].tap("#ready");
  await a.waitForTimeout(500);
  if (stills) {
    // this run serves from 127.0.0.1; show the link as players see it on the public site
    await a.evaluate((c) => (document.querySelector("#invite-link")!.textContent = `gusanito.manteiga.org/?room=${c}`), code);
    await a.screenshot({ path: join(work, "lobby.png") });
  }
  await pages[0].tap("#ready");
  await pages[2].tap("#ready");
  for (const p of pages) await p.waitForFunction(() => (window as any).__wriggle.snapshot()?.worms?.length === 9);
  await a.waitForTimeout(3300); // countdown

  const dir = join(work, `take-${n}`);
  mkdirSync(dir);
  const frames: Take["frames"] = [];
  const cdp = await a.context().newCDPSession(a);
  cdp.on("Page.screencastFrame", (f: any) => {
    const file = join(dir, `${String(frames.length).padStart(5, "0")}.jpg`);
    writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  // one zoom step closer than the default phone view, as a player would, so explosions read in the GIF
  await a.mouse.move(422, 195);
  await a.mouse.wheel(0, -ZOOM_IN);
  await a.waitForTimeout(400);
  const before = teamHp(await snap(a));
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 1688, maxHeight: 780 });
  const t0 = Date.now();
  // three volleys, everyone at once: rockets, then grenades, then a cluster from player one
  const volleys: (string | null)[][] = [
    ["Digit1", "Digit1", "Digit1"],
    ["Digit2", "Digit1", "Digit2"],
    ["Digit3", "Digit2", "Digit1"],
  ];
  for (const keys of volleys) {
    const start = Date.now();
    await Promise.all(pages.map((p, seat) => shoot(p, seat, keys[seat]).catch(() => {})));
    if (stills && keys === volleys[1]) {
      await pages[1].waitForTimeout(700);
      await pages[1].screenshot({ path: join(work, "match.png") });
    }
    const wait = 2300 - (Date.now() - start);
    if (wait > 0) await a.waitForTimeout(wait);
  }
  const rest = CLIP_MS - (Date.now() - t0);
  if (rest > 0) await a.waitForTimeout(rest);
  await cdp.send("Page.stopScreencast");
  const damage = before - teamHp(await snap(a));
  for (const p of pages) await p.context().close();
  return { dir, damage, frames };
}

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} failed:\n${r.stderr.slice(-2000)}`);
}

const takes: Take[] = [];
for (let i = 0; i < TAKES; i++) {
  const t = await take(i, i === 0);
  const span = (t.frames.at(-1)!.t - t.frames[0].t) || 1;
  console.log(`take ${i}: ${t.damage} damage, ${t.frames.length} frames, ${(t.frames.length / span).toFixed(1)} fps`);
  takes.push(t);
}
const best = takes.sort((x, y) => y.damage - x.damage)[0];
const fps = best.frames.length / ((best.frames.at(-1)!.t - best.frames[0].t) || 1);
if (fps < 20) console.warn(`warning: capture ran at ${fps.toFixed(1)} fps; an idle machine gives a smoother clip`);

// frames + real timestamps -> constant 30 fps MP4 -> 10 fps 720 px GIF with a shared palette
const concat = best.frames
  .map((f, i) => `file '${f.file}'\nduration ${((best.frames[i + 1]?.t ?? f.t + 1 / 30) - f.t).toFixed(4)}`)
  .join("\n");
writeFileSync(join(work, "frames.txt"), `ffconcat version 1.0\n${concat}\nfile '${best.frames.at(-1)!.file}'\n`);
const mp4 = join(OUT, "match.mp4");
run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(work, "frames.txt"), "-vf", "fps=30,scale=1280:-2:flags=lanczos", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24", "-movflags", "+faststart", mp4]);
const gif = join(OUT, "match.gif");
run("ffmpeg", ["-y", "-loglevel", "error", "-i", mp4, "-vf", "fps=10,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", "-loop", "0", gif]);

// three phones in one picture: share a link, everyone taps Ready, everyone plays at once
const b64 = async (f: string) => `data:image/png;base64,${Buffer.from(await Bun.file(join(work, f)).arrayBuffer()).toString("base64")}`;
const sheet = await (await browser.newContext({ viewport: { width: 1280, height: 600 }, deviceScaleFactor: 1.5 })).newPage();
await sheet.setContent(`<!doctype html><html><head><style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1280px; height: 600px; display: flex; align-items: center; justify-content: center; gap: 36px;
         background: radial-gradient(120% 140% at 70% 0%, #3a2c5c 0%, #1b1733 55%, #120f24 100%);
         font-family: ui-rounded, "SF Pro Rounded", system-ui, sans-serif; color: #fff4e6; }
  figure { display: flex; flex-direction: column; align-items: center; gap: 16px; }
  .device { border-radius: 30px; padding: 9px; background: #0b0918; box-shadow: 0 0 0 1.5px rgba(255,244,230,.14), 0 24px 60px rgba(0,0,0,.45); }
  .device img { display: block; border-radius: 22px; }
  .tall img { width: 222px; }
  .wide img { width: 420px; }
  .col { display: flex; flex-direction: column; gap: 30px; }
  figcaption { font-size: 17px; font-weight: 700; letter-spacing: .01em; }
  figcaption b { display: inline-grid; place-items: center; width: 24px; height: 24px; margin-right: 9px; border-radius: 50%;
                 background: #ffb454; color: #1b1733; font-size: 13px; vertical-align: 2px; }
  figcaption span { color: rgba(255,244,230,.68); font-weight: 600; }
</style></head><body>
  <figure><div class="device tall"><img src="${await b64("invite.png")}"></div><figcaption><b>1</b>Share a link <span>· friends tap Join</span></figcaption></figure>
  <div class="col">
    <figure><div class="device wide"><img src="${await b64("lobby.png")}"></div><figcaption><b>2</b>Everyone taps Ready <span>· up to six players</span></figcaption></figure>
    <figure><div class="device wide"><img src="${await b64("match.png")}"></div><figcaption><b>3</b>Everyone plays at once <span>· three minutes</span></figcaption></figure>
  </div>
</body></html>`);
await sheet.waitForTimeout(300);
await sheet.screenshot({ path: join(OUT, "phones.jpg"), type: "jpeg", quality: 86 });

await browser.close();
server.stop(true);
for (const f of ["match.gif", "match.mp4", "phones.jpg"]) console.log(`${f}: ${(statSync(join(OUT, f)).size / 1e6).toFixed(2)} MB`);
console.log(`best take: ${best.damage} damage at ${fps.toFixed(1)} fps; scratch frames in ${work} (${readdirSync(best.dir).length} files)`);
process.exit(0);
