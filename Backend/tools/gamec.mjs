#!/usr/bin/env node
// gamec -- host-side driver of the HolyC game backend.
//
//   node Backend/tools/gamec.mjs check <game-dir>            lint + manifest + include graph
//   node Backend/tools/gamec.mjs build <game-dir> [out.img]  check, stage, and write a FAT32 hard-disk image
//   node Backend/tools/gamec.mjs run   <game-dir> [out.img] --tos <TempleOS.ISO> [options]
//        boot the live CD in QEMU headless, type MountIDEAuto and #include "C:/AUTOTEST" through the QEMU
//        monitor, read COM1 (serial.log) for the verdict and the whole terminal text (compiler messages).
//        --seconds N        whole-run limit (default 900)       --boot-seconds N  boot limit (default 400)
//        --out DIR          serial log, monitor socket          --shots DIR       screenshots (PNG with ImageMagick)
//        --exec "<HolyC>"   run this instead of the manifest's tests (e.g. '#include "::/Home/Game/Load"')
//        --counter NAME     the fail counter to report with --exec
//        --play FILE        after a PASS, drive the game: lines "type <text>", "key <qemu key> [n]", "wait <s>", "shot <name>"
//        --keep             leave the VM running (monitor socket in --out) for driving by hand
//
// The compiler is TempleOS's own. This tool never translates HolyC; it only decides whether a tree is fit
// to be handed to that compiler, and it carries the tree to it.
//
// Exit codes: 0 pass, 1 check failed, 2 tooling missing or bad usage, 3 TempleOS verdict failed.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync, copyFileSync, openSync, writeSync, closeSync } from "node:fs";
import { join, dirname, basename, extname, resolve, relative } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = resolve(HERE, "..", "Lib");
const DISC_EXT = new Set([".HC", ".HH", ".DD", ".TXT", ".DAT"]); // what TempleOS can use from a disc

const [cmd, gameArg, ...rest] = process.argv.slice(2);
const flag = (n, d) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : d; };

function usage() {
  console.error("usage: gamec check|build|run <game-dir> [out.iso | --tos TempleOS.ISO --seconds N]");
  process.exit(2);
}
if (!["check", "build", "run"].includes(cmd) || !gameArg) usage();
const GAME = resolve(gameArg);

// ---- HolyC lexing, just enough to lint without false hits ---------------------------------------
export function strip(code) {
  let out = "", i = 0;
  while (i < code.length) {
    const c = code[i], d = code[i + 1];
    if (c === "/" && d === "/") { while (i < code.length && code[i] !== "\n") i++; }
    else if (c === "/" && d === "*") { i += 2; while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) i++; i += 2; }
    else if (c === '"' || c === "'") {
      const q = c; i++;
      while (i < code.length && code[i] !== q) { if (code[i] === "\\") i++; i++; }
      i++; out += '""';
    } else { out += c; i++; }
  }
  return out;
}

const fails = [], notes = [];
const fail = (m) => fails.push(m);

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc); else acc.push(p);
  }
  return acc;
}

// ---- manifest ------------------------------------------------------------------------------------
const manifestPath = join(GAME, "shadw.json");
if (!existsSync(manifestPath)) { console.error(`no shadw.json in ${GAME}`); process.exit(2); }
const M = JSON.parse(readFileSync(manifestPath, "utf8"));
for (const k of ["id", "title", "version", "language", "entry", "load", "install_path", "runtime"])
  if (!(k in M)) fail(`manifest: missing "${k}"`);
if (M.language !== "HolyC") fail(`manifest: language is "${M.language}", this backend builds HolyC only`);
if (M.runtime && !/TempleOS/.test(M.runtime.os || "")) fail("manifest: runtime.os must name TempleOS");
for (const k of ["entry", "load"]) if (M[k] && !existsSync(join(GAME, M[k]))) fail(`manifest: ${k} file ${M[k]} not found`);

// ---- lint ----------------------------------------------------------------------------------------
const sources = walk(GAME).filter((f) => [".HC", ".HH"].includes(extname(f).toUpperCase()));
let lineCount = 0;
const incGraph = new Map();
for (const f of sources) {
  const code = readFileSync(f, "utf8"), bare = strip(code), n = relative(GAME, f);
  lineCount += code.split("\n").length;
  if (bare.includes("?")) fail(`${n}: '?' outside a string (HolyC has no ternary)`);
  if (/\bconst\b/.test(bare)) fail(`${n}: 'const' is not HolyC`);
  if (/\bcontinue\b/.test(bare)) fail(`${n}: 'continue' is not HolyC (use goto to a label before the loop's closing brace)`);
  code.split("\n").forEach((l, i) => { // TempleOS lexes source as DolDoc: a lone "$" opens a command up to the next "$"
    if (l.replace(/\$\$/g, "").includes("$")) fail(`${n}:${i + 1}: lone '$' (DolDoc command); write '$$' for one '$'`);
  });
  for (const [o, c] of [["{", "}"], ["(", ")"], ["[", "]"]]) {
    const a = bare.split(o).length, b = bare.split(c).length;
    if (a !== b) fail(`${n}: '${o}' ${a - 1} vs '${c}' ${b - 1}`);
  }
  const deps = [];
  for (const m of code.matchAll(/^\s*#include\s+"([^"]+)"/gm)) {
    const target = m[1];
    if (target.startsWith("::/")) continue; // an absolute TempleOS path, resolved at install time
    const p = join(dirname(f), target);
    const hit = [p, p + ".HC", p + ".HH"].find((x) => existsSync(x) && statSync(x).isFile());
    if (!hit) fail(`${n}: include "${target}" not found`); else deps.push(hit);
  }
  incGraph.set(f, deps);
}
// every source file should be reachable from the load file or be a test
const reach = new Set();
(function visit(f) { if (reach.has(f)) return; reach.add(f); for (const d of incGraph.get(f) || []) visit(d); })(join(GAME, M.load || "Load.HC"));
for (const f of sources) {
  const n = relative(GAME, f);
  if (!reach.has(f) && !/^Tests[\\/]/.test(n) && basename(f) !== (M.entry || "Run.HC"))
    notes.push(`${n}: not reachable from ${M.load} (dead file or test-only)`);
}
// 8.3 names on everything that goes on the disk ("disc_exclude" in shadw.json names host-only folders)
const EXCLUDE = new Set(M.disc_exclude || []);
const onDisk = (rel) => !rel.split(/[\\/]/).some((p) => EXCLUDE.has(p));
for (const f of walk(GAME)) {
  if (!DISC_EXT.has(extname(f).toUpperCase()) || !onDisk(relative(GAME, f))) continue;
  const stem = basename(f, extname(f));
  if (stem.length > 8) fail(`${relative(GAME, f)}: name longer than 8.3`);
  for (const part of relative(GAME, dirname(f)).split(/[\\/]/).filter(Boolean))
    if (part.length > 8) fail(`${relative(GAME, f)}: directory "${part}" longer than 8 characters`);
}

console.log(`gamec: ${M.title} ${M.version} (${M.id}) -- ${sources.length} HolyC files, ${lineCount} lines`);
for (const n of notes) console.log(`  note: ${n}`);
if (fails.length) { for (const f of fails) console.log(`  FAIL: ${f}`); console.log(`gamec: check FAILED (${fails.length})`); process.exit(1); }
console.log("gamec: check PASS (host rules only; only gamec run asks the TempleOS compiler)");
if (cmd === "check") process.exit(0);

// ---- build: stage and make the disk --------------------------------------------------------------
// TempleOS V5.03 cannot read files from an ISO9660 disc (FSt_ISO9660 is "Not Supported": the kernel's
// file calls dispatch only RedSea and FAT32; Kernel/BlkDev/DskFile.HC).  So the game travels on a small
// hard-disk image: an MBR with one FAT32 partition, made with mkfs.fat and mcopy (dosfstools, mtools).
// MountIDEAuto mounts it as C: in the live CD.  Its layout is the install layout:
//   /Home/Backend/Lib/...   /Home/<Game>/...   /INSTALL.HC   /AUTOTEST.HC
const need = (bin) => spawnSync("which", [bin]).status === 0;
for (const bin of ["mkfs.fat", "mcopy", "mmd"])
  if (!need(bin)) { console.error(`gamec: ${bin} is not installed (apt-get install dosfstools mtools)`); process.exit(2); }

const OUT = resolve(rest[0] && !rest[0].startsWith("--") ? rest[0] : join(GAME, "..", `${M.id}.img`));
const STAGE = join(dirname(OUT), `.stage-${M.id}`);
rmSync(STAGE, { recursive: true, force: true });
const installRel = M.install_path.replace(/\\/g, "/").replace(/^::\//, ""); // e.g. Home/HolyTemple
if (!/^Home\/[^/]+$/.test(installRel)) { console.error(`gamec: install_path must be ::/Home/<Name>, not ${M.install_path}`); process.exit(2); }

let stagedBytes = 0;
function stageTree(src, dst) {
  for (const f of walk(src)) {
    if (!DISC_EXT.has(extname(f).toUpperCase())) continue;
    const rel = relative(src, f);
    if (src === GAME && !onDisk(rel)) continue;
    const to = join(dst, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(f, to);
    stagedBytes += statSync(f).size;
  }
}
stageTree(LIB, join(STAGE, "Home", "Backend", "Lib"));
stageTree(GAME, join(STAGE, installRel));

const hc = (s) => s.replace(/\r?\n/g, "\n");
// INSTALL.HC: for a TempleOS that is installed on its own drive: attach this disk, MountIDEAuto (or Mount),
// then #include "D:/INSTALL" (the letter the mount reports).
writeFileSync(join(STAGE, "INSTALL.HC"), hc(`//Generated by gamec.  Attach this disk, mount it, then:  #include "D:/INSTALL"  (its letter)
Cd(__DIR__);;
CopyTree("Home/Backend","::/Home/Backend");
CopyTree("${installRel}","${M.install_path}");
"Installed ${M.title} ${M.version}\\n";
`));
// AUTOTEST.HC: for the live CD.  Its boot drive (T:) is read only, so this disk becomes the boot drive and home:
// the files are then already where ::/Home/... says.  Compile and test inside ExePutS, so a compile error is
// caught, and send the whole terminal text to COM1 at the end: every compiler message reaches the host.
const testCmd = flag("--exec") || (M.tests && (M.tests.templeos_auto || M.tests.templeos)) || "";
const counter = flag("--counter") || (flag("--exec") ? "0" : (M.tests && M.tests.fail_counter) || "");
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const body = `${testCmd}${/;\s*$/.test(testCmd) ? "" : ";"}\n${counter ? `HostDone(${counter});` : 'HostLog("BACKEND_UNCOUNTED");'}\n`;
writeFileSync(join(STAGE, "AUTOTEST.HC"), hc(`//Generated by gamec.  In the live CD:  MountIDEAuto;  then  #include "C:/AUTOTEST"
blkdev.boot_drv_let=blkdev.first_hd_drv_let;;
HomeSet("::/Home");;
Cd(__DIR__);;
#include "::/Home/Backend/Lib/Load"
F64 backend_t0=tS;
HostLog("BACKEND_BEGIN ${M.id} ${M.version}");
try
  ExePutS("${esc(body)}");
catch {
  HostLogI("BACKEND_EXCEPT",Fs->except_ch);
  Fs->catch_except=TRUE;
}
HostLogI("BACKEND_SECONDS",ToI64(tS-backend_t0));
HostDocDump;
HostLog("BACKEND_END");; //the second ";" lets the shell run the line before it without waiting for more input
`));

function writeDisk(out, stage) {
  // Size: the files, plus room for TempleOS to write saves and logs, rounded to whole MB; at least 64 MB so
  // the FAT32 partition has more than 65,525 clusters at one sector per cluster.
  const mb = Math.max(64, Math.ceil((stagedBytes * 2) / 1048576) + 32);
  const total = mb * 2048, start = 2048, size = total - start;
  rmSync(out, { force: true });
  writeFileSync(out, Buffer.alloc(0));
  spawnSync("truncate", ["-s", `${mb}M`, out]);
  const mbr = Buffer.alloc(512);
  const e = 446;
  mbr[e] = 0x00; mbr[e + 1] = 0xfe; mbr[e + 2] = 0xff; mbr[e + 3] = 0xff; // CHS: use LBA
  mbr[e + 4] = 0x0c; // FAT32 LBA (MBR_PT_FAT32*)
  mbr[e + 5] = 0xfe; mbr[e + 6] = 0xff; mbr[e + 7] = 0xff;
  mbr.writeUInt32LE(start, e + 8); mbr.writeUInt32LE(size, e + 12);
  mbr[510] = 0x55; mbr[511] = 0xaa;
  const fd = openSync(out, "r+"); writeSync(fd, mbr, 0, 512, 0); closeSync(fd);
  let r = spawnSync("mkfs.fat", ["-F", "32", "-s", "1", "-S", "512", "-n", "HOLYGAME", "--offset", String(start), out, String(size / 2)], { encoding: "utf8" });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
  const img = `${out}@@${start * 512}`;
  const items = readdirSync(stage).map((n) => join(stage, n));
  r = spawnSync("mcopy", ["-s", "-Q", "-i", img, ...items, "::/"], { encoding: "utf8", env: { ...process.env, MTOOLS_SKIP_CHECK: "1" } });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
}
writeDisk(OUT, STAGE);
rmSync(STAGE, { recursive: true, force: true });
console.log(`gamec: wrote ${OUT} (${statSync(OUT).size} bytes, FAT32, ${stagedBytes} bytes of files)`);
if (cmd === "build") process.exit(0);

// ---- run: boot the TempleOS live CD in QEMU, type the commands, collect the serial log --------------
const tos = flag("--tos");
if (!tos || !existsSync(tos)) {
  console.error("gamec: run needs --tos <TempleOS ISO>. None was supplied, so nothing was run and nothing is verified.");
  process.exit(2);
}
if (!need("qemu-system-x86_64")) { console.error("gamec: qemu-system-x86_64 is not installed"); process.exit(2); }
const seconds = Number(flag("--seconds", "900"));        // the whole run, boot included; no KVM is slow
const bootSeconds = Number(flag("--boot-seconds", "400"));
const keep = rest.includes("--keep");                     // leave the VM running for hand driving
const runDir = resolve(flag("--out", dirname(OUT)));
mkdirSync(runDir, { recursive: true });
const log = join(runDir, `${M.id}.serial.log`);
const sock = join(runDir, `${M.id}.mon.sock`);
const shotDir = resolve(flag("--shots", join(runDir, "shots")));
mkdirSync(shotDir, { recursive: true });
rmSync(log, { force: true }); rmSync(sock, { force: true });

// The TempleOS screen as text: 8x8 cells matched against the kernel's own font (Kernel/FontStd.HC).
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
function readPPM(path) {
  const b = readFileSync(path);
  const m = b.toString("latin1", 0, 64).match(/^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/);
  if (!m) return null;
  return { w: +m[1], h: +m[2], data: b.subarray(m[0].length) };
}
function screenText(path) {
  const im = readPPM(path); if (!im) return "";
  const lines = [];
  for (let cy = 0; cy < (im.h >> 3); cy++) {
    let line = "";
    for (let cx = 0; cx < (im.w >> 3); cx++) {
      const cols = new Map();
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const o = ((cy * 8 + y) * im.w + cx * 8 + x) * 3;
        const c = (im.data[o] << 16) | (im.data[o + 1] << 8) | im.data[o + 2];
        if (!cols.has(c)) cols.set(c, new Array(8).fill(0));
        cols.get(c)[y] |= 1 << x;
      }
      let ch = " ";
      if (cols.size > 1) {
        ch = "\u2591";
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
function popc(r) { let n = 0; while (r) { n += r & 1; r >>= 1; } return n; }

// QEMU monitor over a unix socket: screendump and sendkey.
import("node:net").then(async ({ createConnection }) => {
  const hd = OUT;
  const args = ["-m", "1024", "-smp", "2", "-display", "none", "-vga", "std",
    "-cdrom", tos, "-drive", `file=${hd},format=raw,index=0,media=disk`, "-boot", "d",
    "-serial", `file:${log}`, "-monitor", `unix:${sock},server,nowait`, "-no-reboot"];
  if (existsSync("/dev/kvm")) args.push("-enable-kvm", "-cpu", "host");
  console.log(`gamec: qemu-system-x86_64 ${args.join(" ")}`);
  const qemu = spawn("qemu-system-x86_64", args, { stdio: keep ? "ignore" : ["ignore", "inherit", "inherit"], detached: keep });
  let qemuExited = false; qemu.on("exit", () => { qemuExited = true; });
  const t0 = Date.now(), el = () => ((Date.now() - t0) / 1000).toFixed(0);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let conn = null, buf = "", waiter = null;
  for (let i = 0; i < 50 && !conn; i++) {
    await sleep(200);
    if (!existsSync(sock)) continue;
    conn = await new Promise((res) => { const c = createConnection(sock); c.on("connect", () => res(c)); c.on("error", () => res(null)); });
  }
  if (!conn) { console.error("gamec: no QEMU monitor"); qemu.kill(); process.exit(2); }
  conn.setEncoding("utf8");
  conn.on("data", (d) => { buf += d; if (waiter && buf.includes("(qemu)")) { const w = waiter; waiter = null; const out = buf; buf = ""; w(out); } });
  await new Promise((r) => { waiter = r; if (buf.includes("(qemu)")) { waiter = null; buf = ""; r(); } });
  const mon = (c) => new Promise((r) => { waiter = r; conn.write(c + "\n"); });

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
    if (need("convert") && existsSync(ppm)) { spawnSync("convert", [ppm, ppm.replace(/\.ppm$/, ".png")]); rmSync(ppm); }
    return text;
  }
  async function screen() {
    const ppm = join(shotDir, "now.ppm");
    await mon(`screendump ${ppm}`); await sleep(300);
    return existsSync(ppm) ? screenText(ppm) : "";
  }
  async function waitScreen(re, limit, what) {
    while ((Date.now() - t0) / 1000 < limit && !qemuExited) {
      const t = await screen();
      if (re.test(t)) { console.log(`gamec: [${el()}s] ${what}`); return true; }
      await sleep(3000);
    }
    console.log(`gamec: [${el()}s] gave up waiting for ${what}`); return false;
  }
  const serial = () => (existsSync(log) ? readFileSync(log, "latin1") : "");
  let verdict = "NONE";
  try {
    if (!(await waitScreen(/Install onto hard drive/, bootSeconds, "live CD booted, install prompt"))) throw new Error("boot");
    await shot("boot");
    await type("n");
    await waitScreen(/Take Tour/, bootSeconds, "tour prompt"); await type("n");
    await waitScreen(/Tour\(y or n\)\? NO[\s\S]*^\S*Home>( {2,}|$)/m, bootSeconds, "shell prompt");
    await type("MountIDEAuto;\n");
    await waitScreen(/MountIDEAuto;[\s\S]*^\S*Home>( {2,}|$)/m, bootSeconds, "game disk mounted");
    await type('#include "C:/AUTOTEST"\n');
    await shot("autotest");
    let lastShot = Date.now();
    while ((Date.now() - t0) / 1000 < seconds && !qemuExited) {
      const s = serial();
      if (/BACKEND_END/.test(s)) break;
      if (Date.now() - lastShot > 60000) { await shot(`t${el()}`); lastShot = Date.now(); }
      await sleep(2000);
    }
    await shot("end");
    // --play <file>: drive the game after the verdict, one step a line:  type <text, \n for Enter> | key <qemu key> [times]
    // | wait <seconds> | shot <name>.  Lines starting with # are comments.
    const play = flag("--play");
    if (play && /BACKEND_OK/.test(serial())) {
      for (const line of readFileSync(play, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))) {
        const [op, ...a] = line.split(" "), arg = a.join(" ");
        if (op === "type") await type(arg.replace(/\\n/g, "\n"));
        else if (op === "key") for (let i = 0; i < Number(a[1] || 1); i++) { await mon("sendkey " + a[0]); await sleep(450); }
        else if (op === "wait") await sleep(Number(arg) * 1000);
        else if (op === "shot") { const t = await shot(arg); console.log(`gamec: [${el()}s] shot ${arg}: ${(t.split("\n")[0].match(/FPS:\s*\d+/) || ["FPS:?"])[0]}`); }
      }
    }
  } catch (e) { await shot("stuck").catch(() => {}); }
  const text = serial();
  // The terminal dump carries DolDoc commands ($FG,4$ ...): strip them for the console.
  // Links to source keep their place as [file,line].
  const plain = text.replace(/\$\$/g, "\u0000")
    .replace(/\$LK,"([^"]*)"(?:,A="FL:([^"]*)")?\$/g, (_, t, a) => `[${a || t.replace(/^FL:/, "")}]`)
    .replace(/\$[^$\n]*\$/g, "").replace(/\u0000/g, "$");
  writeFileSync(log.replace(/\.serial\.log$/, ".serial.txt"), plain);
  console.log(plain.trim() || "(serial log empty)");
  if (/BACKEND_OK/.test(text)) verdict = "PASS";
  else if (/BACKEND_FAIL/.test(text)) verdict = "FAIL";
  else if (/BACKEND_END/.test(text)) verdict = "ABORTED (compile error or exception; see the terminal text above)";
  else verdict = "NONE (no BACKEND_END line before the timeout)";
  console.log(`gamec: [${el()}s] TempleOS verdict ${verdict}; serial ${log}; screenshots ${shotDir}`);
  if (keep) { console.log(`gamec: VM left running (pid ${qemu.pid}); monitor ${sock}`); conn.end(); qemu.unref(); process.exit(verdict === "PASS" ? 0 : 3); }
  qemu.kill(); conn.end();
  process.exit(verdict === "PASS" ? 0 : 3);
});
