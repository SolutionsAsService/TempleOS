# Backend: HolyC games on TempleOS

TempleOS holds the only HolyC compiler and the runtime these games need. This backend makes it a build target
instead of a place you type into.

```
 game repo (HolyC + shadw.json)
        │  node Backend/tools/gamec.mjs check     host rules: manifest, lint, include graph, 8.3 names
        ▼
   staged tree ── Backend/Lib (shared runtime) + game files
        │  gamec build                            ISO9660 data disc (xorriso, level 1)
        ▼
   data disc ──► TempleOS VM (QEMU) ◄── TempleOS boot ISO (supplied by you)
                      │  AUTOTEST.HC: install, #include Load, run tests
                      ▼
          COM1 ──► serial.log   BACKEND_OK / BACKEND_FAIL   ──► gamec exit code
```

## State, stated plainly

| Part | State |
|---|---|
| `gamec check` | works; run against ThirdTemple (20 files, 2,066 lines, PASS) |
| `gamec build` | works; the disc for ThirdTemple lists correctly with `xorriso` |
| `gamec run` | written, **never run**: needs a TempleOS boot ISO, and `templeos.org` and `archive.org` are not reachable from the cloud sandbox |
| `Lib/Host.HC` (serial log) | written from the UART register map and the kernel's `InU8`/`OutU8`; **not compiled by TempleOS yet** |

Nothing here is marked verified until a TempleOS run says so (`FORK.md`, rule 3).

## What a game provides

A `shadw.json` with `id`, `title`, `version`, `language: "HolyC"`, `runtime`, `entry`, `load`, `install_path`, and
optionally `tests.templeos`, the line that runs its tests inside TempleOS. `Load.HC` compiles everything and runs
nothing; `Run.HC` loads and launches. ThirdTemple is the reference.

## Using it

```
node Backend/tools/gamec.mjs check ../ThirdTemple
node Backend/tools/gamec.mjs build ../ThirdTemple out/temple.iso
node Backend/tools/gamec.mjs run   ../ThirdTemple --tos TempleOS.ISO --seconds 180
```

Attach the data disc as a second CD in any TempleOS VM, run `Mount;`, then `#include "T:/INSTALL"` (use the drive
letter `Mount` reports).

## Known limits

- Tests that wait for a key (ThirdTemple's `T2Keys`) cannot finish headless. `gamec run` needs an unattended test
  entry; adding one is on the GDADA list.
- The disc carries `.HC .HH .DD .TXT .DAT` only, with names in 8.3.
- The boot ISO is not in this repository. The upstream tree here is source; booting it needs the ISO, which the
  compiler in this tree cannot produce without already running TempleOS.
