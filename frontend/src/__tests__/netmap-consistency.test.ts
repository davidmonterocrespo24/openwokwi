/**
 * The net-name map is derived in more than one place. Any disagreement with
 * NetlistBuilder is a silent wrong-reading bug: the auto-generated names are
 * positional (n0, n1, ...), so dropping or adding a single net shifts every
 * later name and a consumer reads a NEIGHBOURING node's voltage.
 *
 * Found in the wild via a user's board-less 7805 divider, where the voltmeter
 * showed 1.56 V instead of 3.44 V. These cases pin the two remaining ways
 * buildWireNetMap used to drift from buildNetlist.
 */
import { describe, it, expect } from 'vitest';
import { buildNetlist, buildWireNetMap } from '../simulation/spice/NetlistBuilder';

type Input = Parameters<typeof buildWireNetMap>[0];

function expectAgreement(input: Input) {
  const { pinNetMap } = buildNetlist({ ...input, analysis: { kind: 'op' } });
  const wireMap = buildWireNetMap(input);
  for (const w of input.wires) {
    const fromBuilder = pinNetMap.get(`${w.start.componentId}:${w.start.pinName}`);
    expect(wireMap.get(w.id), `wire ${w.id}`).toBe(fromBuilder);
  }
}

describe('buildWireNetMap agrees with buildNetlist', () => {
  it('when a board ground pin is missing from groundPinNames', () => {
    expectAgreement({
      components: [
        { id: 'r1', metadataId: 'resistor', properties: { value: '1k' } },
        { id: 'r2', metadataId: 'resistor', properties: { value: '2k' } },
      ],
      wires: [
        { id: 'w1', start: { componentId: 'brd', pinName: '3V3' }, end: { componentId: 'r1', pinName: '1' } },
        { id: 'w2', start: { componentId: 'r1', pinName: '2' }, end: { componentId: 'r2', pinName: '1' } },
        // "GND2" is a real dev-kit spelling that BOARD_PIN_GROUPS often omits.
        { id: 'w3', start: { componentId: 'r2', pinName: '2' }, end: { componentId: 'brd', pinName: 'GND2' } },
      ],
      boards: [{ id: 'brd', vcc: 3.3, pins: {}, groundPinNames: ['GND'], vccPinNames: ['3V3'] }],
    });
  });

  it('when a wire carries a length (stamped as a resistor, not a short)', () => {
    expectAgreement({
      components: [
        { id: 'r1', metadataId: 'resistor', properties: { value: '1k' } },
        { id: 'r2', metadataId: 'resistor', properties: { value: '1k' } },
        { id: 'r3', metadataId: 'resistor', properties: { value: '1k' } },
      ],
      wires: [
        { id: 'w1', start: { componentId: 'uno', pinName: '5V' }, end: { componentId: 'r1', pinName: '1' }, length_cm: 50 },
        { id: 'w2', start: { componentId: 'r1', pinName: '2' }, end: { componentId: 'r2', pinName: '1' } },
        { id: 'w3', start: { componentId: 'r2', pinName: '2' }, end: { componentId: 'r3', pinName: '1' } },
        { id: 'w4', start: { componentId: 'r3', pinName: '2' }, end: { componentId: 'uno', pinName: 'GND' } },
      ],
      boards: [{ id: 'uno', vcc: 5, pins: {}, groundPinNames: ['GND'], vccPinNames: ['5V'] }],
    });
  });

  it('on a board-less circuit anchored only by a component GND pin', () => {
    expectAgreement({
      components: [
        { id: 'bat', metadataId: 'battery-9v', properties: {} },
        { id: 'reg', metadataId: 'reg-7805', properties: {} },
        { id: 'r1k', metadataId: 'resistor-1k', properties: { value: '1000' } },
        { id: 'r2k2', metadataId: 'resistor-2k2', properties: { value: '2200' } },
      ],
      wires: [
        { id: 'w1', start: { componentId: 'bat', pinName: '+' }, end: { componentId: 'reg', pinName: 'VIN' } },
        { id: 'w2', start: { componentId: 'bat', pinName: '−' }, end: { componentId: 'reg', pinName: 'GND' } },
        { id: 'w3', start: { componentId: 'reg', pinName: 'VOUT' }, end: { componentId: 'r1k', pinName: '1' } },
        { id: 'w4', start: { componentId: 'r1k', pinName: '2' }, end: { componentId: 'r2k2', pinName: '1' } },
        { id: 'w5', start: { componentId: 'r2k2', pinName: '2' }, end: { componentId: 'bat', pinName: '−' } },
      ],
      boards: [],
    });
  });
});
