#!/usr/bin/env node
// gamec -- host-side driver of the HolyC game backend.
//
//   node Backend/tools/gamec.mjs check <game-dir>            lint + manifest + include graph
//   node Backend/tools/gamec.mjs build <game-dir> [out.iso]  check, stage, and build a data disc
//   node Backend/tools/gamec.mjs run   <game-dir> --tos <TempleOS.ISO> [--seconds N]
//                                                            boot QEMU headless and collect the verdict
//
// The compiler is TempleOS's own. This tool never translates HolyC; it only decides whether a tree is fit
// to be handed to that compiler, and it carries the tree to it.
//
// Exit codes: 0 pass, 1 check failed, 2 tooling missing or bad usage, 3 TempleOS verdict failed.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { join, dirname, basename, extname, resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";
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
// 8.3 names on everything that goes on the disc
for (const f of walk(GAME)) {
  if (!DISC_EXT.has(extname(f).toUpperCase())) continue;
  const stem = basename(f, extname(f));
  if (stem.length > 8) fail(`${relative(GAME, f)}: name longer than 8.3`);
  for (const part of relative(GAME, dirname(f)).split(/[\\/]/).filter(Boolean))
    if (part.length > 8) fail(`${relative(GAME, f)}: directory "${part}" longer than 8 characters`);
}

console.log(`gamec: ${M.title} ${M.version} (${M.id}) -- ${sources.length} HolyC files, ${lineCount} lines`);
for (const n of notes) console.log(`  note: ${n}`);
if (fails.length) { for (const f of fails) console.log(`  FAIL: ${f}`); console.log(`gamec: check FAILED (${fails.length})`); process.exit(1); }
console.log("gamec: check PASS (host rules only; the TempleOS compiler has not seen this tree)");
if (cmd === "check") process.exit(0);

// ---- build: stage and make the disc --------------------------------------------------------------
const need = (bin) => spawnSync("which", [bin]).status === 0;
if (!need("xorriso")) { console.error("gamec: xorriso is not installed (apt-get install xorriso)"); process.exit(2); }

const OUT = resolve(cmd === "build" && rest[0] && !rest[0].startsWith("--") ? rest[0] : join(GAME, "..", `${M.id}.iso`));
const STAGE = join(dirname(OUT), `.stage-${M.id}`);
rmSync(STAGE, { recursive: true, force: true });
const gameDirName = basename(M.install_path.replace(/\\/g, "/")).toUpperCase().slice(0, 8);

function stageTree(src, dst) {
  for (const f of walk(src)) {
    if (!DISC_EXT.has(extname(f).toUpperCase())) continue;
    const to = join(dst, relative(src, f));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(f, to);
  }
}
stageTree(LIB, join(STAGE, "BACKEND", "LIB"));
stageTree(GAME, join(STAGE, gameDirName));

// INSTALL.HC: run once from the mounted disc.  Cd(__DIR__) makes the paths relative to the disc.
const hc = (s) => s.replace(/\r?\n/g, "\n");
writeFileSync(join(STAGE, "INSTALL.HC"), hc(`//Generated by gamec. Run from the disc:  #include "T:/INSTALL"   (T: is the drive Mount reports)
Cd(__DIR__);;
CopyTree("BACKEND","::/Home/Backend");
CopyTree("${gameDirName}","${M.install_path}");
"Installed ${M.title} ${M.version}\\n";
`));
// AUTOTEST.HC: install, compile, run the tests, report over the serial port, power off.
const testCmd = (M.tests && (M.tests.templeos_auto || M.tests.templeos)) || "";
const counter = (M.tests && M.tests.fail_counter) || "";
const testInclude = (testCmd.match(/#include\s+"([^"]+)"/) || [])[1];
writeFileSync(join(STAGE, "AUTOTEST.HC"), hc(`//Generated by gamec. #include this from the booted TempleOS shell, with the disc as T:
Cd(__DIR__);;
#include "INSTALL"
#include "::/Home/Backend/Lib/Load"
HostLog("BACKEND_BEGIN ${M.id}");
${testInclude ? `#include "${testInclude}"` : 'HostLog("BACKEND_NOTESTS");'}
${counter ? `HostDone(${counter});` : "HostLog(\"BACKEND_UNCOUNTED\");"}
`));

const x = spawnSync("xorriso", ["-as", "mkisofs", "-iso-level", "1", "-V", "HOLYGAME", "-o", OUT, STAGE], { encoding: "utf8" });
rmSync(STAGE, { recursive: true, force: true });
if (x.status !== 0) { console.error(x.stderr); process.exit(2); }
console.log(`gamec: wrote ${OUT} (${statSync(OUT).size} bytes)`);
if (cmd === "build") process.exit(0);

// ---- run: boot TempleOS in QEMU, collect the serial log ------------------------------------------
const tos = flag("--tos");
if (!tos || !existsSync(tos)) {
  console.error("gamec: run needs --tos <TempleOS ISO>. None was supplied, so nothing was run and nothing is verified.");
  process.exit(2);
}
if (!need("qemu-system-x86_64")) { console.error("gamec: qemu-system-x86_64 is not installed"); process.exit(2); }
const seconds = Number(flag("--seconds", "120"));
const log = join(dirname(OUT), `${M.id}.serial.log`);
rmSync(log, { force: true });
// TempleOS needs a hard disk to install onto; a scratch image keeps the host clean.
const hd = join(dirname(OUT), `${M.id}.scratch.img`);
spawnSync("qemu-img", ["create", "-f", "raw", hd, "512M"]);
const q = spawnSync("qemu-system-x86_64", [
  "-m", "1G", "-display", "none", "-serial", `file:${log}`,
  "-cdrom", tos, "-drive", `file=${OUT},media=cdrom,index=3`, "-hda", hd, "-boot", "d", "-no-reboot",
], { timeout: seconds * 1000, encoding: "utf8" });
const text = existsSync(log) ? readFileSync(log, "utf8") : "";
console.log(text.trim() || "(serial log empty)");
if (/BACKEND_OK/.test(text)) { console.log("gamec: TempleOS verdict PASS"); process.exit(0); }
console.log(`gamec: TempleOS verdict ${/BACKEND_FAIL/.test(text) ? "FAIL" : "NONE (no BACKEND_OK line before the timeout)"}`);
process.exit(3);
