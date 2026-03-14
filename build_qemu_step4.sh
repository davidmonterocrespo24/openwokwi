#!/usr/bin/env bash
# Step 4: Relink qemu-system-xtensa as libqemu-xtensa.dll
set -euo pipefail
export PATH=/mingw64/bin:/usr/bin:$PATH

BUILD="/e/Hardware/wokwi_clon/wokwi-libs/qemu-lcgamboa/build"
OUT="/e/Hardware/wokwi_clon/backend/app/services"
cd "$BUILD"

echo "=== Extracting link command from build.ninja ==="

python3 << 'PYEOF'
import re, subprocess, sys, os

with open('build.ninja') as f:
    content = f.read()

# Find build block for qemu-system-xtensa.exe
idx = content.find('build qemu-system-xtensa.exe:')
if idx < 0:
    print('Target not found!'); sys.exit(1)

block = content[idx:]
end = block.find('\nbuild ', 1)
if end > 0:
    block = block[:end]

# Extract LINK_ARGS and LINK_PATH
link_args = ''
link_path = ''
for line in block.split('\n'):
    line = line.strip()
    if line.startswith('LINK_ARGS ='):
        link_args = line.split('=', 1)[1].strip()
    elif line.startswith('LINK_PATH ='):
        link_path = line.split('=', 1)[1].strip()

# Extract all input objects (everything after c_LINKER_RSP on line 1, excluding the | deps part)
first_line = block.split('\n')[0]
# Remove "build qemu-system-xtensa.exe: c_LINKER_RSP "
objs_raw = first_line.split('c_LINKER_RSP ', 1)[1]
# Remove pipe section (| implicit deps)
if ' | ' in objs_raw:
    objs_raw = objs_raw.split(' | ')[0]
objs = objs_raw.split()

# Remove softmmu_main.c.obj (contains main())
objs = [o for o in objs if 'softmmu_main' not in o]

# Also add qemu-system-xtensa.exe.p objects (target-specific .obj files)
# Find them in the .p directory
p_dir = 'qemu-system-xtensa.exe.p'
if os.path.isdir(p_dir):
    for f in os.listdir(p_dir):
        if f.endswith('.obj') and 'softmmu_main' not in f:
            path = f'{p_dir}/{f}'
            if path not in objs:
                objs.append(path)

print(f'Objects count: {len(objs)}')
print(f'LINK_ARGS: {link_args[:200]}')
print(f'LINK_PATH: {link_path}')

# Build the DLL link command
cmd = (
    f'cc -m64 -mcx16 -shared -Wl,--export-all-symbols -Wl,--allow-multiple-definition '
    f'-o libqemu-xtensa.dll '
    f'{" ".join(objs)} '
    f'{link_path} '
    f'{link_args}'
)

print(f'\nLink command length: {len(cmd)}')

# Write to a response file to avoid command line length issues
with open('dll_link.rsp', 'w') as f:
    f.write(
        f'-shared -Wl,--export-all-symbols -Wl,--allow-multiple-definition '
        f'-o libqemu-xtensa.dll '
        f'{" ".join(objs)} '
        f'{link_path} '
        f'{link_args}'
    )

print('Written to dll_link.rsp')
PYEOF

echo ""
echo "=== Linking libqemu-xtensa.dll ==="
cc -m64 -mcx16 @dll_link.rsp 2>&1
echo "=== Link exit code: $? ==="

if [ -f libqemu-xtensa.dll ]; then
    echo ""
    echo "=== SUCCESS: libqemu-xtensa.dll ==="
    ls -lh libqemu-xtensa.dll

    echo ""
    echo "=== Checking picsimlab exports ==="
    objdump -p libqemu-xtensa.dll 2>/dev/null | grep -iE "picsimlab|qemu_init|qemu_main" | head -20

    echo ""
    echo "=== Copying to backend/app/services ==="
    cp libqemu-xtensa.dll "$OUT/"
    echo "Copied!"
else
    echo "FAILED - DLL not produced"
    exit 1
fi
