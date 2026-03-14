#!/usr/bin/env bash
export PATH=/mingw64/bin:/usr/bin:$PATH

cd /e/Hardware/wokwi_clon/wokwi-libs/qemu-lcgamboa/build
echo "=== Building qemu-system-xtensa.exe only ==="
ninja -j$(nproc) qemu-system-xtensa.exe 2>&1
echo "=== Build exit code: $? ==="
ls -lh qemu-system-xtensa.exe 2>/dev/null || echo "Binary not found"
