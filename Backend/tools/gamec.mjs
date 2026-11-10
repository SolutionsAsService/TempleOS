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
//   node Backend/tools/gamec.mjs dist  <game-dir> [dist-dir] --tos <TempleOS.ISO> [--readme FILE] [--notice FILE] [--cache DIR]
//        a release bundle: dist-dir/<Name>-<version>/ with <Name>.img (TempleOS installed + the game, starts it at boot),
//        <Name>-install.img (the game disk for TempleOS users, INSTALL.HC), run.sh, run.bat (QEMU), setup-virtualbox.sh/.bat
//        (VirtualBox), README.txt, SHA256SUMS.txt; and a zip beside it.
//        The TempleOS install is made once from the ISO in QEMU (its own VMInstall) and cached (--cache, ~/.cache/gamec).
//   node Backend/tools/gamec.mjs play  <game-dir> <bundle-dir> --script FILE [--shots DIR] [--seconds N]
//        boot a bundle with its own run.sh, headless, and drive it with a play script (see tosvm.mjs runPlay):
//        waitscreen, key, type, shot, poweroff, boot, expect-file.  Exit 0 only when every expectation held.
//
// The compiler is TempleOS's own. This tool never translates HolyC; it only decides whether a tree is fit
// to be handed to that compiler, and it carries the tree to it.
//
// Exit codes: 0 pass, 1 check failed, 2 tooling missing or bad usage, 3 TempleOS verdict failed.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync, copyFileSync, openSync, writeSync, readSync, closeSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, basename, extname, resolve, relative } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startVM, runPlay, sleep } from "./tosvm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = resolve(HERE, "..", "Lib");
const DISC_EXT = new Set([".HC", ".HH", ".DD", ".TXT", ".DAT", ".PRJ"]); // what TempleOS can use from a disc

const [cmd, gameArg, ...rest] = process.argv.slice(2);
const flag = (n, d) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : d; };

function usage() {
  console.error("usage: gamec check|build|run|dist|play <game-dir> [out.img | dist-dir | bundle-dir] [--tos TempleOS.ISO ...]");
  process.exit(2);
}
if (!["check", "build", "run", "dist", "play"].includes(cmd) || !gameArg) usage();
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
  if (!reach.has(f) && !/^Tests[\\/]/.test(n) && basename(f) !== (M.entry || "Run.HC") && !/^(INSTALL|UNINSTAL)\.HC$/i.test(n))
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
if (cmd === "play") process.exit(await playBundle());

// ---- build: stage and make the disk --------------------------------------------------------------
// TempleOS V5.03 cannot read files from an ISO9660 disc (FSt_ISO9660 is "Not Supported": the kernel's
// file calls dispatch only RedSea and FAT32; Kernel/BlkDev/DskFile.HC).  So the game travels on a small
// hard-disk image: an MBR with one FAT32 partition, made with mkfs.fat and mcopy (dosfstools, mtools).
// MountIDEAuto mounts it as C: in the live CD.  Its layout is the install layout:
//   /Home/Backend/Lib/...   /Home/<Game>/...   /INSTALL.HC   /AUTOTEST.HC
const need = (bin) => spawnSync("which", [bin]).status === 0;
for (const bin of ["mkfs.fat", "mcopy", "mmd"])
  if (!need(bin)) { console.error(`gamec: ${bin} is not installed (apt-get install dosfstools mtools)`); process.exit(2); }

const installRel = M.install_path.replace(/\\/g, "/").replace(/^::\//, ""); // e.g. Home/HolyTemple
if (!/^Home\/[^/]+$/.test(installRel)) { console.error(`gamec: install_path must be ::/Home/<Name>, not ${M.install_path}`); process.exit(2); }
const NAME = basename(installRel);                                   // e.g. HolyTemple
const posArg = rest[0] && !rest[0].startsWith("--") ? rest[0] : null;
const DIST_ROOT = resolve(posArg || join(GAME, "dist"));
const BUNDLE = join(DIST_ROOT, `${NAME}-${M.version}`);
if (cmd === "dist") { rmSync(BUNDLE, { recursive: true, force: true }); mkdirSync(BUNDLE, { recursive: true }); }
const OUT = cmd === "dist" ? join(BUNDLE, `${NAME}-install.img`) : resolve(posArg || join(GAME, "..", `${M.id}.img`));
const STAGE = join(dirname(OUT), `.stage-${M.id}`);
rmSync(STAGE, { recursive: true, force: true });

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
// A game that ships its own INSTALL.HC (a launcher, an uninstaller) gets it run from the disk; it copies itself.
const gameInstall = existsSync(join(GAME, "INSTALL.HC"));
// __DIR__ is empty for a file in a drive's root (Compiler/CMisc.HC StreamDir: DirFile gives NULL; found in TempleOS,
// "Missing expression" at Cd(__DIR__)), so the disk's drive letter is taken from __FILE__ and every path is absolute.
writeFileSync(join(STAGE, "INSTALL.HC"), hc(`//Generated by gamec.  Attach this disk, mount it, then:  #include "D:/INSTALL"  (its letter)
U0 GamecInstall(U8 drv)
{
  U8 *s;
  s=MStrPrint("%C:/Home/Backend",drv);
  CopyTree(s,"::/Home/Backend");
  Free(s);
${gameInstall ? `  s=MStrPrint("%C:/${installRel}/INSTALL.HC",drv);
  ExeFile(s);
  Free(s);` : `  s=MStrPrint("%C:/${installRel}",drv);
  CopyTree(s,"${M.install_path}");
  Free(s);
  "Installed ${M.title} ${M.version}\\n";`}
}
GamecInstall(*__FILE__);;
`));
// AUTOTEST.HC (not in a dist): for the live CD.  Its boot drive (T:) is read only, so this disk becomes the boot drive and home:
// the files are then already where ::/Home/... says.  Compile and test inside ExePutS, so a compile error is
// caught, and send the whole terminal text to COM1 at the end: every compiler message reaches the host.
const testCmd = flag("--exec") || (M.tests && (M.tests.templeos_auto || M.tests.templeos)) || "";
const counter = flag("--counter") || (flag("--exec") ? "0" : (M.tests && M.tests.fail_counter) || "");
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const body = `${testCmd}${/;\s*$/.test(testCmd) ? "" : ";"}\n${counter ? `HostDone(${counter});` : 'HostLog("BACKEND_UNCOUNTED");'}\n`;
if (cmd !== "dist") writeFileSync(join(STAGE, "AUTOTEST.HC"), hc(`//Generated by gamec.  In the live CD:  MountIDEAuto;  then  #include "C:/AUTOTEST"
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
if (cmd !== "dist") rmSync(STAGE, { recursive: true, force: true });
console.log(`gamec: wrote ${OUT} (${statSync(OUT).size} bytes, FAT32, ${stagedBytes} bytes of files)`);
if (cmd === "build") process.exit(0);

// ---- disks: MBR partitions and mtools ----------------------------------------------------------------
function partitions(img) {
  const fd = openSync(img, "r"), sec = Buffer.alloc(512), out = [];
  const read = (lba) => { readSync(fd, sec, 0, 512, lba * 512); return Buffer.from(sec); };
  const walk = (lba, extBase) => {
    const b = read(lba);
    if (b[510] !== 0x55 || b[511] !== 0xaa) return;
    for (let i = 0; i < 4; i++) {
      const e = 446 + 16 * i, type = b[e + 4], start = b.readUInt32LE(e + 8), size = b.readUInt32LE(e + 12);
      if (!type || !size) continue;
      if (type === 0x05 || type === 0x0f) walk((extBase || 0) + start, extBase || start);
      else out.push({ type, start: lba + start, size });
    }
  };
  walk(0, 0);
  closeSync(fd);
  return out;
}
function mt(tool, args, quiet = false) { // (a function, not a const: play runs before the build section)
  const r = spawnSync(tool, args, { encoding: "utf8", env: { ...process.env, MTOOLS_SKIP_CHECK: "1" } });
  if (r.status !== 0 && !quiet) { console.error(`gamec: ${tool} ${args.join(" ")}\n${r.stderr || r.stdout}`); process.exit(2); }
  return r;
}
// C: of an installed TempleOS is the first FAT32 partition (VMInstall: DskPrt(,0.5,0.5), C and D, FAT32)
function cDrive(img) {
  const p = partitions(img).find((x) => x.type === 0x0b || x.type === 0x0c);
  if (!p) { console.error(`gamec: no FAT32 partition in ${img}`); process.exit(2); }
  return `${img}@@${p.start * 512}`;
}

// ---- play: drive a built bundle through its own run.sh -----------------------------------------------
async function playBundle() {
  const bundle = resolve(rest[0] && !rest[0].startsWith("--") ? rest[0] : "");
  const script = flag("--script");
  const name = basename(M.install_path.replace(/\\/g, "/"));
  if (!existsSync(join(bundle, "run.sh")) || !existsSync(join(bundle, `${name}.img`)) || !script) { console.error("gamec: play <game> <bundle-dir> --script FILE (run.sh and the image must be there)"); return 2; }
  const work = resolve(flag("--out", join(bundle, "..", ".play")));
  // play a copy: the bundle stays as shipped (no test save in it)
  const copy = join(work, "bundle");
  rmSync(copy, { recursive: true, force: true }); mkdirSync(copy, { recursive: true });
  for (const f of ["run.sh", `${name}.img`]) copyFileSync(join(bundle, f), join(copy, f));
  const img = join(copy, `${name}.img`), runSh = join(copy, "run.sh");
  const sock = join(work, "mon.sock"), shotDir = resolve(flag("--shots", join(work, "shots")));
  process.env.TT_AUDIO = process.env.TT_AUDIO || "none";   // headless: no sound device
  const boot = () => startVM({ bin: "sh", args: [runSh, "-display", "none", "-monitor", `unix:${sock},server,nowait`], sock, shotDir });
  const ctx = {
    vm: await boot(), boot,
    fileExists: (p) => mt("mdir", ["-b", "-i", cDrive(img), "::/" + p.replace(/^C:\//i, "").replace(/^\/+/, "")], true).status === 0,
  };
  const limit = Number(flag("--seconds", "1200")) * 1000;
  const timer = setTimeout(() => { console.log("gamec: play timed out"); ctx.vm.quit().then(() => process.exit(3)); }, limit);
  const failed = await runPlay(readFileSync(script, "utf8").split("\n"), ctx);
  clearTimeout(timer);
  if (!ctx.vm.exited()) await ctx.vm.quit();
  console.log(`gamec: play ${failed ? `FAILED (${failed})` : "PASS"}; screenshots ${shotDir}`);
  return failed ? 3 : 0;
}

// ---- run: boot the TempleOS live CD in QEMU, type the commands, collect the serial log --------------
const tos = flag("--tos");
if (!tos || !existsSync(tos)) {
  console.error(`gamec: ${cmd} needs --tos <TempleOS ISO>. None was supplied, so nothing was run and nothing is verified.`);
  process.exit(2);
}
if (!need("qemu-system-x86_64")) { console.error("gamec: qemu-system-x86_64 is not installed"); process.exit(2); }
const kvm = existsSync("/dev/kvm") ? ["-enable-kvm", "-cpu", "host"] : [];

if (cmd === "run") {
  const seconds = Number(flag("--seconds", "900"));        // the whole run, boot included; no KVM is slow
  const bootSeconds = Number(flag("--boot-seconds", "400"));
  const keep = rest.includes("--keep");                     // leave the VM running for hand driving
  const runDir = resolve(flag("--out", dirname(OUT)));
  mkdirSync(runDir, { recursive: true });
  const log = join(runDir, `${M.id}.serial.log`);
  const sock = join(runDir, `${M.id}.mon.sock`);
  const shotDir = resolve(flag("--shots", join(runDir, "shots")));
  rmSync(log, { force: true });
  const args = ["-m", "1024", "-smp", "2", "-display", "none", "-vga", "std",
    "-cdrom", tos, "-drive", `file=${OUT},format=raw,index=0,media=disk`, "-boot", "d",
    "-serial", `file:${log}`, "-monitor", `unix:${sock},server,nowait`, "-no-reboot", ...kvm];
  const vm = await startVM({ bin: "qemu-system-x86_64", args, sock, shotDir, keep });
  const t0 = Date.now();
  const serial = () => (existsSync(log) ? readFileSync(log, "latin1") : "");
  try {
    if (!(await vm.waitScreen(/Install onto hard drive/, bootSeconds, "live CD booted, install prompt"))) throw new Error("boot");
    await vm.shot("boot");
    await vm.type("n");
    await vm.waitScreen(/Take Tour/, bootSeconds, "tour prompt"); await vm.type("n");
    await vm.waitScreen(/Tour\(y or n\)\? NO[\s\S]*^\S*Home>( {2,}|$)/m, bootSeconds, "shell prompt");
    await vm.type("MountIDEAuto;\n");
    await vm.waitScreen(/MountIDEAuto;[\s\S]*^\S*Home>( {2,}|$)/m, bootSeconds, "game disk mounted");
    await vm.type('#include "C:/AUTOTEST"\n');
    await vm.shot("autotest");
    let lastShot = Date.now();
    while ((Date.now() - t0) / 1000 < seconds && !vm.exited()) {
      if (/BACKEND_END/.test(serial())) break;
      if (Date.now() - lastShot > 60000) { await vm.shot(`t${vm.el()}`); lastShot = Date.now(); }
      await sleep(2000);
    }
    await vm.shot("end");
    // --play <file>: drive the game after the verdict (tosvm.mjs runPlay: type, key, wait, shot, waitscreen ...)
    const play = flag("--play");
    if (play && /BACKEND_OK/.test(serial())) await runPlay(readFileSync(play, "utf8").split("\n"), { vm });
  } catch (e) { await vm.shot("stuck").catch(() => {}); }
  const text = serial();
  // The terminal dump carries DolDoc commands ($FG,4$ ...): strip them for the console.
  // Links to source keep their place as [file,line].
  const plain = text.replace(/\$\$/g, "\u0000")
    .replace(/\$LK,"([^"]*)"(?:,A="FL:([^"]*)")?\$/g, (_, t, a) => `[${a || t.replace(/^FL:/, "")}]`)
    .replace(/\$[^$\n]*\$/g, "").replace(/\u0000/g, "$");
  writeFileSync(log.replace(/\.serial\.log$/, ".serial.txt"), plain);
  console.log(plain.trim() || "(serial log empty)");
  let verdict;
  if (/BACKEND_OK/.test(text)) verdict = "PASS";
  else if (/BACKEND_FAIL/.test(text)) verdict = "FAIL";
  else if (/BACKEND_END/.test(text)) verdict = "ABORTED (compile error or exception; see the terminal text above)";
  else verdict = "NONE (no BACKEND_END line before the timeout)";
  console.log(`gamec: [${vm.el()}s] TempleOS verdict ${verdict}; serial ${log}; screenshots ${shotDir}`);
  if (keep) { console.log(`gamec: VM left running (pid ${vm.qemu.pid}); monitor ${sock}`); vm.detach(); process.exit(verdict === "PASS" ? 0 : 3); }
  await vm.quit();
  process.exit(verdict === "PASS" ? 0 : 3);
}

// ---- dist: a release bundle ------------------------------------------------------------------------
// 1. A TempleOS installed on a hard disk, made by TempleOS itself (the live CD's own installer, VMInstall:
//    two FAT32 partitions C: and D:, boot loader, kernel compiled for this machine).  Cached per ISO.
// 2. A copy of it with the game in C:/Home/<Name> and C:/Home/Once.HC replaced: TempleOS runs ~/Once.HC in the
//    first terminal at every boot (HomeSys.HC: XTalk(user1,"Cd;#include \"Once\";")), so the game starts by itself.
// 3. run.sh / run.bat (QEMU), README.txt, TEMPLEOS.txt (licence), the game disk for TempleOS users, and a zip.
const hdMb = Number(flag("--hd-mb", "256"));
const cacheDir = resolve(flag("--cache", join(process.env.XDG_CACHE_HOME || join(process.env.HOME || ".", ".cache"), "gamec")));
mkdirSync(cacheDir, { recursive: true });
const isoHash = createHash("sha256").update(readFileSync(tos)).digest("hex").slice(0, 12);
const base = join(cacheDir, `templeos-${isoHash}-${hdMb}mb.img`);
if (!existsSync(base) || rest.includes("--reinstall")) {
  console.log(`gamec: installing TempleOS from ${tos} onto a ${hdMb} MB disk (once; cached as ${base})`);
  const part = base + ".part", sock = join(cacheDir, "install.sock"), shotDir = join(cacheDir, "install-shots");
  rmSync(part, { force: true }); writeFileSync(part, Buffer.alloc(0)); spawnSync("truncate", ["-s", `${hdMb}M`, part]);
  const vm = await startVM({ bin: "qemu-system-x86_64", sock, shotDir, args: ["-m", "1024", "-smp", "2", "-display", "none", "-vga", "std",
    "-drive", `file=${part},format=raw,if=ide,index=0,media=disk`, "-drive", `file=${tos},if=ide,index=2,media=cdrom`, "-boot", "d",
    "-monitor", `unix:${sock},server,nowait`, "-no-reboot", ...kvm] });
  let ok = false;
  try {
    // OSInstall.HC: "Install onto hard drive" y, "virtual machine" y, PressAKey, VMInstallWiz (DskPrt, CopyTree x2,
    // BootHDIns x2, BootMHDIns), "Reboot Now" n.
    if (!(await vm.waitScreen(/Install onto hard drive/, 400, "live CD booted"))) throw new Error("boot");
    await vm.type("y");
    if (!(await vm.waitScreen(/machine\? \(y or n\)\?/, 120, "VM install question"))) throw new Error("vm question");
    await vm.type("y");
    if (!(await vm.waitScreen(/PRESS A KEY/, 120, "press a key"))) throw new Error("press a key");
    await sleep(1000); await vm.type(" ");
    if (!(await vm.waitScreen(/Reboot Now/, 1800, "install finished"))) throw new Error("install");
    await vm.shot("installed");
    await vm.type("n");
    await sleep(3000);
    ok = true;
  } catch (e) { console.error(`gamec: install stopped at: ${e.message}`); await vm.shot("stuck").catch(() => {}); }
  await vm.quit();
  if (!ok) { console.error(`gamec: the TempleOS install did not finish; screenshots in ${shotDir}`); process.exit(3); }
  renameSync(part, base);
}

const img = join(BUNDLE, `${NAME}.img`);
copyFileSync(base, img);
// The install leaves TempleOS's master boot loader (BootMHDIns), which waits at "Selection:" for 0, 1 or 2 with no
// time-out.  A player should type nothing, so the bundle's MBR code (bytes 0..439; the partition table stays) is
// replaced by this one: load the active partition's first sector (or partition 1's: C:, TempleOS's own boot record,
// written by BootHDIns) to 0:7C00 and jump to it with DL = the BIOS drive, as TempleOS's stage 2 does
// (Adam/Opt/Boot/BootMHD2.HC).  Assembled with nasm from Backend/tools/mbr.asm.
const MBR_CODE = "fa31c08ed0bc007c8ed88ec0be007cbf0006b90001f3a5ea1c060000fb88166506bebe07b90400f60480750883c610e2f6bebe07668b440866a36e0656be6606b4428a166506cd135e72098a166506ea007c0000be7606ac08c07406b40ecd10ebf5f4ebfd0010000100007c0000000000000000000067616d6563204d42523a2063616e6e6f7420726561642074686520626f6f7420706172746974696f6e";
{
  const code = Buffer.alloc(440); Buffer.from(MBR_CODE, "hex").copy(code);
  const fd = openSync(img, "r+"); writeSync(fd, code, 0, 440, 0); closeSync(fd);
}
const C = cDrive(img);
// the game and the backend runtime, at their install paths
for (const sub of ["Backend", NAME]) {
  mt("mdeltree", ["-i", C, `::/Home/${sub}`], true);
  mt("mcopy", ["-s", "-Q", "-i", C, join(STAGE, "Home", sub), "::/Home/"]);
}
rmSync(STAGE, { recursive: true, force: true });
// ~/Once.HC: start the game.  Whatever Once the install had (the "Tip of the Day" and tour prompt) is replaced.
const launch = M.launch || `#include "${M.install_path}/${(M.entry || "Run.HC").replace(/\.HC$/i, "")}"`;
const onceTmp = join(BUNDLE, ".Once.HC");
writeFileSync(onceTmp, hc(`//${M.title} ${M.version}: TempleOS runs this file at every boot (HomeSys.HC: XTalk(user1,"Cd;#include \\"Once\\";")).
//Generated by gamec dist.  To boot to the TempleOS shell instead, delete the #include line.
//To play again after leaving the game:  ${launch}
OnceExe;
${launch}
"\\n${M.title} ${M.version}.  To play again:\\n  %s\\n\\n","${esc(launch)}";;
`));
for (const n of ["Once.HC", "Once.HC.Z", "ONCE.HC", "ONCE.HC.Z"]) mt("mdel", ["-i", C, `::/Home/${n}`], true);
mt("mcopy", ["-o", "-i", C, onceTmp, "::/Home/Once.HC"]);
rmSync(onceTmp);

// run scripts ---------------------------------------------------------------------------------------------
const title = M.title, ver = M.version;
writeFileSync(join(BUNDLE, "run.sh"), `#!/bin/sh
# ${title} ${ver} -- boots TempleOS from ${NAME}.img in QEMU; the game starts by itself (about 20 s to 2 min).
# Your saves are written into ${NAME}.img: keep that file to keep your game.  Closing the window is safe
# when you are not in the middle of saving.
# Extra arguments go to QEMU, e.g.  ./run.sh -full-screen
# Settings by environment:  QEMU=/path/to/qemu-system-x86_64   TT_AUDIO=none|pipewire|pa|alsa|sdl|coreaudio
#                           TT_ACCEL="-accel kvm"   TT_DISPLAY=gtk|sdl|cocoa
cd "$(dirname "$0")" || exit 1
QEMU="\${QEMU:-qemu-system-x86_64}"
if ! command -v "$QEMU" >/dev/null 2>&1; then
  echo "QEMU was not found. Install it:  Linux: sudo apt install qemu-system-x86   macOS: brew install qemu"
  exit 1
fi
OS="$(uname -s)"
# speed: KVM on Linux when this user may use it; elsewhere QEMU's own CPU (TCG), which TempleOS runs well on
if [ -z "\${TT_ACCEL+x}" ]; then
  TT_ACCEL="-accel tcg"
  [ "$OS" = Linux ] && [ -r /dev/kvm ] && [ -w /dev/kvm ] && TT_ACCEL="-accel kvm -accel tcg"
fi
# sound: TempleOS plays the PC speaker; give it the first audio backend this QEMU has
AUDIO=""
if [ "\${TT_AUDIO:-}" != none ]; then
  HAVE="$("$QEMU" -audiodev help 2>/dev/null)"
  if [ "$OS" = Darwin ]; then PREF="coreaudio sdl"; else PREF="pipewire pa alsa sdl"; fi
  [ -n "\${TT_AUDIO:-}" ] && PREF="$TT_AUDIO"
  for d in $PREF; do
    if printf '%s\\n' "$HAVE" | grep -qx "$d"; then AUDIO="-audiodev $d,id=snd0 -machine pc,pcspk-audiodev=snd0"; break; fi
  done
fi
# display: a window that scales (View > Zoom, or drag the corner; Ctrl+Alt+F for full screen)
if [ -z "\${TT_DISPLAY:-}" ]; then
  HAVED="$("$QEMU" -display help 2>/dev/null)"
  if [ "$OS" = Darwin ] && printf '%s\\n' "$HAVED" | grep -qx cocoa; then TT_DISPLAY="cocoa,zoom-to-fit=on"
  elif printf '%s\\n' "$HAVED" | grep -qx gtk; then TT_DISPLAY="gtk,zoom-to-fit=on"
  elif printf '%s\\n' "$HAVED" | grep -qx sdl; then TT_DISPLAY="sdl"
  else TT_DISPLAY="default"; fi
fi
# shellcheck disable=SC2086
exec "$QEMU" -name "${title}" -m 1024 -smp 2 $TT_ACCEL -vga std -display "$TT_DISPLAY" \\
  -rtc base=localtime $AUDIO \\
  -drive "file=${NAME}.img,format=raw,if=ide,index=0,media=disk" \\
  -drive if=ide,index=2,media=cdrom \\
  -boot c "$@"
`);
spawnSync("chmod", ["+x", join(BUNDLE, "run.sh")]);
const crlf = (s) => s.replace(/\r?\n/g, "\r\n");
writeFileSync(join(BUNDLE, "run.bat"), crlf(`@echo off
rem ${title} ${ver} -- boots TempleOS from ${NAME}.img in QEMU for Windows; the game starts by itself.
rem Your saves are written into ${NAME}.img: keep that file to keep your game.
rem Get QEMU from https://qemu.weilnetz.de/w64/ (or set QEMU=full\\path\\to\\qemu-system-x86_64.exe).
rem Extra arguments go to QEMU, e.g.  run.bat -full-screen      Faster, on Windows with Hyper-V:  set TT_ACCEL=-accel whpx -accel tcg
setlocal
cd /d "%~dp0"
if not defined QEMU if exist "%ProgramFiles%\\qemu\\qemu-system-x86_64.exe" set "QEMU=%ProgramFiles%\\qemu\\qemu-system-x86_64.exe"
if not defined QEMU set "QEMU=qemu-system-x86_64"
if not defined TT_ACCEL set "TT_ACCEL=-accel tcg"
set "AUDIO=-audiodev dsound,id=snd0 -machine pc,pcspk-audiodev=snd0"
if /i "%TT_AUDIO%"=="none" set "AUDIO="
"%QEMU%" -name "${title}" -m 1024 -smp 2 %TT_ACCEL% -vga std -display gtk,zoom-to-fit=on -rtc base=localtime %AUDIO% -drive "file=${NAME}.img,format=raw,if=ide,index=0,media=disk" -drive if=ide,index=2,media=cdrom -boot c %*
if errorlevel 1 (
  echo.
  echo QEMU did not start. Install QEMU for Windows, or set QEMU to the full path of qemu-system-x86_64.exe.
  pause
)
`));

// VirtualBox: the same disk, converted on the player's machine by VirtualBox's own tool (VBoxManage convertfromraw), in a VM
// made to TempleOS's needs: IDE disk on PIIX4 (TempleOS has no AHCI/SATA driver), BIOS, I/O APIC for its cores, VGA, PS/2.
// VirtualBox does not emulate the PC speaker as sound, so the game is silent there (QEMU plays it).
// The raw image stays untouched: the VM's disk is <NAME>.vdi beside it, and saves go there.
const vmName = title;
writeFileSync(join(BUNDLE, "setup-virtualbox.sh"), `#!/bin/sh
# ${title} ${ver} -- make a VirtualBox VM from ${NAME}.img and start it (Linux/macOS).  Run once; afterwards start
# "${vmName}" from VirtualBox (or run this again: it only starts the VM when it exists).
# Needs VirtualBox 6.1 or 7 (VBoxManage on PATH).  Note: VirtualBox has no PC-speaker sound; use run.sh for sound.
cd "$(dirname "$0")" || exit 1
VBM="\${VBOXMANAGE:-VBoxManage}"
command -v "$VBM" >/dev/null 2>&1 || { echo "VBoxManage was not found: install VirtualBox (virtualbox.org)"; exit 1; }
if ! "$VBM" showvminfo "${vmName}" >/dev/null 2>&1; then
  [ -f ${NAME}.vdi ] || "$VBM" convertfromraw ${NAME}.img ${NAME}.vdi --format VDI || exit 1
  "$VBM" createvm --name "${vmName}" --ostype Other_64 --register || exit 1
  "$VBM" modifyvm "${vmName}" --memory 1024 --cpus 2 --ioapic on --firmware bios --boot1 disk --boot2 none \\
    --graphicscontroller vboxvga --vram 16 --mouse ps2 --keyboard ps2 --rtcuseutc off --usb off --audio-enabled off 2>/dev/null \\
  || "$VBM" modifyvm "${vmName}" --memory 1024 --cpus 2 --ioapic on --firmware bios --boot1 disk --boot2 none \\
    --graphicscontroller vboxvga --vram 16 --mouse ps2 --keyboard ps2 --rtcuseutc off --usb off --audio none || exit 1
  "$VBM" storagectl "${vmName}" --name IDE --add ide --controller PIIX4 || exit 1
  "$VBM" storageattach "${vmName}" --storagectl IDE --port 0 --device 0 --type hdd --medium "$(pwd)/${NAME}.vdi" || exit 1
fi
exec "$VBM" startvm "${vmName}"
`);
spawnSync("chmod", ["+x", join(BUNDLE, "setup-virtualbox.sh")]);
writeFileSync(join(BUNDLE, "setup-virtualbox.bat"), crlf(`@echo off
rem ${title} ${ver} -- make a VirtualBox VM from ${NAME}.img and start it (Windows).  Run once; afterwards start
rem "${vmName}" from VirtualBox (or run this again: it only starts the VM when it exists).
rem Needs VirtualBox 6.1 or 7.  Note: VirtualBox has no PC-speaker sound; use run.bat (QEMU) for sound.
setlocal
cd /d "%~dp0"
if not defined VBOXMANAGE set "VBOXMANAGE=%ProgramFiles%\\Oracle\\VirtualBox\\VBoxManage.exe"
if not exist "%VBOXMANAGE%" (
  echo VBoxManage.exe was not found. Install VirtualBox from virtualbox.org, or set VBOXMANAGE to its full path.
  pause
  exit /b 1
)
"%VBOXMANAGE%" showvminfo "${vmName}" >nul 2>&1
if not errorlevel 1 goto start
if not exist ${NAME}.vdi "%VBOXMANAGE%" convertfromraw ${NAME}.img ${NAME}.vdi --format VDI || goto fail
"%VBOXMANAGE%" createvm --name "${vmName}" --ostype Other_64 --register || goto fail
"%VBOXMANAGE%" modifyvm "${vmName}" --memory 1024 --cpus 2 --ioapic on --firmware bios --boot1 disk --boot2 none --graphicscontroller vboxvga --vram 16 --mouse ps2 --keyboard ps2 --rtcuseutc off --usb off --audio-enabled off 2>nul
if errorlevel 1 "%VBOXMANAGE%" modifyvm "${vmName}" --memory 1024 --cpus 2 --ioapic on --firmware bios --boot1 disk --boot2 none --graphicscontroller vboxvga --vram 16 --mouse ps2 --keyboard ps2 --rtcuseutc off --usb off --audio none || goto fail
"%VBOXMANAGE%" storagectl "${vmName}" --name IDE --add ide --controller PIIX4 || goto fail
"%VBOXMANAGE%" storageattach "${vmName}" --storagectl IDE --port 0 --device 0 --type hdd --medium "%CD%\\${NAME}.vdi" || goto fail
:start
"%VBOXMANAGE%" startvm "${vmName}"
exit /b 0
:fail
echo.
echo Making the VirtualBox VM failed (see the message above).  run.bat with QEMU is the other way to play.
pause
exit /b 1
`));

// README.txt (the game's own text, with {{TITLE}} {{VERSION}} {{NAME}} {{LAUNCH}} filled in) and the TempleOS licence
const fill = (s) => s.replace(/\{\{TITLE\}\}/g, title).replace(/\{\{VERSION\}\}/g, ver).replace(/\{\{NAME\}\}/g, NAME).replace(/\{\{LAUNCH\}\}/g, launch);
const readme = flag("--readme");
writeFileSync(join(BUNDLE, "README.txt"), crlf(fill(readme ? readFileSync(resolve(readme), "utf8")
  : `{{TITLE}} {{VERSION}}\n\nLinux/macOS: ./run.sh     Windows: run.bat     (needs QEMU)\nTempleOS: attach {{NAME}}-install.img, Mount, #include "D:/INSTALL"\n`)));
writeFileSync(join(BUNDLE, "TEMPLEOS.txt"), crlf(`TempleOS V5.03, in ${NAME}.img

${NAME}.img holds a TempleOS V5.03 installation made by TempleOS's own installer from the official live CD
(the final release; ISO sha256 prefix ${isoHash}).  TempleOS was written by Terry A. Davis and placed in the
public domain:

  "It is public domain, not GPL."                 -- ::/Doc/Credits.DD
  "Free and public domain."                       -- ::/Doc/Charter.DD
  ::/Kernel/FontStd.HC is from FreeDOS; "It's public domain."  -- ::/Doc/Credits.DD

All of TempleOS's source is on the disk, as on every TempleOS distribution.  The game's files are in
C:/Home/${NAME} and C:/Home/Backend; C:/Home/Once.HC starts the game at boot.  ${title} is not part of
TempleOS and is not endorsed by its author; see README.txt for its own licence.
`));
const notice = flag("--notice");
if (notice) copyFileSync(resolve(notice), join(BUNDLE, basename(notice).replace(/(\.txt)?$/i, ".txt")));

{ // SHA256SUMS of every file in the bundle (sha256sum -c SHA256SUMS.txt checks them)
  const sums = readdirSync(BUNDLE).filter((f) => !f.startsWith(".") && f !== "SHA256SUMS.txt").sort()
    .map((f) => `${createHash("sha256").update(readFileSync(join(BUNDLE, f))).digest("hex")}  ${f}`);
  writeFileSync(join(BUNDLE, "SHA256SUMS.txt"), sums.join("\n") + "\n");
}

// zip ---------------------------------------------------------------------------------------------------
const zipName = `${NAME}-${ver}.zip`;
rmSync(join(DIST_ROOT, zipName), { force: true });
if (need("zip")) {
  const r = spawnSync("zip", ["-r", "-q", "-9", zipName, basename(BUNDLE)], { cwd: DIST_ROOT, encoding: "utf8" });
  if (r.status !== 0) { console.error(r.stderr); process.exit(2); }
  console.log(`gamec: wrote ${join(DIST_ROOT, zipName)} (${statSync(join(DIST_ROOT, zipName)).size} bytes)`);
} else console.log("gamec: zip is not installed; the bundle folder is ready but not zipped");
console.log(`gamec: bundle ${BUNDLE}`);
for (const f of readdirSync(BUNDLE)) console.log(`  ${f}  ${statSync(join(BUNDLE, f)).size}`);
process.exit(0);
