/**
 * The hardware-serial TX seam (lib/proHardwareSerial.ts): while a real
 * board's monitor is attached, serial input routes to the interceptor;
 * detaching restores simulator routing. Per-board, inert by default.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  getSerialTxInterceptor,
  installSerialTxInterceptor,
} from '../lib/proHardwareSerial';

describe('proHardwareSerial seam', () => {
  it('has no interceptor by default (pure OSS build)', () => {
    expect(getSerialTxInterceptor('board-1')).toBeNull();
  });

  it('routes per board and uninstalls with null', () => {
    const toHardware = vi.fn();
    installSerialTxInterceptor('board-1', toHardware);

    expect(getSerialTxInterceptor('board-2')).toBeNull();
    getSerialTxInterceptor('board-1')?.('hello\n');
    expect(toHardware).toHaveBeenCalledWith('hello\n');

    installSerialTxInterceptor('board-1', null);
    expect(getSerialTxInterceptor('board-1')).toBeNull();
  });
});
