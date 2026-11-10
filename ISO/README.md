# TempleOS V5.03 ISO

`TempleOS.ISO` is the official live CD, downloaded unmodified from https://templeos.org/Downloads/TempleOS.ISO
on 2026-11-10.

| | |
|---|---|
| Size | 17,350,656 bytes |
| SHA-1 | `411287597741d045a1860d25a15aaad2a7fc2151` |
| SHA-256 | `5d0fc944e5d89c155c0fc17c148646715bc1db6fa5750c0b913772cfec19ba26` |

Check it with `sha256sum -c SHA256SUMS` from this folder.

## Run it

```sh
ISO/run-qemu.sh                          # window
ISO/run-qemu.sh -display none -vnc :0    # headless, connect a VNC viewer to :5900
```

It was booted this way (QEMU 8.2, no KVM) and reached the TempleOS V5.03 desktop with the live CD's
"Install onto hard drive (y or n)?" prompt after about two minutes; answer **n** to try it without installing.
`boot-qemu.png` is that screen.

## Why not build it from this repository

The rest of this repository is the V5.03 source tree, but a bootable CD cannot be made from it with Linux tools.
The V5.03 kernel mounts a CD only in TempleOS's own RedSea filesystem (or FAT32), and the CD boot loader
(`Adam/Opt/Boot/BootDVD.HC`) has to be patched with the kernel's block address by TempleOS itself
(`BootDVDIns`, `DskISORedSea.HC`). An ISO 9660 image built from these files with `xorriso` stops at
"Booting from DVD/CD...". Booting this ISO and running `::/Misc/DoDistro.HC` inside TempleOS is the way to
build a new one.

TempleOS is public domain (Terry A. Davis).
