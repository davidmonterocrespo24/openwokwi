/**
 * NewProjectDialog starter sections — display order and overlay cards.
 *
 * The dialog hardcodes its sections; overlay-registered kinds (M5Stack,
 * the partner sections, the XIAO overlay variants) surface only when the
 * private overlay registered them. Guards the operator's requested order:
 * the partner sections (M5Stack, DFRobot, Pimoroni, Espressif) sit between
 * ESP32 and STM32, Seeed boards live inside the chip-family sections, and
 * an OSS build shows no empty partner block.
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

  it('the S3 Sense joins the ESP32 section, not a section of its own', () => {
    const secs = buildStarterSections([def('xiao-esp32s3-sense', 'XIAO ESP32-S3 Sense', 'x')]);
    expect(secs.map((s) => s.title)).not.toContain('Seeed Studio');
    const esp32 = secs.find((s) => s.title === 'ESP32')!;
    expect(esp32.entries.map((e) => e.kind)).toContain('xiao-esp32s3-sense');
    // Right after its sibling XIAO S3.
    const kinds = esp32.entries.map((e) => e.kind);
    expect(kinds.indexOf('xiao-esp32s3-sense')).toBe(kinds.indexOf('xiao-esp32-s3') + 1);
  });

  it('full partner overlay: sections sit between M5Stack and STM32, catalog order', () => {
    const defs = [
      def('cardputer-adv', 'M5 Cardputer ADV', 'x'),
      def('m5stack-core', 'M5Stack Core', 'x'),
      def('xiao-esp32s3-sense', 'XIAO ESP32-S3 Sense', 'x'),
      def('unihiker-m10', 'UNIHIKER M10', 'x'),
      def('pimoroni-pico-plus-2w', 'Pico Plus 2 W', 'x'),
      def('badger-2350', 'Badger 2350', 'x'),
      def('stellar-unicorn', 'Stellar Unicorn', 'x'),
      def('esp32-c3-lcdkit', 'ESP32-C3-LCDkit', 'x'),
    ];
    expect(titles(defs)).toEqual([
      'Arduino',
      'ESP32',
      'M5Stack',
      'DFRobot',
      'Pimoroni',
      'Espressif',
      'STM32',
      'Raspberry Pi',
    ]);
    const pim = buildStarterSections(defs).find((s) => s.title === 'Pimoroni')!;
    expect(pim.entries.map((e) => e.kind)).toEqual([
      'pimoroni-pico-plus-2w',
      'badger-2350',
      'stellar-unicorn',
    ]);
  });

  it('embargoed partner boards (not registered) leave their section unrendered', () => {
    // Pimoroni launched, Espressif still under embargo: no Espressif block.
    const defs = [
      def('pimoroni-pico-plus-2w', 'Pico Plus 2 W', 'x'),
      def('badger-2350', 'Badger 2350', 'x'),
    ];
    expect(titles(defs)).toEqual(['Arduino', 'ESP32', 'Pimoroni', 'STM32', 'Raspberry Pi']);
  });

  it('a partial overlay (only one M5 kind) still renders the section with that card', () => {
    const m5 = buildStarterSections([def('m5stack-core', 'M5Stack Core', 'x')]).find(
      (s) => s.title === 'M5Stack',
    )!;
    expect(m5.entries.map((e) => e.kind)).toEqual(['m5stack-core']);
  });
});
