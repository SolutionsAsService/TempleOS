// tosvm -- drive a TempleOS VM in QEMU from the host: the monitor socket (sendkey, screendump, quit),
// the screen read as text against the kernel's own font, and timed "play" scripts.
// Used by gamec.mjs (run, dist, play).  No HolyC is translated here; this only types and looks.

import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const need = (bin) => spawnSync("which", [bin]).status === 0;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the TempleOS screen as text: 8x8 cells matched against Kernel/FontStd.HC ------------------------
const FONT = resolve(HERE, "..", "..", "Kernel", "FontStd.HC");
const glyphs = new Map();
if (existsSync(FONT)) {
  const vals = [...readFileSync(FONT, "latin1").matchAll(/0x([0-9A-Fa-f]{16})/g)].slice(0, 256).map((m) => BigInt("0x" + m[1]));
  vals.forEach((v, ch) => {
    const key = Array.from({ length: 8 }, (_, r) => Number((v >> BigInt(8 * r)) & 255n)).join(",");
    const printable = ch >= 32 && ch < 127;
    if (!glyphs.has(key) || (printable && !(glyphs.get(key).charCodeAt(0) >= 32 && glyphs.get(key).charCodeAt(0) < 127)))
      glyphs.set(key, String.fromCharCode(ch));
  });
}
function popc(r) { let n = 0; while (r) { n += r & 1; r >>= 1; } return n; }
export function readPPM(path) {
  const b = readFileSync(path);
  const m = b.toString("latin1", 0, 64).match(/^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/);
  if (!m) return null;
  return { w: +m[1], h: +m[2], data: b.subarray(m[0].length) };
}
// dx, dy: a pixel offset, for text a game draws off the 8x8 grid
export function screenText(path, dx = 0, dy = 0) {
  const im = readPPM(path); if (!im) return "";
  const lines = [];
  for (let cy = 0; cy < ((im.h - dy) >> 3); cy++) {
    let line = "";
    for (let cx = 0; cx < ((im.w - dx) >> 3); cx++) {
      const cols = new Map();
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const o = ((cy * 8 + y + dy) * im.w + cx * 8 + x + dx) * 3;
        const c = (im.data[o] << 16) | (im.data[o + 1] << 8) | im.data[o + 2];
        if (!cols.has(c)) cols.set(c, new Array(8).fill(0));
        cols.get(c)[y] |= 1 << x;
      }
      let ch = " ";
      if (cols.size > 1) {
        ch = "░";
        const byInk = [...cols.values()].sort((a, b) => a.reduce((s, r) => s + popc(r), 0) - b.reduce((s, r) => s + popc(r), 0));
        for (const rows of byInk) {
          const g = glyphs.get(rows.join(",")) || (cols.size === 2 && glyphs.get(rows.map((r) => 255 ^ r).join(",")));
          if (g) { ch = g; break; }
        }
      }
      line += ch;
    }
    lines.push(line.trimEnd());
  }
  return lines.join("\n");
}
// all 64 grid offsets: text drawn anywhere (a game's GrPrint at any pixel) is found by one of them
export function screenTextAll(path) {
  const out = [];
  for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < 8; dx++) out.push(screenText(path, dx, dy));
  return out.join("\n");
}

// ---- one QEMU, driven through its monitor ------------------------------------------------------------
// launch: { bin, args } (spawned directly) -- the caller puts "-monitor unix:<sock>,server,nowait" in args.
export async function startVM({ bin, args, sock, shotDir, keep = false, quiet = false, cwd, env }) {
  rmSync(sock, { force: true });
  mkdirSync(shotDir, { recursive: true });
  if (!quiet) console.log(`tosvm: ${bin} ${args.join(" ")}`);
  const qemu = spawn(bin, args, { cwd, env: env || process.env, stdio: keep ? "ignore" : ["ignore", "inherit", "inherit"], detached: keep });
  let exited = false; qemu.on("exit", () => { exited = true; });
  const t0 = Date.now(), el = () => ((Date.now() - t0) / 1000).toFixed(0);

  let conn = null, buf = "", waiter = null;
  for (let i = 0; i < 100 && !conn && !exited; i++) {
    await sleep(200);
    if (!existsSync(sock)) continue;
    conn = await new Promise((res) => { const c = createConnection(sock); c.on("connect", () => res(c)); c.on("error", () => res(null)); });
  }
  if (!conn) { try { qemu.kill(); } catch {} throw new Error("no QEMU monitor (did QEMU start?)"); }
  conn.setEncoding("utf8");
  conn.on("error", () => {});
  conn.on("data", (d) => { buf += d; if (waiter && buf.includes("(qemu)")) { const w = waiter; waiter = null; const out = buf; buf = ""; w(out); } });
  await new Promise((r) => { waiter = r; if (buf.includes("(qemu)")) { waiter = null; buf = ""; r(); } });
  const mon = (c) => exited ? Promise.resolve("") : new Promise((r) => { waiter = r; conn.write(c + "\n"); setTimeout(() => { if (waiter === r) { waiter = null; r(""); } }, 10000); });

  const KEYS = { " ": "spc", "\n": "ret", "-": "minus", "=": "equal", "[": "bracket_left", "]": "bracket_right", ";": "semicolon",
    "'": "apostrophe", "`": "grave_accent", "\\": "backslash", ",": "comma", ".": "dot", "/": "slash", "\t": "tab" };
  const SHIFTED = { "!": "1", "@": "2", "#": "3", $: "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", _: "-", "+": "=",
    "{": "[", "}": "]", ":": ";", '"': "'", "~": "`", "|": "\\", "<": ",", ">": ".", "?": "/" };
  const keyName = (c) => /[a-z0-9]/.test(c) ? c : /[A-Z]/.test(c) ? "shift-" + c.toLowerCase()
    : KEYS[c] ? KEYS[c] : SHIFTED[c] ? "shift-" + (KEYS[SHIFTED[c]] || SHIFTED[c]) : null;
  async function type(s) { for (const c of s) { const k = keyName(c); if (k) await mon("sendkey " + k); await sleep(60); } }

  let shotN = 0;
  async function shot(name) {
    const ppm = join(shotDir, `${String(++shotN).padStart(2, "0")}-${name}.ppm`);
    await mon(`screendump ${ppm}`);
    await sleep(300);
    const text = existsSync(ppm) ? screenText(ppm) : "";
    if (existsSync(ppm)) writeFileSync(ppm.replace(/\.ppm$/, ".txt"), screenTextAll(ppm));
    if (need("convert") && existsSync(ppm)) { spawnSync("convert", [ppm, ppm.replace(/\.ppm$/, ".png")]); rmSync(ppm); }
    return text;
  }
  async function screen(all = false) {
    const ppm = join(shotDir, "now.ppm");
    await mon(`screendump ${ppm}`); await sleep(300);
    return existsSync(ppm) ? (all ? screenTextAll(ppm) : screenText(ppm)) : "";
  }
  async function waitScreen(re, limitSeconds, what, all = false) {
    const t1 = Date.now();
    while ((Date.now() - t1) / 1000 < limitSeconds && !exited) {
      const t = await screen(all);
      // a cell of background in two colours (scanlines, dithering) reads as \u2591, not a space: match both ways
      if (re.test(t) || re.test(t.replace(/\u2591/g, " "))) { console.log(`tosvm: [${el()}s] ${what}`); return true; }
      await sleep(2000);
    }
    console.log(`tosvm: [${el()}s] gave up waiting for ${what}`); return false;
  }
  async function quit() {          // power off at once, like pulling the plug: what is on the disk is what was written
    await mon("quit").catch(() => {});
    for (let i = 0; i < 50 && !exited; i++) await sleep(100);
    if (!exited) try { qemu.kill(); } catch {}
    try { conn.end(); } catch {}
  }
  function detach() { try { conn.end(); } catch {} qemu.unref(); }
  return { qemu, mon, type, shot, screen, waitScreen, quit, detach, el, exited: () => exited };
}

// ---- play scripts: one step a line --------------------------------------------------------------------
//   type <text, \n for Enter>       key <qemu key> [times]       wait <seconds>        shot <name>
//   waitscreen <seconds> <regex>    the screen text (all 64 grid offsets) must match within the time, else FAIL
//   keyuntil <key> <n> <regex>      press the key (up to n times, 3 s apart) until the screen matches, else FAIL
//   poweroff                        quit QEMU at once (no shutdown: proves what is already on the disk)
//   boot                            start the VM again with the same command (ctx.boot)
//   expect-file <path on the disk>  after poweroff: the file must exist (ctx.fileExists)
//   echo <text>                     print a line
// Lines starting with # are comments.  Returns the number of failed expectations.
export async function runPlay(lines, ctx) {
  let vm = ctx.vm, fails = 0;
  for (const raw of lines) {
    const line = raw.trim(); if (!line || line.startsWith("#")) continue;
    const [op, ...a] = line.split(" "), arg = a.join(" ");
    if (op === "type") await vm.type(arg.replace(/\\n/g, "\n"));
    else if (op === "key") for (let i = 0; i < Number(a[1] || 1); i++) { await vm.mon("sendkey " + a[0]); await sleep(Number(a[2] || 450)); }
    else if (op === "wait") await sleep(Number(arg) * 1000);
    else if (op === "shot") { await vm.shot(arg); console.log(`play: [${vm.el()}s] shot ${arg}`); }
    else if (op === "waitscreen") {
      const ok = await vm.waitScreen(new RegExp(a.slice(1).join(" "), "m"), Number(a[0]), `screen /${a.slice(1).join(" ")}/`, true);
      if (!ok) { fails++; console.log(`play: FAIL waitscreen ${arg}`); await vm.shot("fail"); }
    } else if (op === "keyuntil") {   // keyuntil <qemu key> <max presses> <regex>: press, look, again
      let ok = false;
      for (let i = 0; i < Number(a[1]) && !ok; i++) {
        await vm.mon("sendkey " + a[0]); await sleep(3000);
        const t = await vm.screen(true); const re = new RegExp(a.slice(2).join(" "), "m");
        ok = re.test(t) || re.test(t.replace(/\u2591/g, " "));
      }
      console.log(`play: [${vm.el()}s] ${ok ? "ok" : "FAIL"} keyuntil ${arg}`); if (!ok) { fails++; await vm.shot("fail"); }
    } else if (op === "poweroff") { await vm.quit(); console.log("play: powered off"); }
    else if (op === "boot") { vm = ctx.vm = await ctx.boot(); console.log("play: booted again"); }
    else if (op === "expect-file") {
      const ok = ctx.fileExists(arg);
      console.log(`play: ${ok ? "ok" : "FAIL"} expect-file ${arg}`); if (!ok) fails++;
    } else if (op === "echo") console.log(`play: ${arg}`);
    else { console.log(`play: unknown step "${line}"`); fails++; }
  }
  return fails;
}
