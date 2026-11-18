import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startupLines } from "../../src/server/startup.ts";

const ROOT = join(import.meta.dir, "../..");
const INSTALL_URL = "https://gusanito.manteiga.org/install.sh";
const script = readFileSync(join(ROOT, "install.sh"), "utf8");
const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "gusanito-install-"));
const tarball = join(work, "gusanito.tar.gz");
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;

beforeAll(() => {
  // a source archive shaped like GitHub's: one top folder holding the working tree
  const stage = join(work, "src");
  mkdirSync(join(stage, "gusanito-test"), { recursive: true });
  const files = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  const list = join(work, "files.txt");
  writeFileSync(list, files.filter((f) => existsSync(join(ROOT, f))).join("\n"));
  const copy = spawnSync("sh", ["-c", `tar -cf - -T "${list}" | tar -xf - -C "${join(stage, "gusanito-test")}"`], { cwd: ROOT });
  expect(copy.status).toBe(0);
  const pack = spawnSync("tar", ["--no-xattrs", "-czf", tarball, "-C", stage, "gusanito-test"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  expect(pack.status).toBe(0);
});

afterAll(() => {
  /* the temp folder is left for the OS to prune; deleting it here would need an approval prompt */
});

function home(name: string) {
  const h = join(work, name);
  mkdirSync(h, { recursive: true });
  return h;
}

function install(h: string, extra: Record<string, string> = {}) {
  const env = {
    HOME: h,
    SHELL: "/bin/zsh",
    PATH: `${join(process.execPath, "..")}:/usr/bin:/bin:/usr/sbin:/sbin`,
    GUSANITO_SOURCE: `file://${tarball}`,
    TMPDIR: work,
    ...extra,
  };
  const r = spawnSync("sh", [], { input: script, env, encoding: "utf8" });
  return { ...r, out: `${r.stdout}${r.stderr}` };
}

const launcher = (h: string) => join(h, ".local/bin/gusanito");

describe("one-command install", () => {
  test("installs a gusanito command that knows its version", () => {
    const h = home("basic");
    const r = install(h);
    expect(r.status).toBe(0);
    expect(existsSync(launcher(h))).toBe(true);
    expect(existsSync(join(h, ".gusanito/app/dist/index.html"))).toBe(true);
    const v = spawnSync(launcher(h), ["--version"], { encoding: "utf8", env: { HOME: h, PATH: process.env.PATH! } });
    expect(v.stdout.trim()).toBe(`gusanito ${version}`);
  });

  test("the installed command serves the game and says where to open it", async () => {
    const h = home("serve");
    expect(install(h).status).toBe(0);
    const port = 20000 + Math.floor(Math.random() * 20000);
    const proc = Bun.spawn([launcher(h), "--port", String(port)], { env: { HOME: h, PATH: process.env.PATH! }, stdout: "pipe", stderr: "pipe" });
    try {
      let health: Response | null = null;
      for (let i = 0; i < 50 && !health; i++) {
        await Bun.sleep(100);
        health = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
      }
      expect(health?.status).toBe(200);
      const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      expect(page).toContain("Gusanito");
    } finally {
      proc.kill();
    }
    const out = await new Response(proc.stdout).text();
    expect(out).toContain(`http://localhost:${port}`);
  }, 20000);

  test("the output is a few lines of the installer's own steps, ending with what to type", () => {
    const r = install(home("quiet"));
    const lines = r.out.trim().split("\n");
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(r.out).not.toMatch(/bun build|Bundled|\$ bun/);
    expect(r.out).toContain("gusanito");
  });

  test("the PATH line is written once, however often it is installed", () => {
    const h = home("twice");
    expect(install(h).status).toBe(0);
    expect(install(h).status).toBe(0);
    const rc = readFileSync(join(h, ".zshrc"), "utf8");
    expect(rc.split("\n").filter((l) => l.includes(".local/bin")).length).toBe(1);
  });

  test("a failed download leaves the installed copy working", () => {
    const h = home("failed");
    expect(install(h).status).toBe(0);
    const r = install(h, { GUSANITO_SOURCE: `file://${join(work, "missing.tar.gz")}` });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/download/i);
    expect(existsSync(join(h, ".gusanito/app/dist/index.html"))).toBe(true);
    const v = spawnSync(launcher(h), ["--version"], { encoding: "utf8", env: { HOME: h, PATH: process.env.PATH! } });
    expect(v.status).toBe(0);
  });

  test("a machine without Bun gets it from Bun's installer", () => {
    const h = home("nobun");
    const standIn = join(work, "bun-installer.sh");
    // stands in for https://bun.sh/install: puts bun where the real one does (~/.bun/bin/bun)
    writeFileSync(standIn, `#!/bin/sh\nmkdir -p "$HOME/.bun/bin"\nln -sf "${process.execPath}" "$HOME/.bun/bin/bun"\necho "######## 100%" >&2\n`);
    const r = install(h, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", GUSANITO_BUN_INSTALLER: `file://${standIn}` });
    expect(r.status).toBe(0);
    expect(r.out).not.toContain("####");
    expect(existsSync(join(h, ".bun/bin/bun"))).toBe(true);
    const v = spawnSync(launcher(h), ["--version"], { encoding: "utf8", env: { HOME: h, PATH: "/usr/bin:/bin" } });
    expect(v.stdout.trim()).toBe(`gusanito ${version}`);
  });

  test("by default it installs the latest GitHub release", async () => {
    const h = home("release");
    const gh: ReturnType<typeof Bun.serve> = Bun.serve({
      port: 0,
      fetch(req): Response {
        const p = new URL(req.url).pathname;
        if (p === "/manteiga-foundation/gusanito/releases/latest")
          return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${gh.port}/manteiga-foundation/gusanito/releases/tag/v9.9.9` } });
        if (p.endsWith("/releases/tag/v9.9.9")) return new Response("release page");
        if (p === "/manteiga-foundation/gusanito/archive/refs/tags/v9.9.9.tar.gz") return new Response(Bun.file(tarball));
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const env = {
        HOME: h,
        SHELL: "/bin/zsh",
        PATH: `${join(process.execPath, "..")}:/usr/bin:/bin:/usr/sbin:/sbin`,
        GUSANITO_GITHUB: `http://127.0.0.1:${gh.port}`,
        TMPDIR: work,
      };
      const p = Bun.spawn(["sh"], { stdin: new Blob([script]), env, stdout: "pipe", stderr: "pipe" });
      const code = await p.exited;
      const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
      expect(code).toBe(0);
      expect(out).toContain("v9.9.9");
    } finally {
      gh.stop(true);
    }
  }, 30000);

  test("one install URL everywhere: script header, update command, README", () => {
    const oneLiner = `curl -fsSL ${INSTALL_URL} | sh`;
    expect(script).toContain(oneLiner);
    expect(script).toMatch(new RegExp(`update\\)[\\s\\S]*${INSTALL_URL.replace(/[.]/g, "\\.")}`));
    expect(readFileSync(join(ROOT, "README.md"), "utf8")).toContain(oneLiner);
  });

  test("the game server shares the installer from its own address", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts.build).toContain("install.sh");
  });
});

describe("startup message", () => {
  test("names this computer's address and the Wi-Fi address phones can open", () => {
    const lines = startupLines(8080, {
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never],
      en0: [{ address: "192.168.1.20", family: "IPv4", internal: false } as never, { address: "fe80::1", family: "IPv6", internal: false } as never],
    });
    const text = lines.join("\n");
    expect(text).toContain("http://localhost:8080");
    expect(text).toContain("http://192.168.1.20:8080");
    expect(text).not.toContain("fe80");
  });

  test("without a network it still names this computer", () => {
    const text = startupLines(9000, {}).join("\n");
    expect(text).toContain("http://localhost:9000");
  });
});
