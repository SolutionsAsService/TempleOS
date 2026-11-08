# This is a fork

This repository is **SolutionsAsService/TempleOS**, a fork of the TempleOS V5.03 source tree (the cia-foundation snapshot).
Terry A. Davis wrote TempleOS and placed it in the public domain. Everything outside `Backend/` and this file is
upstream and is kept untouched, so a diff against upstream shows only our work.

## What the fork is for

The fork is the **backend for HolyC games**. TempleOS ships the only real HolyC compiler and the runtime these games
target (640x480, 16 colours, `GrBlot`, `GetMsg`, `Snd`). The fork turns that into a build target:

- `Backend/Lib/` is the shared HolyC runtime that games link against, so each game stops carrying its own copy of the
  input loop, the palette handling, the log, and the like.
- `Backend/tools/gamec.mjs` is the host-side driver. It checks a game, stages it, and builds a disc image that TempleOS
  can mount. When a TempleOS boot image is supplied, it boots QEMU and collects the compiler's verdict.
- `Backend/GDADA.md` is the manager's plan. GDADA picks the next step; this file records what it decided and why.

Read `Backend/README.md` next.

## Rules for this fork

1. Do not edit upstream files. Add under `Backend/`. If the kernel or compiler must change, the change is a patch file
   in `Backend/patches/` with the reason beside it.
2. HolyC stays HolyC. No transpiling to another language; the compiler we use is the one in `Compiler/`.
3. A claim about the compiler or the runtime is marked **verified** only when it came from a TempleOS run.
