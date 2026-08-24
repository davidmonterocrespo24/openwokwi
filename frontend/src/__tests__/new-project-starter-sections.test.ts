/**
 * NewProjectDialog starter sections — display order and overlay cards.
 *
 * The dialog hardcodes its sections; overlay-registered kinds (M5Stack,
 * XIAO C6, XIAO RP2040) surface only when the private overlay registered
 * them. Guards the operator's requested order: M5Stack (Cardputer ADV, then
 * Core) sits ahead of STM32, and an OSS build shows no empty M5Stack block.
 */
import { describe, it, expect } from 'vitest';
import { buildStarterSections } from '../components/editor/NewProjectDialog';
import type { ProBoardDef } from '../lib/proBoardRegistry';

const def = (kind: string, label: string, description: string): ProBoardDef => ({
  kind,
  label,
  description,
  fqbn: null,
  tag: `velxio-${kind}`,
  size: { w: 100, h: 100 },
});

const titles = (defs: ProBoardDef[]) =>
  buildStarterSections(defs)
    .filter((s) => s.entries.length > 0)
    .map((s) => s.title);

describe('NewProjectDialog starter sections', () => {
  it('OSS build (no overlay boards) shows no M5Stack section', () => {
    expect(titles([])).toEqual(['Arduino', 'ESP32', 'STM32', 'Raspberry Pi']);
  });

  it('with the M5Stack overlay boards registered, M5Stack comes before STM32', () => {
    const defs = [
      def('m5stack-core', 'M5Stack Core', 'ESP32 all-in-one'),
      def('cardputer-adv', 'M5 Cardputer ADV', 'ESP32-S3 card computer'),
    ];
    const order = titles(defs);
    expect(order).toEqual(['Arduino', 'ESP32', 'M5Stack', 'STM32', 'Raspberry Pi']);
    expect(order.indexOf('M5Stack')).toBeLessThan(order.indexOf('STM32'));

    const m5 = buildStarterSections(defs).find((s) => s.title === 'M5Stack')!;
    // Cardputer ADV first, then the Core — regardless of registration order.
    expect(m5.entries.map((e) => e.kind)).toEqual(['cardputer-adv', 'm5stack-core']);
    // Card blurb comes from the registered definition, not a hardcoded string.
    expect(m5.entries[0].blurb).toBe('ESP32-S3 card computer');
  });

  it('a partial overlay (only one M5 kind) still renders the section with that card', () => {
    const m5 = buildStarterSections([def('m5stack-core', 'M5Stack Core', 'x')]).find(
      (s) => s.title === 'M5Stack',
    )!;
    expect(m5.entries.map((e) => e.kind)).toEqual(['m5stack-core']);
  });
});
