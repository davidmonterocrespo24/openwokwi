// @vitest-environment jsdom
/**
 * A board-less project must LOAD board-less.
 *
 * Reported live: "dividor resistivo" (9V cell -> 7805 -> divider, no MCU)
 * grew an Arduino Uno on load, and the next save persisted it. The loader
 * conflated boards_json "[]" (an explicit statement: the user removed every
 * board) with a MISSING boards_json (the pre-multi-board era, which is the
 * only case allowed to synthesise a board from board_type).
 */
import { describe, it, expect } from 'vitest';
import { buildLoadPayload } from '../pages/ProjectByIdPage';

const base = {
  id: 'p1',
  name: 'divider',
  board_type: 'arduino-uno',
  code: '',
  components_json: '[{"id":"r1","metadataId":"resistor","x":0,"y":0,"properties":{}}]',
  wires_json: '[]',
  files: [],
  file_groups: [],
};

describe('buildLoadPayload boards', () => {
  it('an explicit empty boards list stays empty', () => {
    const { boards } = buildLoadPayload({ ...base, boards_json: '[]' } as never);
    expect(boards).toEqual([]);
  });

  it('a missing boards_json synthesises the legacy single board', () => {
    const { boards } = buildLoadPayload({ ...base, boards_json: undefined } as never);
    expect(boards).toHaveLength(1);
    expect(boards[0].boardKind).toBe('arduino-uno');
  });

  it('an unparseable boards_json counts as legacy too', () => {
    const { boards } = buildLoadPayload({ ...base, boards_json: 'not json' } as never);
    expect(boards).toHaveLength(1);
  });

  it('a real boards list maps through untouched', () => {
    const { boards } = buildLoadPayload({
      ...base,
      boards_json: JSON.stringify([{ id: 'esp32', boardKind: 'esp32', x: 1, y: 2 }]),
    } as never);
    expect(boards).toHaveLength(1);
    expect(boards[0].boardKind).toBe('esp32');
  });
});
