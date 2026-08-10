/**
 * boardPinToNumber — the bridge between a board element's PAD NAMES and the
 * GPIO numbers the simulators speak.
 *
 * A board whose kind has no branch here falls through to `return null`, and a
 * null pin means every wire to that header silently connects to nothing: the
 * part sits on the canvas, the sketch reads a dead pin, and nothing reports an
 * error. That is what happened to the M5 Cardputer, whose EXT header and Grove
 * Port A were unreachable even though the element drew them.
 */
import { describe, expect, it } from 'vitest';
import { boardPinToNumber } from '../utils/boardPinMapping';

describe('boardPinToNumber — M5 Cardputer ADV header', () => {
  // The pad names CardputerElement.ts renders on its wireable bottom row.
  const GPIO_NAMES = ['3', '4', '5', '6', '8', '9', '13', '14', '15', '39', '40', '2', '1'];

  it('maps every GPIO pad to its own number', () => {
    for (const name of GPIO_NAMES) {
      expect(boardPinToNumber('cardputer-adv', name)).toBe(Number(name));
    }
  });

  it('leaves no pad unmapped', () => {
    const unmapped = GPIO_NAMES.filter((n) => boardPinToNumber('cardputer-adv', n) === null);
    expect(unmapped).toEqual([]);
  });

  it('maps the power pads to -1, not to a GPIO', () => {
    expect(boardPinToNumber('cardputer-adv', '5V')).toBe(-1);
    expect(boardPinToNumber('cardputer-adv', 'GND')).toBe(-1);
  });

  it('accepts G40, which the classic ESP32 range would have rejected', () => {
    // The shared esp32 branch clamps at 39; the S3 has 48 GPIOs and this board
    // exposes 40 on its header.
    expect(boardPinToNumber('cardputer-adv', '40')).toBe(40);
  });

  it('rejects a pad that is not a pin', () => {
    expect(boardPinToNumber('cardputer-adv', 'NOPE')).toBeNull();
    expect(boardPinToNumber('cardputer-adv', '99')).toBeNull();
  });
});
