#!/usr/bin/env bash
export PATH=/mingw64/bin:/usr/bin:$PATH
pacman -S --noconfirm mingw-w64-x86_64-meson 2>&1
echo "=== meson version ==="
meson --version 2>&1
