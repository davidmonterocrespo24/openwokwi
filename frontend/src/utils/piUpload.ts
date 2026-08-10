/**
 * piUpload — flow-controlled file upload into a running QEMU-Linux guest
 * over the serial console (heredocs, prompt-gated). Extracted from the
 * VirtualFileSystem panel so the auto-run path (ProBoardDef.autoRun) can
 * reuse the exact same sequence.
 */
import type { RaspberryPi3Bridge } from '../simulation/RaspberryPi3Bridge';

export async function uploadFilesToPi(
  bridge: RaspberryPi3Bridge,
  files: Array<{ path: string; content: string }>,
): Promise<void> {
  if (files.length === 0) return;

  // Flow-controlled sends: wait for the shell prompt to return after each
  // command instead of guessing with fixed delays (long lines used to drop
  // on the unflow-controlled console). Ensure a clean prompt + rw rootfs.
  await bridge.sendAndWaitForPrompt('\n', 4000);
  await bridge.sendAndWaitForPrompt('mount -o remount,rw / 2>/dev/null; true\n', 6000);

  for (const { path, content } of files) {
    // Create parent dir (before the heredoc, so the path exists).
    const dir = path.substring(0, path.lastIndexOf('/'));
    if (dir) await bridge.sendAndWaitForPrompt(`mkdir -p ${dir}\n`, 6000);

    // Write the file via a heredoc with a unique delimiter. Open it, stream
    // the body in small chunks so the console FIFO doesn't overflow on large
    // files, then close it and wait for the prompt.
    const delim = `VELXIO_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    bridge.sendSerialText(`cat > ${path} << '${delim}'\n`);
    const body = `${normalized}\n`;
    for (let i = 0; i < body.length; i += 256) {
      bridge.sendSerialText(body.slice(i, i + 256));
      await new Promise((r) => setTimeout(r, 25));
    }
    await bridge.sendAndWaitForPrompt(`${delim}\n`, 8000);

    // Make scripts executable (after the file exists).
    if (path.endsWith('.py') || path.endsWith('.sh')) {
      await bridge.sendAndWaitForPrompt(`chmod +x ${path}\n`, 5000);
    }
  }
}
