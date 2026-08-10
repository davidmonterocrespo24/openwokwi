/**
 * PiTerminal — xterm.js terminal wired to RaspberryPi3Bridge serial I/O.
 * Input typed in the terminal is sent to the Pi's ttyAMA0.
 * Output from the Pi's serial port appears in the terminal.
 */

import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { getBoardBridge, useSimulatorStore } from '../../store/useSimulatorStore';
import '@xterm/xterm/css/xterm.css';

interface PiTerminalProps {
  boardId: string;
}

export const PiTerminal: React.FC<PiTerminalProps> = ({ boardId }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  // Keep previous onSerialData so we can chain it (store also appends to serialOutput)
  const prevOnSerialDataRef = useRef<((ch: string) => void) | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
      fontSize: 13,
      theme: {
        background: '#0a0a0a',
        foreground: '#00ff41',
        cursor: '#00ff41',
        selectionBackground: 'rgba(0, 255, 65, 0.25)',
      },
      cursorBlink: true,
      scrollback: 2000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // Slight delay to allow layout to settle before fitting
    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch (_) {
        /* ignore if dimensions not ready */
      }
      // Without an explicit focus call xterm.js stays passive — onData
      // only fires when the DOM element has focus, so users staring at
      // a working prompt see no echo because their keystrokes go to
      // whatever element had focus at mount time (canvas, code editor).
      try { term.focus(); } catch (_) { /* container may not be visible */ }
    });

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Seed with the session's accumulated output so mounting mid-boot (the
    // panel opens on demand) shows the boot log instead of a blank screen.
    const history = useSimulatorStore
      .getState()
      .boards.find((b) => b.id === boardId)?.serialOutput;
    if (history) term.write(history.slice(-8000));

    // Wire terminal input → Pi bridge
    const onDataDispose = term.onData((data) => {
      const bridge = getBoardBridge(boardId);
      if (bridge) {
        bridge.sendSerialBytes(Array.from(new TextEncoder().encode(data)));
      }
    });

    // Intercept bridge serial output → terminal display
    const bridge = getBoardBridge(boardId);
    if (bridge) {
      prevOnSerialDataRef.current = bridge.onSerialData;
      bridge.onSerialData = (ch: string) => {
        term.write(ch);
        // Also call the original store callback so serialOutput stays in sync
        prevOnSerialDataRef.current?.(ch);
      };
    }

    return () => {
      onDataDispose.dispose();
      // Restore original bridge callback
      const bridgeOnCleanup = getBoardBridge(boardId);
      if (bridgeOnCleanup && bridgeOnCleanup.onSerialData !== null) {
        bridgeOnCleanup.onSerialData = prevOnSerialDataRef.current;
      }
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [boardId]);

  // ResizeObserver → refit terminal when container size changes
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => {
      try {
        fitAddonRef.current?.fit();
      } catch (_) {
        /* ignore */
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        height: '100%',
        width: '100%',
        overflow: 'hidden',
        background: '#0a0a0a',
      }}
    />
  );
};
