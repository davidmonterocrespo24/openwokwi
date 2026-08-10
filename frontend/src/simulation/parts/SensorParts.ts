/**
 * SensorParts.ts — Simulation logic for sensors, stepper motor, and NeoPixel devices.
 *
 * Implements:
 *  - tilt-switch
 *  - ntc-temperature-sensor
 *  - photodiode
 *  - gas-sensor (MQ-series)
 *  - flame-sensor
 *  - heart-beat-sensor
 *  - big-sound-sensor
 *  - small-sound-sensor
 *  - stepper-motor (NEMA full-step decode)
 *  - led-ring (WS2812B NeoPixel ring)
 *  - neopixel-matrix (WS2812B NeoPixel matrix)
 *  - pir-motion-sensor
 *  - hc-sr04
 */

import { PartSimulationRegistry } from './PartSimulationRegistry';
import { setAdcVoltage, emitPropertyChange, analogRailVolts } from './partUtils';
import { registerSensorUpdate, unregisterSensorUpdate } from '../SensorUpdateRegistry';

// ─── Tilt Switch ─────────────────────────────────────────────────────────────

/**
 * Tilt switch — click the element to toggle between tilted (OUT HIGH) and
 * upright (OUT LOW). Also controllable via SensorControlPanel "Toggle tilt" button.
 */
PartSimulationRegistry.register('tilt-switch', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    const pin = getArduinoPinHelper('OUT');
    if (pin === null) return () => {};

    let tilted = false;

    const triggerToggle = () => {
      tilted = !tilted;
      simulator.setPinState(pin, tilted);
      console.log(`[TiltSwitch] pin ${pin} → ${tilted ? 'HIGH (tilted)' : 'LOW (upright)'}`);
    };

    // Start LOW (upright)
    simulator.setPinState(pin, false);
    element.addEventListener('click', triggerToggle);

    // SensorControlPanel callback
    registerSensorUpdate(componentId, (values) => {
      if (values.toggle === true) triggerToggle();
    });

    return () => {
      element.removeEventListener('click', triggerToggle);
      unregisterSensorUpdate(componentId);
    };
  },
});

// ─── NTC Temperature Sensor ──────────────────────────────────────────────────

/**
 * NTC thermistor sensor — injects analog voltage representing temperature.
 * Default 25°C → 2.5V. SensorControlPanel slider adjusts temperature.
 *
 * The injected OUT voltage uses the SAME β-model voltage divider the circuit
 * (and the example sketch) assume: a 10k pull-up from VCC to OUT and the NTC
 * from OUT to GND, so V_OUT = VCC · R_ntc / (R_ntc + R_pull) with
 * R_ntc(T) = R0 · exp(β · (1/T − 1/T0)).  This makes the injected ADC voltage
 * decode straight back to the slider value (set 50°C → read 50°C).  When the
 * electrical (SPICE) engine is active it drives A0 from the ngspice solve
 * instead, using the matching topology in componentToSpice.ts — both agree.
 *
 * VCC is the rail of the board the sensor is wired to, not a constant 5. The
 * divider used to assume 5 V everywhere, which on a 3.3 V board put the node
 * above the ADC's full scale: the slider read 1.4°C where it said 25, and
 * everything below ~11°C pinned at the same saturated value (issue #233). The
 * SPICE path already used the board's rail, so the two only agreed on AVR.
 */
PartSimulationRegistry.register('ntc-temperature-sensor', {
  attachEvents: (_element, simulator, getArduinoPinHelper, componentId) => {
    const pin = getArduinoPinHelper('OUT');

    const NTC_R0 = 10_000;
    const NTC_BETA = 3950;
    const R_PULL = 10_000;
    const vcc = analogRailVolts(simulator);
    const tempToVolts = (temp: number) => {
      const rNtc = NTC_R0 * Math.exp(NTC_BETA * (1 / (temp + 273.15) - 1 / 298.15));
      return Math.max(0, Math.min(vcc, vcc * (rNtc / (rNtc + R_PULL))));
    };

    // Room temperature default
    if (pin !== null) setAdcVoltage(simulator, pin, tempToVolts(25));

    registerSensorUpdate(componentId, (values) => {
      if ('temperature' in values) {
        if (pin !== null) {
          setAdcVoltage(simulator, pin, tempToVolts(values.temperature as number));
        }
        // Mirror to store — the SPICE ntc-temperature-sensor handler
        // reads comp.properties.temperature when computing R_ntc.
        emitPropertyChange(componentId, 'temperature', values.temperature);
      }
    });

    return () => {
      unregisterSensorUpdate(componentId);
    };
  },
});

// ─── Photodiode ──────────────────────────────────────────────────────────────

/**
 * Photodiode — 2-terminal passive, reverse-biased light sensor. The SPICE
 * emitter (componentToSpice.ts) reads `properties.lux` and drives a current
 * source (100 nA/lux). This handler wires the SensorControlPanel slider so
 * moving it updates the store → netlist rebuild → re-solve.
 */
PartSimulationRegistry.register('photodiode', {
  attachEvents: (_element, _simulator, _getArduinoPinHelper, componentId) => {
    registerSensorUpdate(componentId, (values) => {
      if ('lux' in values) {
        emitPropertyChange(componentId, 'lux', values.lux);
      }
    });

    return () => {
      unregisterSensorUpdate(componentId);
    };
  },
});

// ─── Gas Sensor (MQ-series) ──────────────────────────────────────────────────

/**
 * Gas sensor — injects analog voltage on AOUT.
 * Default 1.5V (clean air / low gas). SensorControlPanel slider adjusts level (0–1023).
 * Higher value → higher voltage (more gas detected).
 */
PartSimulationRegistry.register('gas-sensor', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    const pinAOUT = getArduinoPinHelper('AOUT');
    const pinDOUT = getArduinoPinHelper('DOUT');
    const pinManager = (simulator as any).pinManager;

    const el = element as any;
    el.ledPower = true;

    const unsubscribers: (() => void)[] = [];

    // Inject baseline analog voltage (1.5V ≈ clean air / low gas)
    if (pinAOUT !== null) {
      setAdcVoltage(simulator, pinAOUT, 1.5);
    }

    // DOUT from Arduino → threshold LED indicator
    if (pinDOUT !== null && pinManager) {
      unsubscribers.push(
        pinManager.onPinChange(pinDOUT, (_: number, state: boolean) => {
          el.ledD0 = state;
        }),
      );
    }

    // Allow element to update analog value if it fires input events
    const onInput = () => {
      const val = (el as any).value;
      if (val !== undefined && pinAOUT !== null) {
        setAdcVoltage(simulator, pinAOUT, (val / 1023.0) * 5.0);
      }
    };
    element.addEventListener('input', onInput);
    unsubscribers.push(() => element.removeEventListener('input', onInput));

    registerSensorUpdate(componentId, (values) => {
      if ('gasLevel' in values && pinAOUT !== null) {
        setAdcVoltage(simulator, pinAOUT, ((values.gasLevel as number) / 1023) * 5.0);
      }
    });

    return () => {
      unsubscribers.forEach((u) => u());
      unregisterSensorUpdate(componentId);
    };
  },
});

// ─── Flame Sensor ────────────────────────────────────────────────────────────

/**
 * Flame sensor — injects analog voltage on AOUT.
 * Default 4.5V (no flame). SensorControlPanel slider: 0 = no flame (high V),
 * 1023 = intense flame (low V).
 */
PartSimulationRegistry.register('flame-sensor', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    const pinAOUT = getArduinoPinHelper('AOUT');
    const pinDOUT = getArduinoPinHelper('DOUT');
    const pinManager = (simulator as any).pinManager;

    const el = element as any;
    el.ledPower = true;

    const unsubscribers: (() => void)[] = [];

    if (pinAOUT !== null) {
      setAdcVoltage(simulator, pinAOUT, 4.5); // no flame = high voltage
    }

    if (pinDOUT !== null && pinManager) {
      unsubscribers.push(
        pinManager.onPinChange(pinDOUT, (_: number, state: boolean) => {
          el.ledSignal = state;
        }),
      );
    }

    const onInput = () => {
      const val = (el as any).value;
      if (val !== undefined && pinAOUT !== null) {
        setAdcVoltage(simulator, pinAOUT, (val / 1023.0) * 5.0);
      }
    };
    element.addEventListener('input', onInput);
    unsubscribers.push(() => element.removeEventListener('input', onInput));

    registerSensorUpdate(componentId, (values) => {
      if ('intensity' in values && pinAOUT !== null) {
        // 0 = no flame → high voltage (4.5V); 1023 = flame → low voltage (0.2V)
        const volts = 5.0 - ((values.intensity as number) / 1023) * 5.0;
        setAdcVoltage(simulator, pinAOUT, volts);
      }
    });

    return () => {
      unsubscribers.forEach((u) => u());
      unregisterSensorUpdate(componentId);
    };
  },
});

// ─── Heart Beat Sensor ───────────────────────────────────────────────────────

/**
 * Heart beat sensor — simulates a 60 BPM signal on OUT pin.
 * Every 1000ms: briefly pulls OUT HIGH for 100ms, then LOW again.
 */
PartSimulationRegistry.register('heart-beat-sensor', {
  attachEvents: (element, simulator, getArduinoPinHelper) => {
    const pin = getArduinoPinHelper('OUT');
    if (pin === null) return () => {};

    simulator.setPinState(pin, false);

    const intervalId = setInterval(() => {
      simulator.setPinState(pin, true); // pulse HIGH
      setTimeout(() => simulator.setPinState(pin, false), 100);
    }, 1000);

    return () => clearInterval(intervalId);
  },
});

// ─── Big Sound Sensor ────────────────────────────────────────────────────────

/**
 * Big sound sensor (FC-04) — injects mid-range analog on AOUT.
 * SensorControlPanel slider adjusts sound level (0–1023).
 */
PartSimulationRegistry.register('big-sound-sensor', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    const pinAOUT = getArduinoPinHelper('AOUT');
    const pinDOUT = getArduinoPinHelper('DOUT');
    const pinManager = (simulator as any).pinManager;

    const el = element as any;
    el.led2 = true; // Power LED

    const unsubscribers: (() => void)[] = [];

    if (pinAOUT !== null) {
      setAdcVoltage(simulator, pinAOUT, 2.5);
    }

    if (pinDOUT !== null && pinManager) {
      unsubscribers.push(
        pinManager.onPinChange(pinDOUT, (_: number, state: boolean) => {
          el.led1 = state;
        }),
      );
    }

    const onInput = () => {
      const val = (el as any).value;
      if (val !== undefined && pinAOUT !== null) {
        setAdcVoltage(simulator, pinAOUT, (val / 1023.0) * 5.0);
      }
    };
    element.addEventListener('input', onInput);
    unsubscribers.push(() => element.removeEventListener('input', onInput));

    registerSensorUpdate(componentId, (values) => {
      if ('soundLevel' in values && pinAOUT !== null) {
        setAdcVoltage(simulator, pinAOUT, ((values.soundLevel as number) / 1023) * 5.0);
      }
    });

    return () => {
      unsubscribers.forEach((u) => u());
      unregisterSensorUpdate(componentId);
    };
  },
});

// ─── Small Sound Sensor ──────────────────────────────────────────────────────

/**
 * Small sound sensor (KY-038) — injects mid-range analog on AOUT.
 * SensorControlPanel slider adjusts sound level (0–1023).
 */
PartSimulationRegistry.register('small-sound-sensor', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    const pinAOUT = getArduinoPinHelper('AOUT');
    const pinDOUT = getArduinoPinHelper('DOUT');
    const pinManager = (simulator as any).pinManager;

    const el = element as any;
    el.ledPower = true;

    const unsubscribers: (() => void)[] = [];

    if (pinAOUT !== null) {
      setAdcVoltage(simulator, pinAOUT, 2.5);
    }

    if (pinDOUT !== null && pinManager) {
      unsubscribers.push(
        pinManager.onPinChange(pinDOUT, (_: number, state: boolean) => {
          el.ledSignal = state;
        }),
      );
    }

    const onInput = () => {
      const val = (el as any).value;
      if (val !== undefined && pinAOUT !== null) {
        setAdcVoltage(simulator, pinAOUT, (val / 1023.0) * 5.0);
      }
    };
    element.addEventListener('input', onInput);
    unsubscribers.push(() => element.removeEventListener('input', onInput));

    registerSensorUpdate(componentId, (values) => {
      if ('soundLevel' in values && pinAOUT !== null) {
        setAdcVoltage(simulator, pinAOUT, ((values.soundLevel as number) / 1023) * 5.0);
      }
    });

    return () => {
      unsubscribers.forEach((u) => u());
      unregisterSensorUpdate(componentId);
    };
  },
});

// ─── Stepper Motor (NEMA full-step decode) ───────────────────────────────────

/**
 * Stepper motor — monitors the 4 coil pins (A-, A+, B+, B-).
 * Uses a full-step lookup table to detect direction of rotation and
 * accumulates the shaft angle (1.8° per step = 200 steps per revolution).
 */
PartSimulationRegistry.register('stepper-motor', {
  attachEvents: (element, simulator, getArduinoPinHelper) => {
    const pinManager = (simulator as any).pinManager;
    if (!pinManager) return () => {};

    const el = element as any;
    const STEP_ANGLE = 1.8; // degrees per step

    const pinAMinus = getArduinoPinHelper('A-');
    const pinAPlus = getArduinoPinHelper('A+');
    const pinBPlus = getArduinoPinHelper('B+');
    const pinBMinus = getArduinoPinHelper('B-');

    const coils = { aMinus: false, aPlus: false, bPlus: false, bMinus: false };
    let cumAngle = el.angle ?? 0;
    // Track the magnetic-field electrical angle instead of matching a fixed
    // coil table. The rotor follows the net field vector of the two coils, so
    // this works for ANY drive mode the firmware (or a driver) produces:
    // wave-drive (one coil), full-step two-phase (two coils), or half-step.
    let prevField = Number.NaN; // previous field angle in radians, NaN = unset

    function onCoilChange() {
      // Coil currents: +1 / 0 / -1 from the H-bridge terminal pair.
      const a = (coils.aPlus ? 1 : 0) - (coils.aMinus ? 1 : 0);
      const b = (coils.bPlus ? 1 : 0) - (coils.bMinus ? 1 : 0);
      if (a === 0 && b === 0) return; // no field → rotor holds position

      const field = Math.atan2(b, a); // electrical angle of the field vector
      if (Number.isNaN(prevField)) {
        prevField = field;
        return;
      }
      // Shortest signed rotation between the two field angles.
      let delta = field - prevField;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      prevField = field;

      // One quarter electrical turn (90°, π/2 rad) = one full mechanical step.
      cumAngle += (delta / (Math.PI / 2)) * STEP_ANGLE;
      el.angle = ((cumAngle % 360) + 360) % 360;
    }

    const unsubscribers: (() => void)[] = [];

    if (pinAMinus !== null) {
      unsubscribers.push(
        pinManager.onPinChange(pinAMinus, (_: number, s: boolean) => {
          coils.aMinus = s;
          onCoilChange();
        }),
      );
    }
    if (pinAPlus !== null) {
      unsubscribers.push(
        pinManager.onPinChange(pinAPlus, (_: number, s: boolean) => {
          coils.aPlus = s;
          onCoilChange();
        }),
      );
    }
    if (pinBPlus !== null) {
      unsubscribers.push(
        pinManager.onPinChange(pinBPlus, (_: number, s: boolean) => {
          coils.bPlus = s;
          onCoilChange();
        }),
      );
    }
    if (pinBMinus !== null) {
      unsubscribers.push(
        pinManager.onPinChange(pinBMinus, (_: number, s: boolean) => {
          coils.bMinus = s;
          onCoilChange();
        }),
      );
    }

    return () => unsubscribers.forEach((u) => u());
  },
});

// ─── WS2812B NeoPixel decode helper ──────────────────────────────────────────

/**
 * Decode WS2812B bit-stream from DIN pin changes for NeoPixel devices.
 */
/**
 * WS2812/NeoPixel bit-bang decoder, shared. Exported because a board is not
 * the only thing that carries an addressable LED: any part with one on board
 * (the reSpeaker Lite's RGB, driven by whatever host is wired to it) needs the
 * same decode, and re-implementing it per part is how two of them drift.
 */
export function createNeopixelDecoder(
  simulator: any,
  pinDIN: number,
  onPixel: (index: number, r: number, g: number, b: number) => void,
): () => void {
  const pinManager = simulator.pinManager;
  if (!pinManager) return () => {};

  const RESET_CYCLES = 800;
  const BIT1_THRESHOLD = 8;

  let lastRisingCycle = 0;
  let lastFallingCycle = 0;
  let lastHigh = false;

  let bitBuf = 0;
  let bitsCollected = 0;
  let byteBuf: number[] = [];
  let pixelIndex = 0;

  const unsub = pinManager.onPinChange(pinDIN, (_: number, high: boolean) => {
    const cpu = simulator.cpu ?? (simulator as any).cpu;
    const now: number = cpu?.cycles ?? 0;

    if (high) {
      const lowDur = now - lastFallingCycle;
      if (lowDur > RESET_CYCLES) {
        pixelIndex = 0;
        byteBuf = [];
        bitBuf = 0;
        bitsCollected = 0;
      }
      lastRisingCycle = now;
      lastHigh = true;
    } else {
      if (lastHigh) {
        const highDur = now - lastRisingCycle;
        const bit = highDur > BIT1_THRESHOLD ? 1 : 0;

        bitBuf = (bitBuf << 1) | bit;
        bitsCollected++;

        if (bitsCollected === 8) {
          byteBuf.push(bitBuf & 0xff);
          bitBuf = 0;
          bitsCollected = 0;

          if (byteBuf.length === 3) {
            const g = byteBuf[0];
            const r = byteBuf[1];
            const b = byteBuf[2];
            onPixel(pixelIndex++, r, g, b);
            byteBuf = [];
          }
        }
      }
      lastFallingCycle = now;
      lastHigh = false;
    }
  });

  return unsub;
}

// ─── LED Ring (WS2812B NeoPixel ring) ────────────────────────────────────────

PartSimulationRegistry.register('led-ring', {
  attachEvents: (element, simulator, getArduinoPinHelper) => {
    const pinDIN = getArduinoPinHelper('DIN');
    if (pinDIN === null) return () => {};

    const el = element as any;

    const unsub = createNeopixelDecoder(simulator as any, pinDIN, (index, r, g, b) => {
      try {
        el.setPixel(index, { r, g, b });
      } catch (_) {
        // setPixel not yet available (element not upgraded) — ignore
      }
    });

    return unsub;
  },
});

// ─── NeoPixel Matrix (WS2812B matrix grid) ────────────────────────────────────

PartSimulationRegistry.register('neopixel-matrix', {
  attachEvents: (element, simulator, getArduinoPinHelper) => {
    const pinDIN = getArduinoPinHelper('DIN');
    if (pinDIN === null) return () => {};

    const el = element as any;

    const unsub = createNeopixelDecoder(simulator as any, pinDIN, (index, r, g, b) => {
      const cols: number = el.cols ?? 8;
      const row = Math.floor(index / cols);
      const col = index % cols;
      try {
        el.setPixel(row, col, { r, g, b });
      } catch (_) {
        // ignore
      }
    });

    return unsub;
  },
});

// ─── Single NeoPixel (WS2812B) ───────────────────────────────────────────────

/**
 * Single addressable RGB LED — decodes the WS2812B data stream on DIN.
 */
PartSimulationRegistry.register('neopixel', {
  attachEvents: (element, simulator, getArduinoPinHelper) => {
    const pinDIN = getArduinoPinHelper('DIN');
    if (pinDIN === null) return () => {};

    const el = element as any;

    const unsub = createNeopixelDecoder(simulator as any, pinDIN, (_index, r, g, b) => {
      el.r = r / 255;
      el.g = g / 255;
      el.b = b / 255;
    });

    return unsub;
  },
});

// ─── PIR Motion Sensor ───────────────────────────────────────────────────────

/**
 * PIR motion sensor — click the element OR press "Simulate motion" in the
 * SensorControlPanel to trigger a 3-second HIGH pulse on OUT.
 */
PartSimulationRegistry.register('pir-motion-sensor', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    const pin = getArduinoPinHelper('OUT');
    if (pin === null) return () => {};

    simulator.setPinState(pin, false); // idle LOW

    let timer: ReturnType<typeof setTimeout> | null = null;

    const triggerMotion = () => {
      if (timer !== null) clearTimeout(timer);
      simulator.setPinState(pin, true);
      console.log('[PIR] Motion detected → OUT HIGH');
      timer = setTimeout(() => {
        simulator.setPinState(pin, false);
        timer = null;
        console.log('[PIR] Motion ended → OUT LOW');
      }, 3000);
    };

    element.addEventListener('click', triggerMotion);

    registerSensorUpdate(componentId, (values) => {
      if (values.trigger === true) triggerMotion();
    });

    return () => {
      element.removeEventListener('click', triggerMotion);
      if (timer !== null) clearTimeout(timer);
      unregisterSensorUpdate(componentId);
    };
  },
});

// ─── KS2E-M-DC5 Relay ────────────────────────────────────────────────────────

/**
 * Dual-coil relay — listens for COIL1/COIL2 pin state changes.
 */
PartSimulationRegistry.register('ks2e-m-dc5', {
  onPinStateChange: (pinName, state, _element) => {
    if (pinName === 'COIL1' || pinName === 'COIL2') {
      console.log(`[Relay KS2E] ${pinName} → ${state ? 'ACTIVATED' : 'RELEASED'}`);
    }
  },
});

// ─── HC-SR04 Ultrasonic Distance Sensor ──────────────────────────────────────

/**
 * Ultrasonic sensor — monitors the TRIG pin.
 * When TRIG goes HIGH, responds with an ECHO HIGH pulse whose duration
 * encodes the configured distance (default 10 cm).
 *
 * Echo timing: echoMs = distanceCm / 17.15
 * (speed of sound ~343 m/s; round-trip halves: 17150 cm/s)
 */
PartSimulationRegistry.register('hc-sr04', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    const trigPin = getArduinoPinHelper('TRIG');
    const echoPin = getArduinoPinHelper('ECHO');
    if (trigPin === null || echoPin === null) return () => {};

    const el = element as any;
    let distanceCm = parseFloat(el.distance) || 10; // default distance in cm

    // ── ESP32 path: delegate protocol to backend QEMU worker ──

    const handledNatively =
      typeof (simulator as any).registerSensor === 'function' &&
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (simulator as any).registerSensor('hc-sr04', trigPin, {
        distance: distanceCm,
        echo_pin: echoPin,
      });

    if (handledNatively) {
      registerSensorUpdate(componentId, (values) => {
        if ('distance' in values) {
          distanceCm = Math.max(2, Math.min(400, values.distance as number));
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (simulator as any).updateSensor(trigPin, {
          distance: distanceCm,
          echo_pin: echoPin,
        });
      });

      return () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (simulator as any).unregisterSensor(trigPin);
        unregisterSensorUpdate(componentId);
      };
    }

    // ── AVR / RP2040 path: local pin scheduling ──
    simulator.setPinState(echoPin, false); // ECHO LOW initially

    const cleanup = simulator.pinManager.onPinChange(trigPin, (_: number, state: boolean) => {
      if (!state) return; // only react on TRIG HIGH
      if (typeof simulator.schedulePinChange === 'function') {
        const clockHz: number =
          typeof (simulator as any).getClockHz === 'function'
            ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (simulator as any).getClockHz()
            : 16_000_000;
        const now = simulator.getCurrentCycles() as number;
        const processingCycles = Math.round(600e-6 * clockHz); // 600 µs sensor overhead
        const echoCycles = Math.round((distanceCm / 17150) * clockHz);
        simulator.schedulePinChange(echoPin, true, now + processingCycles);
        simulator.schedulePinChange(echoPin, false, now + processingCycles + echoCycles);
        console.log(
          `[HC-SR04] Scheduled ECHO (${distanceCm} cm, echo=${(echoCycles / (clockHz / 1e6)).toFixed(1)} µs)`,
        );
      } else {
        // Fallback: best-effort async (works with delay()-based sketches, not pulseIn)
        const echoMs = Math.max(1, distanceCm / 17.15);
        setTimeout(() => {
          simulator.setPinState(echoPin, true);
          setTimeout(() => {
            simulator.setPinState(echoPin, false);
          }, echoMs);
        }, 1);
      }
    });

    registerSensorUpdate(componentId, (values) => {
      if ('distance' in values) {
        distanceCm = Math.max(2, Math.min(400, values.distance as number));
      }
    });

    return () => {
      cleanup();
      unregisterSensorUpdate(componentId);
    };
  },
});
