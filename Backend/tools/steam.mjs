// steam.mjs -- `gamec steam <game> <bundle-dir> [--out DIR] [--qemu-win DIR] [--qemu-linux system|DIR|none] [--no-test]`
//
// Turns a release bundle (gamec dist) into the content of Steam depots, one folder per OS, plus the SteamPipe scripts:
//
//   <out>/content/windows/   <Name>.exe (launcher, mingw-w64), <Name>.img, saves-empty.img, qemu/ (QEMU for Windows), texts
//   <out>/content/linux/     <name>.sh (launcher), <Name>.img, saves-empty.img, qemu/ (QEMU + its libraries), texts
//   <out>/scripts/           app_build.vdf, depot_build_windows.vdf, depot_build_linux.vdf  (APPID / DEPOT ids to fill in)
//   <out>/STEAM-BUILD.txt    what is in it and what is missing
//
// The design (why two disks):  Steam owns the install folder -- an update or "verify integrity" rewrites its files.  So the game disk
// <Name>.img is booted with snapshot=on (QEMU never writes it) and the player's saves live on a second small disk, saves.img, in the
// player's own folder (Windows %APPDATA%\<Name>, Linux $XDG_DATA_HOME/<Name>), made once from saves-empty.img.  The Steam variant of
// the image's Home/Once.HC mounts it with ATAMount (the second disk becomes E:; C: and D: are the installed TempleOS's own) and defines
// HT_DIR (the game's save folder) as E:/<Name> before the game compiles.  Booted without the save disk it falls back to ~/<Name>.
//
// QEMU (GPL-2.0) is shipped unmodified, with its licence and the exact source it was built from (or a written offer): see QEMU-SOURCE.txt.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, copyFileSync, readdirSync, statSync, cpSync, openSync, writeSync, closeSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startVM, runPlay } from "./tosvm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const have = (bin) => sh("which", [bin]).status === 0;

export async function steamBuild({ M, rest, flag, mt, cDrive }) {
  const NAME = basename(M.install_path.replace(/\\/g, "/"));
  const lower = NAME.toLowerCase();
  const bundle = resolve(rest[0] && !rest[0].startsWith("--") ? rest[0] : "");
  const baseImg = join(bundle, `${NAME}.img`);
  if (!existsSync(baseImg)) { console.error(`gamec steam: no ${baseImg} (build it with gamec dist first)`); return 2; }
  const out = resolve(flag("--out", join(bundle, "..", "steam", `${NAME}-${M.version}`)));
  rmSync(out, { recursive: true, force: true });
  const missing = [], made = [];

  // 1. the Steam image: the bundle's image with a Once.HC that mounts the save disk ---------------------------------------
  const work = join(out, ".work"); mkdirSync(work, { recursive: true });
  const img = join(work, `${NAME}.img`);
  copyFileSync(baseImg, img);
  const launch = M.launch || `#include "${M.install_path}/${(M.entry || "Run.HC").replace(/\.HC$/i, "")}"`;
  writeFileSync(join(work, "Once.HC"), `//${M.title} ${M.version}, Steam build (gamec steam).  TempleOS runs this at every boot.
//The launcher attaches the player's save disk as the second hard disk (primary IDE unit 1): ATAMount makes it E: (C: and D: are TempleOS's own).
//Saves go there, so Steam can replace this disk on an update.  Without it, the game keeps its saves on C: as usual.
//Wait for TempleOS's own start-up scan of the disks (AutoComplete, ACInit in the Adam task) to finish first: mounting a disk
//while it walks the file tree crashes it ("Bad Free" in DirTreeDel).  It sets RLf_AUTO_COMPLETE when done.
OnceExe;
//(The flag can be set before the scan has started, so also wait for its word count, which it fills in.)
while (!Bt(&sys_run_level,RLf_AUTO_COMPLETE) || !ac.num_words || Bt(&ac.flags,ACf_INIT_IN_PROGRESS)) Sleep(100);
Sleep(500);
//Mount only the save disk: primary IDE, unit 1 (QEMU's -drive index=1), base ports as TempleOS reports them (ATARep).  MountIDEAuto would
//also mount the boot disk and the CD again, and C: then loses its files.
I64 ht_try;
Silent(ON);
for (ht_try=0;ht_try<5 && !Let2Drv('E',FALSE);ht_try++) {
  ATAMount(blkdev.first_hd_drv_let,BDT_ATA,0x1F0,0x3F4,1);
  if (!Let2Drv('E',FALSE)) Sleep(1000);
}
Silent(OFF);
#exe {if (Let2Drv('E',FALSE)) StreamPrint("#define HT_DIR \\"E:/${NAME}\\"\\n");};
${launch}
"\\n${M.title} ${M.version}.  To play again:\\n  %s\\n\\n","${launch.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}";;
`.replace(/\n/g, "\n"));
  const C = cDrive(img);
  for (const n of ["Once.HC", "Once.HC.Z", "ONCE.HC", "ONCE.HC.Z"]) mt("mdel", ["-i", C, `::/Home/${n}`], true);
  mt("mcopy", ["-o", "-i", C, join(work, "Once.HC"), "::/Home/Once.HC"]);

  // 2. the empty save disk: MBR + one FAT32 partition, 64 MB (mostly zeros: Steam's depot compression makes it tiny) -------
  const saves = join(work, "saves-empty.img");
  { const mb = 64, start = 2048, size = mb * 2048 - start;
    writeFileSync(saves, Buffer.alloc(0)); sh("truncate", ["-s", `${mb}M`, saves]);
    const mbr = Buffer.alloc(512), e = 446;
    Buffer.from([0x00, 0xfe, 0xff, 0xff, 0x0c, 0xfe, 0xff, 0xff]).copy(mbr, e);
    mbr.writeUInt32LE(start, e + 8); mbr.writeUInt32LE(size, e + 12); mbr[510] = 0x55; mbr[511] = 0xaa;
    const fd = openSync(saves, "r+"); writeSync(fd, mbr, 0, 512, 0); closeSync(fd);
    const r = sh("mkfs.fat", ["-F", "32", "-s", "1", "-S", "512", "-n", "SAVES", "--offset", String(start), saves, String(size / 2)]);
    if (r.status !== 0) { console.error(r.stderr); return 2; } }

  const texts = ["README.txt", "TEMPLEOS.txt", "NOTICE.txt", "LICENSE.txt"].filter((f) => existsSync(join(bundle, f)));
  const common = (dst) => {
    mkdirSync(dst, { recursive: true });
    copyFileSync(img, join(dst, `${NAME}.img`));
    copyFileSync(saves, join(dst, "saves-empty.img"));
    for (const t of texts) copyFileSync(join(bundle, t), join(dst, t));
  };

  // 3. Windows depot ----------------------------------------------------------------------------------------------------
  const win = join(out, "content", "windows"); common(win);
  if (have("x86_64-w64-mingw32-gcc")) {
    const r = sh("x86_64-w64-mingw32-gcc", ["-O2", "-mwindows", `-DGAME_NAME="${NAME}"`, `-DGAME_TITLE="${M.title}"`,
      join(HERE, "..", "launcher", "launcher.c"), "-o", join(win, `${NAME}.exe`), "-lshell32"]);
    if (r.status !== 0) { console.error(r.stderr); return 2; }
    made.push(`windows/${NAME}.exe (launcher)`);
  } else missing.push("windows launcher: install mingw-w64 (x86_64-w64-mingw32-gcc) and run gamec steam again");
  const qwin = flag("--qemu-win");
  if (qwin && existsSync(join(qwin, "qemu-system-x86_64.exe"))) {
    cpSync(qwin, join(win, "qemu"), { recursive: true });
    made.push(`windows/qemu from ${qwin}`);
  } else missing.push("windows/qemu: run Backend/tools/fetch-qemu-win.ps1 on a Windows PC with internet, then gamec steam ... --qemu-win <dir>");

  // 4. Linux depot (Steam Deck too) ---------------------------------------------------------------------------------------
  const lin = join(out, "content", "linux"); common(lin);
  writeFileSync(join(lin, `${lower}.sh`), `#!/bin/sh
# ${M.title} ${M.version} -- Steam launcher for Linux and Steam Deck (gamec steam).
# The game disk ${NAME}.img is read only (snapshot=on); your saves live in \${XDG_DATA_HOME:-~/.local/share}/${NAME}/saves.img.
# Settings: HT_ACCEL (default: KVM when allowed, else TCG), HT_AUDIO=none|pipewire|pa|alsa|sdl, HT_QEMU (a QEMU to use instead).
cd "$(dirname "$0")" || exit 1
HERE="$(pwd)"
DATA="\${XDG_DATA_HOME:-$HOME/.local/share}/${NAME}"
mkdir -p "$DATA" || exit 1
[ -f "$DATA/saves.img" ] || cp saves-empty.img "$DATA/saves.img" || exit 1
QEMU="\${HT_QEMU:-}"
if [ -z "$QEMU" ] && [ -x qemu/bin/qemu-system-x86_64 ]; then
  QEMU="$HERE/qemu/bin/qemu-system-x86_64"
  export LD_LIBRARY_PATH="$HERE/qemu/lib\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export QEMU_MODULE_DIR="$HERE/qemu/lib/qemu"
  set -- -L "$HERE/qemu/share" "$@"
fi
[ -n "$QEMU" ] || QEMU=qemu-system-x86_64
command -v "$QEMU" >/dev/null 2>&1 || { echo "QEMU was not found. Linux: sudo apt install qemu-system-x86   macOS: brew install qemu"; exit 1; }
if [ -z "\${HT_ACCEL+x}" ]; then
  HT_ACCEL="-accel tcg"
  [ -r /dev/kvm ] && [ -w /dev/kvm ] && HT_ACCEL="-accel kvm -accel tcg"
fi
AUDIO=""
if [ "\${HT_AUDIO:-}" != none ]; then
  HAVE="$("$QEMU" -audiodev help 2>/dev/null)"
  PREF="pipewire pa alsa sdl"; [ "$(uname -s)" = Darwin ] && PREF="coreaudio sdl"
  for d in \${HT_AUDIO:-$PREF}; do
    if printf '%s\\n' "$HAVE" | grep -qx "$d"; then AUDIO="-audiodev $d,id=snd0 -machine pc,pcspk-audiodev=snd0"; break; fi
  done
fi
# QEMU's -drive splits on commas: a comma inside a path is written twice
GAMEIMG="$(printf '%s' "$HERE/${NAME}.img" | sed 's/,/,,/g')"
SAVEIMG="$(printf '%s' "$DATA/saves.img" | sed 's/,/,,/g')"
DISPLAY_OPT="sdl"
HAVED="$("$QEMU" -display help 2>/dev/null)"
if [ "$(uname -s)" = Darwin ] && printf '%s\n' "$HAVED" | grep -qx cocoa; then DISPLAY_OPT="cocoa,zoom-to-fit=on"
elif printf '%s\n' "$HAVED" | grep -qx gtk; then DISPLAY_OPT="gtk,zoom-to-fit=on"; fi
# shellcheck disable=SC2086
exec "$QEMU" -name "${M.title}" -m 1024 -smp 2 $HT_ACCEL -vga std -display "\${HT_DISPLAY:-$DISPLAY_OPT}" -rtc base=localtime $AUDIO -nic none \\
  -drive "file=$GAMEIMG,format=raw,if=ide,index=0,media=disk,snapshot=on" \\
  -drive "file=$SAVEIMG,format=raw,if=ide,index=1,media=disk" \\
  -drive if=ide,index=2,media=cdrom -boot c "$@"
`);
  sh("chmod", ["+x", join(lin, `${lower}.sh`)]);
  const qlin = flag("--qemu-linux", "system");
  if (qlin === "system" && have("qemu-system-x86_64")) {
    const r = bundleSystemQemu(join(lin, "qemu"));
    if (r) made.push(`linux/qemu: ${r}`); else missing.push("linux/qemu: could not bundle the system QEMU");
  } else if (qlin !== "none" && existsSync(join(qlin, "bin", "qemu-system-x86_64"))) {
    cpSync(qlin, join(lin, "qemu"), { recursive: true }); made.push(`linux/qemu from ${qlin}`);
  } else missing.push("linux/qemu: none bundled; the launcher falls back to the player's qemu-system-x86_64");

  // 5. SteamPipe scripts ----------------------------------------------------------------------------------------------------
  const scripts = join(out, "scripts"); mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "app_build.vdf"), `"AppBuild"
{
\t"AppID" "APPID"\t// your app's ID from Steamworks
\t"Desc" "${M.title} ${M.version}"
\t"ContentRoot" "../content/"
\t"BuildOutput" "../output/"
\t"SetLive" ""\t// e.g. "beta" to publish straight to a branch; leave empty and set it live in Steamworks
\t"Depots"
\t{
\t\t"DEPOT_WINDOWS" "depot_build_windows.vdf"
\t\t"DEPOT_LINUX" "depot_build_linux.vdf"
\t}
}
`);
  for (const [os, id] of [["windows", "DEPOT_WINDOWS"], ["linux", "DEPOT_LINUX"]])
    writeFileSync(join(scripts, `depot_build_${os}.vdf`), `"DepotBuild"
{
\t"DepotID" "${id}"
\t"ContentRoot" "../content/${os}/"
\t"FileMapping"
\t{
\t\t"LocalPath" "*"
\t\t"DepotPath" "."
\t\t"Recursive" "1"
\t}
}
`);
  writeFileSync(join(scripts, "upload.sh"), `#!/bin/sh
# Upload this build with SteamCMD (https://partner.steamgames.com/doc/sdk/uploading).  First replace APPID, DEPOT_WINDOWS and
# DEPOT_LINUX in the .vdf files with the numbers Steamworks gave you.  Run as a Steam account with build rights (it asks for Steam Guard).
cd "$(dirname "$0")" || exit 1
grep -q 'APPID\\|DEPOT_' ./*.vdf && { echo "fill in APPID / DEPOT ids in scripts/*.vdf first"; exit 1; }
exec steamcmd +login "\${STEAM_BUILD_USER:?set STEAM_BUILD_USER}" +run_app_build "$(pwd)/app_build.vdf" +quit
`);
  sh("chmod", ["+x", join(scripts, "upload.sh")]);

  rmSync(work, { recursive: true, force: true });
  // 6. what is here -----------------------------------------------------------------------------------------------------
  const size = (d) => { let n = 0; for (const f of readdirSync(d, { recursive: true })) { const p = join(d, f); if (statSync(p).isFile()) n += statSync(p).size; } return n; };
  const report = [`${M.title} ${M.version} -- Steam build made by gamec steam`, "",
    `content/windows  ${(size(win) / 1048576).toFixed(1)} MB   launch option: ${NAME}.exe`,
    `content/linux    ${(size(lin) / 1048576).toFixed(1)} MB   launch option: ${lower}.sh`, "",
    "Made:", ...made.map((m) => "  " + m), "", "Missing:", ...(missing.length ? missing.map((m) => "  " + m) : ["  nothing"]), "",
    "Saves: Windows %APPDATA%\\" + NAME + "\\saves.img, Linux ~/.local/share/" + NAME + "/saves.img (Steam Cloud: add that file).", ""];
  writeFileSync(join(out, "STEAM-BUILD.txt"), report.join("\n"));
  console.log(report.join("\n"));
  const test = flag("--test");
  return test ? await steamTest({ out, lower, NAME, script: resolve(test), shots: flag("--shots"), mt }) : 0;
}

// --test SCRIPT: play the Linux depot through its own launcher, headless, as a player would (tosvm play script), with a fresh data
// folder; then the game disk must be unchanged (snapshot=on) and expect-file looks on the player's save disk (saves.img).
async function steamTest({ out, lower, NAME, script, shots, mt }) {
  const lin = join(out, "content", "linux"), data = join(out, ".test-data"), sock = join(out, ".test.sock");
  rmSync(data, { recursive: true, force: true }); mkdirSync(data, { recursive: true });
  const hash = () => sh("sha256sum", [join(lin, `${NAME}.img`)]).stdout.split(" ")[0];
  const before = hash();
  const env = { PATH: "/usr/bin:/bin", HOME: data, XDG_DATA_HOME: data, HT_AUDIO: "none", HT_DISPLAY: "none" };
  const boot = () => startVM({ bin: "sh", args: [join(lin, `${lower}.sh`), "-monitor", `unix:${sock},server,nowait`], sock,
    shotDir: resolve(shots || join(out, ".test-shots")), env });
  const saves = join(data, NAME, "saves.img");
  const ctx = { vm: await boot(), boot,
    fileExists: (p) => mt("mdir", ["-b", "-i", `${saves}@@${2048 * 512}`, "::/" + p.replace(/^[A-Z]:\//i, "").replace(/^\/+/, "")], true).status === 0 };
  const failed = await runPlay(readFileSync(script, "utf8").split("\n"), ctx);
  if (!ctx.vm.exited()) await ctx.vm.quit();
  const same = hash() === before;
  console.log(`gamec steam test: game disk ${same ? "unchanged" : "CHANGED (snapshot=on failed)"}; play ${failed ? `FAILED (${failed})` : "PASS"}`);
  return failed || !same ? 3 : 0;
}

// QEMU from this Linux system, made portable: the binary, the libraries it links that are not the C library itself, the modules
// (audio, display), and the firmware.  Returns a description or null.
function bundleSystemQemu(dst) {
  const bin = sh("which", ["qemu-system-x86_64"]).stdout.trim();
  mkdirSync(join(dst, "bin"), { recursive: true }); mkdirSync(join(dst, "lib", "qemu"), { recursive: true });
  copyFileSync(bin, join(dst, "bin", "qemu-system-x86_64"));
  // never the C library and its loader: those must be the player's own
  const skip = /^(ld-linux|libc\.so|libm\.so|libdl\.so|libpthread\.so|librt\.so|libresolv\.so)/;
  const libs = new Set();
  const modDir = "/usr/lib/x86_64-linux-gnu/qemu";
  const mods = existsSync(modDir) ? readdirSync(modDir).filter((m) => /^(audio-(pa|pipewire|alsa|sdl)|ui-(gtk|sdl|opengl)|accel-tcg-x86_64)\.so$/.test(m)) : [];
  for (const m of mods) copyFileSync(join(modDir, m), join(dst, "lib", "qemu", m));
  for (const f of [bin, ...mods.map((m) => join(modDir, m))])
    for (const l of sh("ldd", [f]).stdout.split("\n")) {
      const m = l.match(/=>\s+(\S+)/); if (m && !skip.test(basename(m[1]))) libs.add(m[1]);
    }
  for (const l of libs) copyFileSync(l, join(dst, "lib", basename(l)));
  mkdirSync(join(dst, "share"), { recursive: true });
  for (const f of ["bios-256k.bin", "vgabios-stdvga.bin", "kvmvapic.bin", "linuxboot_dma.bin"]) {
    const p = `/usr/share/qemu/${f}`; if (existsSync(p)) copyFileSync(p, join(dst, "share", f));
  }
  if (existsSync("/usr/share/qemu/keymaps")) cpSync("/usr/share/qemu/keymaps", join(dst, "share", "keymaps"), { recursive: true, dereference: true });
  const ver = sh(bin, ["--version"]).stdout.split("\n")[0];
  const pkg = sh("dpkg-query", ["-W", "-f=${Version}", "qemu-system-x86"]).stdout.trim();
  writeFileSync(join(dst, "QEMU-SOURCE.txt"), `QEMU, shipped unmodified with this game so that it runs without installing anything.

${ver}
Binary package: Ubuntu qemu-system-x86 ${pkg} (and its modules), with the shared libraries it needs.
QEMU is free software under the GNU General Public License version 2 (COPYING in this folder); the libraries are under
their own licences (LGPL and others), listed in LIBRARIES.txt.

Source: the exact source of these binaries is the Ubuntu source package "qemu" version ${pkg}:
  https://launchpad.net/ubuntu/+source/qemu/${pkg.replace(/^\d+:/, "")}
A copy of that source is also available from the game's publisher on request for three years from the date this game
was distributed (written offer under GPL-2.0 section 3(b)); see the store page for the contact address.
`);
  for (const lic of ["/usr/share/doc/qemu-system-x86/copyright", "/usr/share/common-licenses/GPL-2"])
    if (existsSync(lic)) copyFileSync(lic, join(dst, lic.endsWith("GPL-2") ? "COPYING" : "copyright"));
  writeFileSync(join(dst, "LIBRARIES.txt"), [...libs].map((l) => {
    const owner = sh("dpkg", ["-S", l]).stdout.split(":")[0] || "?"; return `${basename(l)}  (Ubuntu package ${owner})`;
  }).sort().join("\n") + "\n");
  return `${ver}, ${libs.size} libraries, ${mods.length} modules`;
}
