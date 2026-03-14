#!/usr/bin/env bash
export PATH=/mingw64/bin:/usr/bin:$PATH
# Install distlib into the system python so QEMU configure can find it
python3 -m pip install distlib 2>&1
echo "=== distlib installed ==="
python3 -c "import distlib; print('distlib version:', distlib.__version__)"
