/**
 * The pro web-flash seam (lib/proWebFlash.ts) must be inert in OSS
 * builds and delegate cleanly when an overlay installs an impl.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getWebFlashImpl,
  installWebFlashImpl,
  webFlashAvailable,
  webFlashMpyAvailable,
  type WebFlashImpl,
} from '../lib/proWebFlash';

const fakeImpl = (available: (kind: string) => boolean): WebFlashImpl => ({
  available,
  flash: vi.fn(),
});

describe('proWebFlash seam', () => {
  afterEach(() => {
    installWebFlashImpl(null);
  });

  it('is inert without an overlay (pure OSS build)', () => {
    expect(getWebFlashImpl()).toBeNull();
    expect(webFlashAvailable('esp32')).toBe(false);
    expect(webFlashAvailable('arduino-uno')).toBe(false);
  });

  it('delegates availability to the installed impl per board kind', () => {
    installWebFlashImpl(fakeImpl((kind) => kind === 'esp32'));
    expect(webFlashAvailable('esp32')).toBe(true);
    expect(webFlashAvailable('arduino-uno')).toBe(false);
  });

  it('clearing the impl restores the OSS default (hot reload)', () => {
    installWebFlashImpl(fakeImpl(() => true));
    expect(webFlashAvailable('esp32')).toBe(true);
    installWebFlashImpl(null);
    expect(webFlashAvailable('esp32')).toBe(false);
  });

  it('MicroPython availability requires the optional method AND board support', () => {
    expect(webFlashMpyAvailable('esp32')).toBe(false); // no impl
    installWebFlashImpl(fakeImpl((kind) => kind === 'esp32'));
    expect(webFlashMpyAvailable('esp32')).toBe(false); // impl without flashMicroPython
    installWebFlashImpl({
      ...fakeImpl((kind) => kind === 'esp32'),
      flashMicroPython: vi.fn(),
    });
    expect(webFlashMpyAvailable('esp32')).toBe(true);
    expect(webFlashMpyAvailable('arduino-uno')).toBe(false); // unsupported board
  });

  it('swallows a throwing available() instead of breaking the menu', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installWebFlashImpl(
      fakeImpl(() => {
        throw new Error('overlay bug');
      }),
    );
    expect(webFlashAvailable('esp32')).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
