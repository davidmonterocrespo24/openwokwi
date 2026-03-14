#!/usr/bin/env bash
export PATH=/mingw64/bin:/usr/bin:$PATH
# Install pip and distlib
pacman -S --noconfirm mingw-w64-x86_64-python-pip mingw-w64-x86_64-python-distlib 2>&1 || true
# Check what python packages are available
pacman -Ss python-distlib 2>&1 | head -10
pacman -Ss python-pip 2>&1 | head -5
