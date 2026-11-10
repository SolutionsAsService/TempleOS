#!/bin/sh
# Boot the TempleOS live CD in QEMU.  Usage: ISO/run-qemu.sh [extra qemu args]
#   - needs qemu-system-x86_64 (apt-get install qemu-system-x86)
#   - with a display: opens a window; headless: add  -display none -vnc :0
#   - TempleOS needs a 64-bit CPU and at least 512 MB of RAM; 1 GB is used here
#   - KVM is used when /dev/kvm exists, otherwise QEMU emulates (slower, still boots)
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
ACCEL=""
[ -w /dev/kvm ] && ACCEL="-enable-kvm -cpu host"
exec qemu-system-x86_64 -m 1024 -smp 2 $ACCEL -cdrom "$DIR/TempleOS.ISO" -boot d -vga std "$@"
