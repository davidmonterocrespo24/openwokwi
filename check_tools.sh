#!/usr/bin/env bash
export PATH=/mingw64/bin:/usr/bin:$PATH
cd /e/Hardware/wokwi_clon/wokwi-libs/qemu-lcgamboa
echo "=== gcc ==="
gcc --version 2>&1 | head -1
echo "=== ninja ==="
ninja --version 2>&1 | head -1
echo "=== glib-2.0 ==="
pkg-config --modversion glib-2.0 2>&1
echo "=== slirp ==="
pkg-config --modversion slirp 2>&1 | head -1
echo "=== python ==="
python3 --version 2>&1 | head -1
echo "=== meson ==="
meson --version 2>&1 | head -1
