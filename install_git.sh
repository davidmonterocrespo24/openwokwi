#!/usr/bin/env bash
export PATH=/mingw64/bin:/usr/bin:$PATH
pacman -S --noconfirm git mingw-w64-x86_64-git 2>&1 || pacman -S --noconfirm git 2>&1
git --version 2>&1
