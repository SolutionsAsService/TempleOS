# GDADA: game maker and manager

GDADA is DADA turned to games, run as a **manager** over many games rather than a designer of one. It owns four
things: the registry (`games.json`), the gates a game must pass, the choice of the next step, and the record of why.

## Gates (a game climbs them in order; the manager never skips one)

| Gate | Question | Evidence it needs |
|---|---|---|
| G0 Runtime | Can the target compiler run here? | A TempleOS boot ISO and QEMU. *Added after the ThirdTemple run, whose log named this gap.* |
| G1 Host | Does the tree pass `gamec check`? | exit 0 |
| G2 Compile | Does TempleOS compile `Load.HC`? | `BACKEND_BEGIN` and no compiler error in the serial log |
| G3 Tests | Do the game's TempleOS tests pass unattended? | `BACKEND_OK` |
| G4 Played | Has a person or a bot played it in the VM? | a recorded session or screendump set |
| G5 Panel | Has a played WHOLE panel round passed? | the DADA panel protocol on the played build |

A claim about a gate is written with the gate's number and what produced it. "Works" is not a gate.

## Next-step rule

1. Take the lowest gate any game has not passed.
2. If that gate is G0, the step is to get the runtime, ahead of any design work, because every later gate depends on it.
3. Otherwise take the step that turns that gate green for the game with the most unmet must-haves.
4. Ties go to the step that also lifts the shared `Lib/`, since that helps every game.

## Decision record D1 (this session)

- **Move:** fork TempleOS as the compiler backend; keep upstream untouched; add `Backend/`.
- **Options:** (a) transpile HolyC to C on the host: refused, it breaks "genuine HolyC" and loses the TempleOS API;
  (b) run TempleOS under QEMU as a headless build farm: **chosen**; (c) port the compiler to run on Linux: possible
  later, large, and unverifiable without (b) as the oracle.
- **Measurement:** `gamec check` on ThirdTemple, 20 files, 2,066 lines, exit 0. QEMU 8.2.2 and xorriso 1.5.6 installed
  here. The data disc builds and lists 29 nodes.
- **Not measured:** everything past the disc. G0 is open: no boot ISO is reachable from this sandbox.
- **Result:** KEEP. The pipeline is host-complete up to the VM boundary.

## Frontier (next steps, in order)

1. **G0:** obtain a TempleOS V5.03 boot ISO. The sandbox cannot reach templeos.org or archive.org, so the person
   supplies it (as a file in a repo release or a path), or the environment allows the host.
2. Run `gamec run` for ThirdTemple; fix compile errors it reports; flip `compiled_in_templeos` in `games.json`.
3. Give games an unattended test entry (`Tests/Auto.HC`) so G3 can run headless.
4. Lift the generic parts of ThirdTemple (`Palette`, `Dialogue`, `Save`, the input loop, `Audio`) into `Lib/`.
5. A second game in the registry, to prove the backend is not shaped to one game.
6. Turn the manager into a skill (`gdada`) that reads `games.json`, evaluates the gates, and prints the next step.
