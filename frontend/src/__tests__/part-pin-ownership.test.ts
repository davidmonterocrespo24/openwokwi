// @vitest-environment jsdom
/**
 * A part that models its own line must keep it — on every board.
 *
 * connectDigitalInputsToMcu thresholds the solved node into each input pin, and
 * its `sourcedNets` gate is not a real guard: it only holds while NOTHING
 * electrical sits on the net. Wire the sensor the way the hardware needs it — a
 * pull-up on a DHT22, the 1k/2k2 divider a 5 V HC-SR04 needs to reach a 3.3 V
 * pad — and the net becomes component-backed, solves at what the passives say,
 * and the connector starts pinning the very line the sensor is pulsing.
 *
 * partPinOwnership is the rule that fixes it for every board at once, and this
 * test pins both halves of it: the unmodelled part keeps its pin, and the part
 * SPICE does model (a button) still reads the real circuit.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  claimPartPin,
  releasePartPins,
  isPartOwnedPin,
  clearPartPinOwnership,
  withPartPinOwnership,
} from '../simulation/partPinOwnership';

describe('part pin ownership', () => {
  beforeEach(() => clearPartPinOwnership());

  it('claims and releases per component', () => {
    claimPartPin('uno', 10, 'sr04-1');
    expect(isPartOwnedPin('uno', 10)).toBe(true);
    expect(isPartOwnedPin('uno', 11)).toBe(false);
    expect(isPartOwnedPin('esp32', 10)).toBe(false); // per board, not global
    releasePartPins('sr04-1');
    expect(isPartOwnedPin('uno', 10)).toBe(false);
  });

  it('keeps a pin owned while a second component still claims it', () => {
    claimPartPin('uno', 4, 'a');
    claimPartPin('uno', 4, 'b');
    releasePartPins('a');
    expect(isPartOwnedPin('uno', 4)).toBe(true);
    releasePartPins('b');
    expect(isPartOwnedPin('uno', 4)).toBe(false);
  });

  it('claims what an unmodelled part drives, through the wrapper', () => {
    const calls: Array<[string, unknown[]]> = [];
    const sim = {
      setPinState: (...a: unknown[]) => calls.push(['setPinState', a]),
      schedulePinChange: (...a: unknown[]) => calls.push(['schedulePinChange', a]),
      registerSensor: (...a: unknown[]) => {
        calls.push(['registerSensor', a]);
        return true;
      },
    };
    // hc-sr04 has no SPICE mapper: nothing but the part describes ECHO.
    const wrapped = withPartPinOwnership(sim, 'esp32-s3', 'sr04-1', 'hc-sr04') as typeof sim;

    wrapped.setPinState(41, false);
    expect(isPartOwnedPin('esp32-s3', 41)).toBe(true);

    wrapped.schedulePinChange(7, true, 1000);
    expect(isPartOwnedPin('esp32-s3', 7)).toBe(true);

    // A backend sensor owns its data pin AND every extra pin its props name.
    wrapped.registerSensor('hc-sr04', 21, { distance: 30, echo_pin: 41 });
    expect(isPartOwnedPin('esp32-s3', 21)).toBe(true);

    // Everything still reached the real simulator.
    expect(calls.map((c) => c[0])).toEqual([
      'setPinState',
      'schedulePinChange',
      'registerSensor',
    ]);
  });

  it('never claims for a part the netlist already describes', () => {
    const sim = { setPinState: vi.fn() };
    // A pushbutton IS in SPICE. The solved circuit stays the truth for it —
    // that is what makes a mis-wired button read stuck instead of "working".
    const wrapped = withPartPinOwnership(sim, 'uno', 'btn-1', 'pushbutton') as typeof sim;
    wrapped.setPinState(2, false);
    expect(sim.setPinState).toHaveBeenCalledWith(2, false);
    expect(isPartOwnedPin('uno', 2)).toBe(false);
  });

  it('leaves lazy getters and method binding intact', () => {
    let built = 0;
    const sim = {
      pinManager: { id: 'pm' },
      _spi: null as null | { tag: string },
      get spi() {
        if (!this._spi) {
          built += 1;
          this._spi = { tag: 'adapter' };
        }
        return this._spi;
      },
      value: 7,
      readValue(this: { value: number }) {
        return this.value;
      },
    };
    const wrapped = withPartPinOwnership(sim, 'uno', 'x-1', 'hc-sr04') as typeof sim;
    expect(wrapped.pinManager).toEqual({ id: 'pm' });
    expect(wrapped.spi).toBe(wrapped.spi); // memoised on the real object, once
    expect(built).toBe(1);
    expect(wrapped.readValue()).toBe(7); // `this` is the target, not the proxy
  });
});

describe('sensor records on the ESP32 bridge', () => {
  it('merges the two registration paths per field, same kind on the same pin', async () => {
    const { upsertSensorRecords } = await import('../simulation/Esp32Bridge');
    // The store knows the distance, the part knows the echo pin. Neither may
    // erase what the other contributed.
    const a = upsertSensorRecords([], [{ sensor_type: 'hc-sr04', pin: 21, echo_pin: 41 }]);
    const b = upsertSensorRecords(a, [{ sensor_type: 'hc-sr04', pin: 21, distance: 30 }]);
    expect(b).toEqual([{ sensor_type: 'hc-sr04', pin: 21, echo_pin: 41, distance: 30 }]);
  });

  it('replaces outright when a different kind lands on the pin', async () => {
    const { upsertSensorRecords, sensorRecordOwnsPin } = await import('../simulation/Esp32Bridge');
    const a = upsertSensorRecords([], [{ sensor_type: 'hc-sr04', pin: 4, echo_pin: 5 }]);
    const b = upsertSensorRecords(a, [{ sensor_type: 'dht22', pin: 4, temperature: 22 }]);
    expect(b).toEqual([{ sensor_type: 'dht22', pin: 4, temperature: 22 }]);
    // ...so the old echo pin is handed back to the host, not guarded forever.
    expect(sensorRecordOwnsPin(b[0], 5)).toBe(false);
    expect(sensorRecordOwnsPin(b[0], 4)).toBe(true);
  });

  it('only single-wire kinds own pads', async () => {
    const { sensorRecordOwnsPin } = await import('../simulation/Esp32Bridge');
    // An ePaper panel registers real GPIOs too; the host must keep driving them.
    expect(sensorRecordOwnsPin({ sensor_type: 'epaper-ssd168x', pin: 10, dc_pin: 9 }, 9)).toBe(false);
    expect(sensorRecordOwnsPin({ sensor_type: 'hc-sr04', pin: 21, echo_pin: 41 }, 41)).toBe(true);
  });
});

describe('one declaration of the sensors whose model owns the line', () => {
  it('the bridge, the store map and the type list all come from it', async () => {
    const models = await import('../simulation/sensorModels');
    const bridge = await import('../simulation/Esp32Bridge');
    // The bridge re-exports rather than restating: same object identity.
    expect(bridge.SINGLE_WIRE_SENSOR_TYPES).toBe(models.SINGLE_WIRE_SENSOR_TYPES);
    expect(bridge.sensorRecordOwnsPin).toBe(models.sensorRecordOwnsPin);
    // And the type set is derived from the wiring specs, not typed twice.
    expect([...models.SINGLE_WIRE_SENSOR_TYPES].sort()).toEqual(
      Object.values(models.SINGLE_WIRE_SENSOR_MODELS)
        .map((m) => m.sensorType)
        .sort(),
    );
  });

  it('a new extra pin is owned by declaring it, with no other edit', async () => {
    const { sensorRecordOwnsPin, SINGLE_WIRE_SENSOR_MODELS } = await import(
      '../simulation/sensorModels'
    );
    // Ownership walks the fields the model DECLARES, so echo_pin is covered
    // because hc-sr04 declares it — not because anything greps for "echo".
    expect(SINGLE_WIRE_SENSOR_MODELS['hc-sr04'].extraPins).toEqual({ echo_pin: 'ECHO' });
    expect(sensorRecordOwnsPin({ sensor_type: 'hc-sr04', pin: 21, echo_pin: 41 }, 41)).toBe(true);
    // A field the model does NOT declare is not owned, even on a single-wire
    // record — otherwise any stray *_pin property would silently take a pad.
    expect(sensorRecordOwnsPin({ sensor_type: 'dht22', pin: 4, other_pin: 9 }, 9)).toBe(false);
  });
});

describe('models that own a pad without being single-wire', () => {
  it('a matrix keypad owns its columns, not its rows', async () => {
    const { sensorRecordOwnsPin } = await import('../simulation/sensorModels');
    // The worker drives the columns (it keeps a `_keypad_cols_owned` set) and
    // the firmware scans them as inputs; the rows are the firmware's outputs.
    const kp = { sensor_type: 'matrix-keypad', pin: 13, rows: [13, 12, 14, 27], cols: [26, 25, 33, 32] };
    expect(sensorRecordOwnsPin(kp, 26)).toBe(true);
    expect(sensorRecordOwnsPin(kp, 32)).toBe(true);
    expect(sensorRecordOwnsPin(kp, 12)).toBe(false); // a row: the guest drives it
  });

  it('an ePaper panel owns BUSY and nothing else', async () => {
    const { sensorRecordOwnsPin } = await import('../simulation/sensorModels');
    // DC / CS / RST are host-driven — blocking those would strand the panel.
    const ep = { sensor_type: 'epaper-ssd168x', pin: 17, dc_pin: 17, cs_pin: 5, rst_pin: 16, busy_pin: 4 };
    expect(sensorRecordOwnsPin(ep, 4)).toBe(true);
    for (const p of [17, 5, 16]) expect(sensorRecordOwnsPin(ep, p)).toBe(false);
  });

  it('a kind that owns nothing answers false for every pad', async () => {
    const { sensorRecordOwnsPin } = await import('../simulation/sensorModels');
    const i2c = { sensor_type: 'bmp280', pin: 200 + 0x76, addr: 0x76 };
    for (const p of [0, 4, 200 + 0x76]) expect(sensorRecordOwnsPin(i2c, p)).toBe(false);
  });
});
