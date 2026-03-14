#!/usr/bin/env bash
# Build libqemu-xtensa.dll from lcgamboa QEMU (MSYS2 MINGW64)
set -euo pipefail

export PATH=/mingw64/bin:/usr/bin:$PATH
export MINGW_PREFIX=/mingw64

REPO="/e/Hardware/wokwi_clon/wokwi-libs/qemu-lcgamboa"
OUT="/e/Hardware/wokwi_clon/backend/app/services"

cd "$REPO"
echo "=== Working dir: $(pwd) ==="
echo "=== Step 1: Patch meson.build for libiconv ==="
if grep -q "qemu_ldflags = \[\]" meson.build; then
    sed -z -i "s/qemu_ldflags = \[\]/qemu_ldflags = \['-liconv','-Wl,--allow-multiple-definition'\]/g" -- meson.build
    echo "  Patched OK"
else
    echo "  Already patched or pattern not found"
fi

echo ""
echo "=== Step 2: Configure ==="
./configure \
    --target-list=xtensa-softmmu \
    --disable-werror \
    --disable-alsa \
    --enable-tcg \
    --enable-system \
    --enable-gcrypt \
    --enable-slirp \
    --enable-iconv \
    --enable-debug \
    --enable-debug-info \
    --without-default-features \
    2>&1 || { echo "CONFIGURE FAILED"; cat meson-logs/meson-log.txt 2>/dev/null | tail -50; exit 1; }

echo ""
echo "=== Step 3: Build ($(nproc) cores) ==="
make -j$(nproc) 2>&1

echo ""
echo "=== Step 4: Relink as DLL ==="
cd build

echo "  Removing old qemu-system-xtensa to force ninja to output link command..."
rm -f qemu-system-xtensa.exe qemu-system-xtensa.rsp qemu-system-xtensa_.rsp

echo "  Capturing ninja link command..."
ninja -v -d keeprsp 2>&1 > qemu-system-xtensa_.rsp

echo "  Extracting last line (link command)..."
sed -i -n '$p' qemu-system-xtensa_.rsp

CMD=$(sed 's/-o .*//' qemu-system-xtensa_.rsp | sed 's/\[.\/.\] //g' | sed 's/@qemu-system-xtensa.rsp//g')

if [ ! -f qemu-system-xtensa.rsp ]; then
    cp qemu-system-xtensa_.rsp qemu-system-xtensa.rsp
fi
sed -i 's/.*-o /-o /' qemu-system-xtensa.rsp

# Remove main(), change output to DLL
sed -i 's|qemu-system-xtensa.p/softmmu_main.c.o||g' qemu-system-xtensa.rsp
sed -i 's|-o qemu-system-xtensa|-shared -Wl,--export-all-symbols -o libqemu-xtensa.dll|g' qemu-system-xtensa.rsp

echo "  Linking DLL..."
eval "$CMD -ggdb @qemu-system-xtensa.rsp" 2>&1

if [ -f libqemu-xtensa.dll ]; then
    echo ""
    echo "=== SUCCESS: libqemu-xtensa.dll created ==="
    ls -lh libqemu-xtensa.dll

    echo ""
    echo "=== Checking exports ==="
    objdump -p libqemu-xtensa.dll 2>/dev/null | grep -E "qemu_picsimlab|qemu_init|qemu_main" | head -20 || echo "objdump not available"

    echo ""
    echo "=== Copying to backend ==="
    cp libqemu-xtensa.dll "$OUT/"
    echo "  Copied to $OUT/libqemu-xtensa.dll"
else
    echo "FAILED: libqemu-xtensa.dll not produced"
    exit 1
fi
