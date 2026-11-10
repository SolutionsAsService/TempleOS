# Backend: HolyC games on TempleOS

TempleOS holds the only HolyC compiler and the runtime these games need. This backend makes it a build target
instead of a place you type into.

```
 game repo (HolyC + shadw.json)
        │  node Backend/tools/gamec.mjs check     host rules: manifest, lint, include graph, 8.3 names
        ▼
   staged tree ── Backend/Lib (shared runtime) + game files
        │  gamec build                            FAT32 hard-disk image (mkfs.fat + mcopy)
        ▼
   game disk ──► TempleOS live CD in QEMU (V5.03 ISO, supplied by you)
                      │  typed through the QEMU monitor: MountIDEAuto;  #include "C:/AUTOTEST"
                      │  AUTOTEST.HC: the disk becomes boot drive and home, compile + tests inside ExePutS
                      ▼
          COM1 ──► serial.log   BACKEND_OK / BACKEND_FAIL + the whole terminal text   ──► gamec exit code
```

## State, stated plainly

| Part | State |
|---|---|
| `gamec check` | works; ThirdTemple 61 files PASS (adds: lone `$`, `continue`) |
| `gamec build` | works; a 64 MB MBR + FAT32 image that TempleOS V5.03 mounts as `C:` (2026-11-10) |
| `gamec run` | **works** (2026-11-10, TempleOS V5.03 live CD, QEMU 8.2 TCG, no KVM): boot to verdict in about 70 s; ThirdTemple's `Load.HC` compiles in about 45 s and `Tests/Auto` passes (T3 FILE, T4 MEM, TWORLD) |
| `Lib/Host.HC` (serial log) | compiled and run by TempleOS: `HostLog`, `HostDone`, `HostDocDump` reach `serial.log` |

Why a hard disk and not a CD: V5.03 reads files only from RedSea and FAT32 (`FSt_ISO9660` is "Not Supported";
`Kernel/BlkDev/DskFile.HC` dispatches only those two), so an ISO9660 data disc mounts but cannot be read.

Nothing here is marked verified until a TempleOS run says so (`FORK.md`, rule 3).

## What a game provides

A `shadw.json` with `id`, `title`, `version`, `language: "HolyC"`, `runtime`, `entry`, `load`, `install_path`, and
optionally `tests.templeos`, the line that runs its tests inside TempleOS. `Load.HC` compiles everything and runs
nothing; `Run.HC` loads and launches. ThirdTemple is the reference.

## Using it

```
node Backend/tools/gamec.mjs check ../ThirdTemple
node Backend/tools/gamec.mjs build ../ThirdTemple out/temple.img
node Backend/tools/gamec.mjs run   ../ThirdTemple out/temple.img --tos TempleOS.ISO --out out --shots out/shots
#   compile only:  --exec '#include "::/Home/HolyTemple/Load"'
#   tests + a driven tour with screenshots:
#   --exec '#include "::/Home/HolyTemple/Tests/Auto";#include "::/Home/HolyTemple/Tests/TShots"' --counter tt_fails \
#   --play ../ThirdTemple/tools/shots.play
```

Needs `qemu-system-x86_64`, `mkfs.fat` and `mcopy` (`apt-get install qemu-system-x86 dosfstools mtools`), and
`convert` (ImageMagick) for PNG screenshots. The TempleOS ISO is on branch `claude/3d-env-setup-4t39tp` at
`ISO/TempleOS.ISO` (keep it out of other branches: `git show origin/claude/3d-env-setup-4t39tp:ISO/TempleOS.ISO > TempleOS.ISO`).

How `run` drives the live CD: it reads the screen by matching 8x8 cells of QEMU `screendump` against the kernel's own
font (`Kernel/FontStd.HC`), answers `n` to "Install onto hard drive" and "Take Tour", types `MountIDEAuto;` and
`#include "C:/AUTOTEST"` with `sendkey`. AUTOTEST sets `blkdev.boot_drv_let` to the game disk and `HomeSet("::/Home")`
(the CD is read only), runs the tests inside `ExePutS` (a compile error is caught, not fatal), then `HostDocDump`
sends the terminal text to COM1: every compiler error and warning arrives with its `[file,line]`.

On an installed TempleOS: attach the image as a hard disk, `MountIDEAuto;` (or `Mount;`), then `#include "D:/INSTALL"`
with the letter it reports.

## Known limits

- Tests that wait for a key (ThirdTemple's `T2Keys`) cannot finish headless; `Tests/Auto.HC` leaves them out and `tests.templeos_auto` points at it.
- The disk carries `.HC .HH .DD .TXT .DAT` only, with names in 8.3; `"disc_exclude"` in `shadw.json` names host-only folders.
- Screen reading is exact only for text drawn on the 8x8 grid; game graphics read as noise, which is fine for prompts.
- `--play` scripts are timed, not synchronised: the game clock also runs in real time.
- The boot ISO is not in this repository. The upstream tree here is source; booting it needs the ISO, which the
  compiler in this tree cannot produce without already running TempleOS.
