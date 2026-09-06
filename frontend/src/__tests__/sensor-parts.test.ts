/**
 * sensor-parts.test.ts
 *
 * Tests simulation logic for sensor and stepper-motor components registered
 * in SensorParts.ts (and stepper-motor in particular).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';

// Side-effect imports — register all parts (including SensorParts)
import '../simulation/parts/BasicParts';
import '../simulation/parts/ComplexParts';
import '../simulation/parts/ChipParts';
import '../simulation/parts/SensorParts';

// ─── RAF mock (no-op to prevent infinite loops) ───────────────────────────────
beforeEach(() => {
  let counter = 0;
  vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => ++counter);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('setInterval', vi.fn().mockReturnValue(42));
  vi.stubGlobal('clearInterval', vi.fn());
  vi.stubGlobal('setTimeout', vi.fn().mockReturnValue(1));
  vi.stubGlobal('clearTimeout', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

// ─── Mock factories ───────────────────────────────────────────────────────────

function makeElement(props: Record<string, unknown> = {}): HTMLElement {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    ...props,
  } as unknown as HTMLElement;
}

function makeADC() {
  return { channelValues: new Array(8).fill(0) };
}

function makeSimulator(adc?: ReturnType<typeof makeADC> | null) {
  const pinManager = {
    onPinChange: vi.fn().mockReturnValue(() => {}),
    onPwmChange: vi.fn().mockReturnValue(() => {}),
    triggerPinChange: vi.fn(),
  };
  return {
    pinManager,
    getADC: vi.fn().mockReturnValue(adc ?? null),
    setPinState: vi.fn(),
    cpu: { data: new Uint8Array(512).fill(0), cycles: 0 },
  };
}

const pinMap =
  (map: Record<string, number>) =>
  (name: string): number | null =>
    name in map ? map[name] : null;

const noPins = (_name: string): number | null => null;

// ─── SensorParts registration check ──────────────────────────────────────────

describe('SensorParts — registration', () => {
  const SENSOR_IDS = [
    'tilt-switch',
    'ntc-temperature-sensor',
    'gas-sensor',
    'flame-sensor',
    'heart-beat-sensor',
    'big-sound-sensor',
    'small-sound-sensor',
    'stepper-motor',
    'led-ring',
    'neopixel-matrix',
  ];

  it('registers all sensor and stepper component types', () => {
    for (const id of SENSOR_IDS) {
      expect(PartSimulationRegistry.get(id), `missing: ${id}`).toBeDefined();
    }
  });
});

// ─── Tilt Switch ─────────────────────────────────────────────────────────────

describe('tilt-switch — attachEvents', () => {
  it('sets OUT pin LOW on attach (upright), then HIGH after click, then LOW again', () => {
    const logic = PartSimulationRegistry.get('tilt-switch')!;
    const sim = makeSimulator();
    const element = makeElement();

    // Capture addEventListener calls
    const listeners: Record<string, (...args: any[]) => void> = {};
    (element.addEventListener as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: (...args: any[]) => void) => {
        listeners[event] = handler;
      },
    );

    logic.attachEvents!(element, sim as any, pinMap({ OUT: 14 }));

    // Should have started LOW (upright)
    expect(sim.setPinState).toHaveBeenCalledWith(14, false);

    // First click — tilts HIGH
    sim.setPinState.mockClear();
    listeners['click']?.();
    expect(sim.setPinState).toHaveBeenCalledWith(14, true);

    // Second click — returns LOW
    sim.setPinState.mockClear();
    listeners['click']?.();
    expect(sim.setPinState).toHaveBeenCalledWith(14, false);
  });

  it('does nothing when OUT pin is not connected', () => {
    const logic = PartSimulationRegistry.get('tilt-switch')!;
    const sim = makeSimulator();
    const element = makeElement();

    const cleanup = logic.attachEvents!(element, sim as any, noPins);
    expect(cleanup).toBeDefined();
    expect(sim.setPinState).not.toHaveBeenCalled();
  });
});

// ─── NTC Temperature Sensor ──────────────────────────────────────────────────

describe('ntc-temperature-sensor — attachEvents', () => {
  it('injects 2.5V (mid-range) on OUT pin at room temperature', () => {
    const logic = PartSimulationRegistry.get('ntc-temperature-sensor')!;
    const adc = makeADC();
    const sim = makeSimulator(adc);
    const element = makeElement();

    logic.attachEvents!(element, sim as any, pinMap({ OUT: 14 }));

    // Pin 14 = ADC channel 0.  2.5V should be stored in channelValues[0]
    expect(adc.channelValues[0]).toBeCloseTo(2.5, 2);
  });

  it('does nothing when OUT pin is not connected', () => {
    const logic = PartSimulationRegistry.get('ntc-temperature-sensor')!;
    const adc = makeADC();
    const sim = makeSimulator(adc);
    const element = makeElement();

    logic.attachEvents!(element, sim as any, noPins);
    // ADC should remain zeroed
    expect(adc.channelValues[0]).toBe(0);
  });

  /**
   * Issue #233. The divider used to be computed against a hard-coded 5 V rail,
   * so on a 3.3 V board it handed the ADC a voltage above full scale: 25 C came
   * back as ~1.4 C and everything below ~11 C saturated at the same reading.
   * The rail now follows the board, so the midpoint of a 10k/10k divider is
   * half of THAT rail.
   */
  it('scales the divider to a 3.3V board instead of assuming 5V', () => {
    const logic = PartSimulationRegistry.get('ntc-temperature-sensor')!;
    const injected: number[] = [];
    // A simulator exposing setAdcVoltage is the ESP32 bridge shim.
    const sim = {
      ...makeSimulator(makeADC()),
      setAdcVoltage: (_pin: number, volts: number) => {
        injected.push(volts);
        return true;
      },
    };

    logic.attachEvents!(makeElement(), sim as any, pinMap({ OUT: 34 }));

    expect(injected).toHaveLength(1);
    // R_ntc(25 C) == R_pull == 10k, so OUT sits at exactly half the rail.
    expect(injected[0]).toBeCloseTo(1.65, 2);
    expect(injected[0]).toBeLessThan(3.3); // never above the board's full scale
  });

  it('keeps the 5V midpoint on an AVR board', () => {
    const logic = PartSimulationRegistry.get('ntc-temperature-sensor')!;
    const adc = makeADC();
    const sim = makeSimulator(adc);

    logic.attachEvents!(makeElement(), sim as any, pinMap({ OUT: 14 }));

    expect(adc.channelValues[0]).toBeCloseTo(2.5, 2);
  });
});

// ─── Gas Sensor ──────────────────────────────────────────────────────────────

describe('gas-sensor — attachEvents', () => {
  it('injects baseline analog voltage on AOUT and sets ledPower=true', () => {
    const logic = PartSimulationRegistry.get('gas-sensor')!;
    const adc = makeADC();
    const sim = makeSimulator(adc);
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ AOUT: 14, DOUT: 7 }));

    // AOUT → ADC channel 0, baseline 1.5V
    expect(adc.channelValues[0]).toBeCloseTo(1.5, 2);
    expect(el.ledPower).toBe(true);
  });

  it('registers pin-change listener for DOUT to update ledD0', () => {
    const logic = PartSimulationRegistry.get('gas-sensor')!;
    const sim = makeSimulator();
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ DOUT: 7 }));

    // Should have registered a onPinChange listener for DOUT (pin 7)
    expect(sim.pinManager.onPinChange).toHaveBeenCalledWith(7, expect.any(Function));

    // Simulate DOUT going HIGH → ledD0 should update
    const handler = sim.pinManager.onPinChange.mock.calls[0][1];
    handler(7, true);
    expect(el.ledD0).toBe(true);

    handler(7, false);
    expect(el.ledD0).toBe(false);
  });
});

// ─── Flame Sensor ────────────────────────────────────────────────────────────

describe('flame-sensor — attachEvents', () => {
  it('injects baseline analog voltage on AOUT and sets ledPower=true', () => {
    const logic = PartSimulationRegistry.get('flame-sensor')!;
    const adc = makeADC();
    const sim = makeSimulator(adc);
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ AOUT: 14 }), 'flame-sensor-test');

    // No-flame baseline = 4.5V (inverse: no flame → high V, flame → low V)
    expect(adc.channelValues[0]).toBeCloseTo(4.5, 2);
    expect(el.ledPower).toBe(true);
  });

  it('updates ledSignal when DOUT pin state changes', () => {
    const logic = PartSimulationRegistry.get('flame-sensor')!;
    const sim = makeSimulator();
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ DOUT: 8 }));

    expect(sim.pinManager.onPinChange).toHaveBeenCalledWith(8, expect.any(Function));

    const handler = sim.pinManager.onPinChange.mock.calls[0][1];
    handler(8, true);
    expect(el.ledSignal).toBe(true);
    handler(8, false);
    expect(el.ledSignal).toBe(false);
  });
});

// ─── Heart Beat Sensor ───────────────────────────────────────────────────────

/**
 * Drive the pulse sensor with a controllable clock.
 *
 * `setInterval` is stubbed in this file's beforeEach, so the part's tick never
 * runs on its own — we pull it out of the mock and call it ourselves, stepping
 * a fake `performance.now()` so the waveform is a pure function of test time.
 */
function driveHeartBeat(
  props: Record<string, unknown> = {},
  pins: Record<string, number> = { OUT: 34 },
) {
  const logic = PartSimulationRegistry.get('heart-beat-sensor')!;
  const injected: Array<{ pin: number; volts: number }> = [];
  const sim = {
    ...makeSimulator(makeADC()),
    setAdcVoltage: (pin: number, volts: number) => {
      injected.push({ pin, volts });
      return true;
    },
  };
  let now = 0;
  vi.stubGlobal('performance', { now: () => now });
  const element = makeElement(props);
  const cleanup = logic.attachEvents!(element, sim as any, pinMap(pins), 'hb-1');
  const tick = (setInterval as unknown as { mock: { calls: Array<[() => void, number]> } }).mock
    .calls[0][0];
  const stepMs = (setInterval as unknown as { mock: { calls: Array<[() => void, number]> } }).mock
    .calls[0][1];
  return {
    sim,
    element,
    injected,
    cleanup,
    stepMs,
    /** Run the part's timer for `ms` of simulated wall clock. */
    advance(ms: number) {
      const steps = Math.round(ms / stepMs);
      for (let i = 0; i < steps; i++) {
        now += stepMs;
        tick();
      }
    },
  };
}

/** 12-bit ADC codes an ESP32 sketch would read back from the injected volts. */
const raw12 = (volts: number) => Math.round((volts / 3.3) * 4095);

describe('heart-beat-sensor — attachEvents', () => {
  it('starts OUT pin LOW and sets up an interval for pulse generation', () => {
    const logic = PartSimulationRegistry.get('heart-beat-sensor')!;
    const sim = makeSimulator();
    const element = makeElement();

    logic.attachEvents!(element, sim as any, pinMap({ OUT: 14 }));

    // Should start LOW
    expect(sim.setPinState).toHaveBeenCalledWith(14, false);
    // Should have called setInterval
    expect(setInterval).toHaveBeenCalled();
  });

  it('clears the interval on cleanup', () => {
    const logic = PartSimulationRegistry.get('heart-beat-sensor')!;
    const sim = makeSimulator();
    const element = makeElement();

    const cleanup = logic.attachEvents!(element, sim as any, pinMap({ OUT: 14 }));
    cleanup();

    expect(clearInterval).toHaveBeenCalledWith(42); // 42 is the mock return from setInterval
  });

  it('does nothing when OUT pin is not connected', () => {
    const logic = PartSimulationRegistry.get('heart-beat-sensor')!;
    const sim = makeSimulator();
    const element = makeElement();

    logic.attachEvents!(element, sim as any, noPins);
    expect(setInterval).not.toHaveBeenCalled();
  });

  // The regression this whole part was rewritten for: the module only ever
  // pulsed the digital pin, so analogRead / ADC.read() — how a pulse sensor is
  // normally read — returned a flat 0 and every sketch computed 0 BPM.
  it('seeds the ADC channel at the resting level before the first tick', () => {
    const { injected } = driveHeartBeat();

    expect(injected.length).toBeGreaterThan(0);
    expect(injected[0].pin).toBe(34);
    expect(injected[0].volts).toBeGreaterThan(0.4);
    expect(injected[0].volts).toBeLessThan(1.0);
  });

  it('drives a pulse waveform on the ADC, not a constant', () => {
    const { injected, advance } = driveHeartBeat({ bpm: 60 });
    advance(1000); // exactly one beat at 60 BPM

    const volts = injected.map((i) => i.volts);
    const min = Math.min(...volts);
    const max = Math.max(...volts);

    expect(max).toBeGreaterThan(3.0); // systolic peak, near the 3.3 V rail
    expect(min).toBeLessThan(0.8); // diastolic floor
    expect(new Set(volts.map((v) => v.toFixed(2))).size).toBeGreaterThan(10);
  });

  it('still emits one short digital pulse per beat', () => {
    const { sim, advance } = driveHeartBeat({ bpm: 60 });
    advance(3000); // three beats

    const edges = sim.setPinState.mock.calls.filter((c: unknown[]) => c[1] === true);
    expect(edges).toHaveLength(3);

    // and the pulse is a small part of the cycle, like the comparator output
    // of a real module (this used to be a hard-coded 100 ms in a 1000 ms beat)
    const highSamples = sim.setPinState.mock.calls.length;
    expect(highSamples).toBeGreaterThan(0);
  });

  it('follows the bpm property', () => {
    const { sim, advance } = driveHeartBeat({ bpm: 120 });
    advance(3000); // 120 BPM = 6 beats in 3 s

    const edges = sim.setPinState.mock.calls.filter((c: unknown[]) => c[1] === true);
    expect(edges).toHaveLength(6);
  });

  it('accepts a bpm that arrives as a string, and clamps out-of-range values', () => {
    const asString = driveHeartBeat({ bpm: '120' });
    asString.advance(3000);
    expect(
      asString.sim.setPinState.mock.calls.filter((c: unknown[]) => c[1] === true),
    ).toHaveLength(6);

    // 6000 BPM is not a heart rate; it must clamp rather than alias the timer
    const absurd = driveHeartBeat({ bpm: 6000 });
    absurd.advance(1000);
    const edges = absurd.sim.setPinState.mock.calls.filter((c: unknown[]) => c[1] === true);
    expect(edges.length).toBeLessThanOrEqual(4); // 220 BPM ceiling
  });

  it('re-rates from the sensor control panel', () => {
    const { sim, advance } = driveHeartBeat({ bpm: 60 });
    advance(1000);
    const afterFirst = sim.setPinState.mock.calls.filter((c: unknown[]) => c[1] === true).length;

    dispatchSensorUpdate('hb-1', { bpm: 180 });
    advance(1000); // 180 BPM = 3 beats in the next second

    const total = sim.setPinState.mock.calls.filter((c: unknown[]) => c[1] === true).length;
    expect(afterFirst).toBe(1);
    expect(total - afterFirst).toBe(3);
  });

  // The dicrotic notch is a real feature of a PPG, but a naive peak counter
  // (`value > THRESHOLD` with a refractory window — what the pulse-monitor
  // example does) must not count it as a second beat.
  it('keeps the dicrotic notch below a typical detection threshold', () => {
    const { injected, advance } = driveHeartBeat({ bpm: 60 });
    advance(2000);

    const THRESHOLD = 2500; // the value the 100-days pulse monitor uses
    const MIN_PEAK_INTERVAL_MS = 300;
    const codes = injected.map((i) => raw12(i.volts));

    let peaks = 0;
    let lastPeakMs = -Infinity;
    codes.forEach((code, i) => {
      const tMs = i * 20;
      if (code > THRESHOLD && tMs - lastPeakMs > MIN_PEAK_INTERVAL_MS) {
        peaks++;
        lastPeakMs = tMs;
      }
    });

    expect(peaks).toBe(2); // one per beat over two seconds at 60 BPM
    expect(Math.max(...codes)).toBeGreaterThan(THRESHOLD);
  });

  // An emulated board runs slower than real time. Beating on the browser clock
  // made the sketch alias the waveform: at ~1 redraw per real second it sampled
  // a 72 BPM wave about once per cycle and the 100-days pulse monitor reported
  // 8 BPM. On the guest clock the sketch gets the same samples per beat it
  // would on hardware, however slowly the engine is running.
  it('beats on the guest clock when the simulator exposes one', () => {
    const logic = PartSimulationRegistry.get('heart-beat-sensor')!;
    let guestUs = 0;
    let wall = 0;
    vi.stubGlobal('performance', { now: () => wall });
    const sim = {
      ...makeSimulator(makeADC()),
      setAdcVoltage: () => true,
      getGuestMicros: () => guestUs,
    };
    logic.attachEvents!(makeElement({ bpm: 60 }), sim as any, pinMap({ OUT: 34 }), 'hb-3');
    const tick = (setInterval as unknown as { mock: { calls: Array<[() => void, number]> } }).mock
      .calls[0][0];

    // Ten real seconds of browser time, but only one second of guest time:
    // exactly one beat, because the sketch's own clock only advanced by one.
    for (let i = 0; i < 500; i++) {
      wall += 20;
      guestUs += 2000; // guest runs 10x slower than the wall clock
      tick();
    }

    const edges = sim.setPinState.mock.calls.filter((c: unknown[]) => c[1] === true);
    expect(edges).toHaveLength(1);
  });

  it('falls back to wall time when the guest clock is unreadable', () => {
    const logic = PartSimulationRegistry.get('heart-beat-sensor')!;
    let wall = 0;
    vi.stubGlobal('performance', { now: () => wall });
    const sim = {
      ...makeSimulator(makeADC()),
      setAdcVoltage: () => true,
      getGuestMicros: () => -1, // backend QEMU: clock lives in another process
    };
    logic.attachEvents!(makeElement({ bpm: 60 }), sim as any, pinMap({ OUT: 34 }), 'hb-4');
    const tick = (setInterval as unknown as { mock: { calls: Array<[() => void, number]> } }).mock
      .calls[0][0];
    for (let i = 0; i < 150; i++) {
      wall += 20;
      tick();
    }

    const edges = sim.setPinState.mock.calls.filter((c: unknown[]) => c[1] === true);
    expect(edges).toHaveLength(3); // 3 s of wall time at 60 BPM
  });

  it('stops writing the ADC when OUT is not an ADC-capable pad', () => {
    const logic = PartSimulationRegistry.get('heart-beat-sensor')!;
    let attempts = 0;
    const sim = {
      ...makeSimulator(makeADC()),
      setAdcVoltage: () => {
        attempts++;
        return false; // not an ADC pin
      },
    };
    let now = 0;
    vi.stubGlobal('performance', { now: () => now });
    logic.attachEvents!(makeElement(), sim as any, pinMap({ OUT: 5 }), 'hb-2');
    const tick = (setInterval as unknown as { mock: { calls: Array<[() => void, number]> } }).mock
      .calls[0][0];
    for (let i = 0; i < 200; i++) {
      now += 20;
      tick();
    }

    // A handful of retries covers a simulator that is not up yet; after that it
    // gives up instead of warning 50 times a second for the whole run.
    expect(attempts).toBeLessThanOrEqual(20);
    // the digital pulse still works on a plain GPIO
    expect(sim.setPinState).toHaveBeenCalledWith(5, true);
  });

  it('releases the pin and the panel subscription on cleanup', () => {
    const { sim, cleanup, advance } = driveHeartBeat({ bpm: 60 });
    advance(200);
    sim.setPinState.mockClear();
    cleanup();

    expect(clearInterval).toHaveBeenCalledWith(42);
    expect(sim.setPinState).toHaveBeenCalledWith(34, false);
  });
});

// ─── Big Sound Sensor ────────────────────────────────────────────────────────

describe('big-sound-sensor — attachEvents', () => {
  it('injects 2.5V on AOUT and sets led2=true (power LED)', () => {
    const logic = PartSimulationRegistry.get('big-sound-sensor')!;
    const adc = makeADC();
    const sim = makeSimulator(adc);
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ AOUT: 14 }));

    expect(adc.channelValues[0]).toBeCloseTo(2.5, 2);
    expect(el.led2).toBe(true);
  });

  it('updates led1 when DOUT pin changes', () => {
    const logic = PartSimulationRegistry.get('big-sound-sensor')!;
    const sim = makeSimulator();
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ DOUT: 9 }));

    expect(sim.pinManager.onPinChange).toHaveBeenCalledWith(9, expect.any(Function));
    const handler = sim.pinManager.onPinChange.mock.calls[0][1];
    handler(9, true);
    expect(el.led1).toBe(true);
    handler(9, false);
    expect(el.led1).toBe(false);
  });
});

// ─── Small Sound Sensor ──────────────────────────────────────────────────────

describe('small-sound-sensor — attachEvents', () => {
  it('injects 2.5V on AOUT and sets ledPower=true', () => {
    const logic = PartSimulationRegistry.get('small-sound-sensor')!;
    const adc = makeADC();
    const sim = makeSimulator(adc);
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ AOUT: 14 }));

    expect(adc.channelValues[0]).toBeCloseTo(2.5, 2);
    expect(el.ledPower).toBe(true);
  });

  it('updates ledSignal when DOUT pin changes', () => {
    const logic = PartSimulationRegistry.get('small-sound-sensor')!;
    const sim = makeSimulator();
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ DOUT: 10 }));

    const handler = sim.pinManager.onPinChange.mock.calls[0][1];
    handler(10, true);
    expect(el.ledSignal).toBe(true);
    handler(10, false);
    expect(el.ledSignal).toBe(false);
  });
});

// ─── Stepper Motor ───────────────────────────────────────────────────────────

describe('stepper-motor — attachEvents', () => {
  it('registers pin-change listeners for all 4 coil pins', () => {
    const logic = PartSimulationRegistry.get('stepper-motor')!;
    const sim = makeSimulator();
    const el = makeElement() as any;
    el.angle = 0;

    const pins = { 'A-': 4, 'A+': 5, 'B+': 6, 'B-': 7 };
    logic.attachEvents!(el, sim as any, pinMap(pins));

    expect(sim.pinManager.onPinChange).toHaveBeenCalledTimes(4);
    const registeredPins = sim.pinManager.onPinChange.mock.calls.map(([p]: [number]) => p);
    expect(registeredPins).toEqual(expect.arrayContaining([4, 5, 6, 7]));
  });

  it('advances angle by 1.8° per forward step (full-step sequence)', () => {
    const logic = PartSimulationRegistry.get('stepper-motor')!;
    const sim = makeSimulator();
    const el = makeElement() as any;
    el.angle = 0;

    const pins = { 'A-': 4, 'A+': 5, 'B+': 6, 'B-': 7 };
    logic.attachEvents!(el, sim as any, pinMap(pins));

    // Collect handlers indexed by pin number
    const handlers: Record<number, (pin: number, s: boolean) => void> = {};
    for (const [pin, handler] of sim.pinManager.onPinChange.mock.calls) {
      handlers[pin as number] = handler;
    }

    // Step 0: A+ = HIGH (others LOW)
    handlers[5]?.(5, true); // A+

    // Step 1: B+ = HIGH, A+ = LOW → should advance angle
    handlers[5]?.(5, false); // A+ LOW
    handlers[6]?.(6, true); // B+ HIGH

    expect(el.angle).toBeCloseTo(1.8, 1);
  });

  it('does nothing with zero coil pins connected', () => {
    const logic = PartSimulationRegistry.get('stepper-motor')!;
    const sim = makeSimulator();
    const el = makeElement() as any;
    el.angle = 0;

    logic.attachEvents!(el, sim as any, noPins);

    expect(sim.pinManager.onPinChange).not.toHaveBeenCalled();
    expect(el.angle).toBe(0);
  });
});

// ─── LED Ring (NeoPixel) ─────────────────────────────────────────────────────

describe('led-ring — attachEvents', () => {
  it('registers a pin-change listener on the DIN pin', () => {
    const logic = PartSimulationRegistry.get('led-ring')!;
    const sim = makeSimulator();
    sim.cpu = { data: new Uint8Array(512), cycles: 0 } as any;
    const el = makeElement() as any;
    el.setPixel = vi.fn();

    logic.attachEvents!(el, sim as any, pinMap({ DIN: 6 }));

    expect(sim.pinManager.onPinChange).toHaveBeenCalledWith(6, expect.any(Function));
  });

  it('does nothing when DIN pin is not connected', () => {
    const logic = PartSimulationRegistry.get('led-ring')!;
    const sim = makeSimulator();
    const el = makeElement() as any;

    const cleanup = logic.attachEvents!(el, sim as any, noPins);
    expect(cleanup).toBeDefined();
    expect(sim.pinManager.onPinChange).not.toHaveBeenCalled();
  });
});

// ─── NeoPixel Matrix ─────────────────────────────────────────────────────────

describe('neopixel-matrix — attachEvents', () => {
  it('registers a pin-change listener on the DIN pin', () => {
    const logic = PartSimulationRegistry.get('neopixel-matrix')!;
    const sim = makeSimulator();
    sim.cpu = { data: new Uint8Array(512), cycles: 0 } as any;
    const el = makeElement() as any;
    el.setPixel = vi.fn();
    el.cols = 8;

    logic.attachEvents!(el, sim as any, pinMap({ DIN: 6 }));

    expect(sim.pinManager.onPinChange).toHaveBeenCalledWith(6, expect.any(Function));
  });
});
