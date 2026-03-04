import { PartSimulationRegistry } from './PartSimulationRegistry';
import type { AnySimulator } from './PartSimulationRegistry';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Read the ADC instance from the simulator (returns null if not initialized) */
function getADC(avrSimulator: AnySimulator): any | null {
    return (avrSimulator as any).getADC?.() ?? null;
}

/** Write an analog voltage (0-5V) to an ADC channel derived from an Arduino pin (A0-A5 = 14-19) */
function setAdcVoltage(avrSimulator: AnySimulator, arduinoPin: number, voltage: number): boolean {
    if (arduinoPin < 14 || arduinoPin > 19) return false;
    const channel = arduinoPin - 14;
    const adc = getADC(avrSimulator);
    if (!adc) return false;
    adc.channelValues[channel] = voltage;
    return true;
}

// ─── RGB LED (PWM-aware) ─────────────────────────────────────────────────────

/**
 * RGB LED implementation — supports both digital and PWM (analogWrite) output.
 * Falls back to digital mode if no PWM is detected.
 */
PartSimulationRegistry.register('rgb-led', {
    attachEvents: (element, avrSimulator, getArduinoPinHelper) => {
        const pinManager = (avrSimulator as any).pinManager;
        if (!pinManager) return () => { };

        const el = element as any;
        const unsubscribers: (() => void)[] = [];

        const pinR = getArduinoPinHelper('R');
        const pinG = getArduinoPinHelper('G');
        const pinB = getArduinoPinHelper('B');

        // Digital fallback
        if (pinR !== null) {
            unsubscribers.push(pinManager.onPinChange(pinR, (_: number, state: boolean) => {
                el.ledRed = state ? 255 : 0;
            }));
        }
        if (pinG !== null) {
            unsubscribers.push(pinManager.onPinChange(pinG, (_: number, state: boolean) => {
                el.ledGreen = state ? 255 : 0;
            }));
        }
        if (pinB !== null) {
            unsubscribers.push(pinManager.onPinChange(pinB, (_: number, state: boolean) => {
                el.ledBlue = state ? 255 : 0;
            }));
        }

        // PWM override — when analogWrite() is used the OCR value supersedes digital
        const pwmPins = [
            { pin: pinR, prop: 'ledRed' },
            { pin: pinG, prop: 'ledGreen' },
            { pin: pinB, prop: 'ledBlue' },
        ];
        for (const { pin, prop } of pwmPins) {
            if (pin !== null) {
                unsubscribers.push(pinManager.onPwmChange(pin, (_: number, dc: number) => {
                    el[prop] = Math.round(dc * 255);
                }));
            }
        }

        return () => unsubscribers.forEach(u => u());
    },
});

// ─── Potentiometer (rotary) ──────────────────────────────────────────────────

PartSimulationRegistry.register('potentiometer', {
    attachEvents: (element, avrSimulator, getArduinoPinHelper) => {
        const arduinoPin = getArduinoPinHelper('SIG');
        if (arduinoPin === null) return () => { };

        const onInput = () => {
            const raw = parseInt((element as any).value || '0', 10);
            const volts = (raw / 1023.0) * 5.0;
            if (!setAdcVoltage(avrSimulator, arduinoPin, volts)) {
                console.warn('[Potentiometer] ADC not available — is AVRADC initialized?');
            }
        };

        element.addEventListener('input', onInput);
        return () => element.removeEventListener('input', onInput);
    },
});

// ─── Slide Potentiometer ─────────────────────────────────────────────────────

PartSimulationRegistry.register('slide-potentiometer', {
    attachEvents: (element, avrSimulator, getArduinoPinHelper) => {
        const arduinoPin = getArduinoPinHelper('SIG') ?? getArduinoPinHelper('OUT');
        if (arduinoPin === null) return () => { };

        const el = element as any;

        const onInput = () => {
            const min = el.min ?? 0;
            const max = el.max ?? 1023;
            const value = el.value ?? 0;
            const normalized = (value - min) / (max - min || 1);
            const volts = normalized * 5.0;
            setAdcVoltage(avrSimulator, arduinoPin, volts);
        };

        element.addEventListener('input', onInput);
        return () => element.removeEventListener('input', onInput);
    },
});

// ─── Photoresistor Sensor ────────────────────────────────────────────────────

/**
 * Photoresistor sensor — the wokwi element does not emit input events,
 * so we simulate light level with a slider drawn via the component's
 * luminance property when available, or simply set a mid-range voltage.
 *
 * The element exposes `ledDO` and `ledPower` for display only.
 * We inject a static mid-range voltage on the AO pin so analogRead()
 * returns a valid value. Users can modify the element's `value` attribute.
 */
PartSimulationRegistry.register('photoresistor-sensor', {
    attachEvents: (element, avrSimulator, getArduinoPinHelper) => {
        const pinAO = getArduinoPinHelper('AO') ?? getArduinoPinHelper('A0');
        const pinDO = getArduinoPinHelper('DO') ?? getArduinoPinHelper('D0');
        const pinManager = (avrSimulator as any).pinManager;

        const unsubscribers: (() => void)[] = [];

        // Inject initial mid-range voltage (simulate moderate light)
        if (pinAO !== null) {
            setAdcVoltage(avrSimulator, pinAO, 2.5);
        }

        // Watch element's 'input' events in case the element supports it
        const onInput = () => {
            const val = (element as any).value;
            if (val !== undefined && pinAO !== null) {
                const volts = (val / 1023.0) * 5.0;
                setAdcVoltage(avrSimulator, pinAO, volts);
            }
        };
        element.addEventListener('input', onInput);
        unsubscribers.push(() => element.removeEventListener('input', onInput));

        // DO (digital output) — if connected, update element's LED indicator
        if (pinDO !== null && pinManager) {
            unsubscribers.push(pinManager.onPinChange(pinDO, (_: number, state: boolean) => {
                (element as any).ledDO = state;
            }));
        }

        return () => unsubscribers.forEach(u => u());
    },
});

// ─── Analog Joystick ─────────────────────────────────────────────────────────

/**
 * Analog Joystick — two axes (xValue/yValue 0-1023) + button press
 * Wokwi pins: VRX (X axis), VRY (Y axis), SW (button)
 */
PartSimulationRegistry.register('analog-joystick', {
    attachEvents: (element, avrSimulator, getArduinoPinHelper) => {
        const pinX   = getArduinoPinHelper('VRX') ?? getArduinoPinHelper('XOUT');
        const pinY   = getArduinoPinHelper('VRY') ?? getArduinoPinHelper('YOUT');
        const pinSW  = getArduinoPinHelper('SW');
        const el = element as any;

        // Center position is mid-range (~2.5V)
        if (pinX !== null) setAdcVoltage(avrSimulator, pinX, 2.5);
        if (pinY !== null) setAdcVoltage(avrSimulator, pinY, 2.5);

        const onMove = () => {
            // xValue / yValue are 0-1023
            if (pinX !== null) {
                const vx = ((el.xValue ?? 512) / 1023.0) * 5.0;
                setAdcVoltage(avrSimulator, pinX, vx);
            }
            if (pinY !== null) {
                const vy = ((el.yValue ?? 512) / 1023.0) * 5.0;
                setAdcVoltage(avrSimulator, pinY, vy);
            }
        };

        const onPress = () => {
            if (pinSW !== null) avrSimulator.setPinState(pinSW, false); // Active LOW
            el.pressed = true;
        };
        const onRelease = () => {
            if (pinSW !== null) avrSimulator.setPinState(pinSW, true);
            el.pressed = false;
        };

        element.addEventListener('input', onMove);
        element.addEventListener('joystick-move', onMove);
        element.addEventListener('button-press', onPress);
        element.addEventListener('button-release', onRelease);

        return () => {
            element.removeEventListener('input', onMove);
            element.removeEventListener('joystick-move', onMove);
            element.removeEventListener('button-press', onPress);
            element.removeEventListener('button-release', onRelease);
        };
    },
});

// ─── Servo ───────────────────────────────────────────────────────────────────

/**
 * Servo motor — reads OCR1A and ICR1 to calculate pulse width and angle.
 *
 * Standard RC servo protocol:
 *   - 50 Hz signal (20 ms period)
 *   - Pulse width 1 ms → 0°, 1.5 ms → 90°, 2 ms → 180°
 *
 * With Timer1, prescaler=8, F_CPU=16MHz:
 *   - ICR1 = 20000 for 50Hz
 *   - OCR1A = 1000 → 0°, 1500 → 90°, 2000 → 180°
 *
 * We poll these registers every animation frame via a requestAnimationFrame loop.
 */
PartSimulationRegistry.register('servo', {
    attachEvents: (element, avrSimulator, getArduinoPinHelper) => {
        const pinSIG = getArduinoPinHelper('PWM') ?? getArduinoPinHelper('SIG') ?? getArduinoPinHelper('1');
        const el = element as any;

        // OCR1A low byte = 0x88, OCR1A high byte = 0x89
        // ICR1L = 0x86, ICR1H = 0x87
        const OCR1AL = 0x88;
        const OCR1AH = 0x89;
        const ICR1L  = 0x86;
        const ICR1H  = 0x87;

        let rafId: number | null = null;
        let lastOcr1a = -1;

        const poll = () => {
            const cpu = (avrSimulator as any).cpu;
            if (!cpu) { rafId = requestAnimationFrame(poll); return; }

            const ocr1a = cpu.data[OCR1AL] | (cpu.data[OCR1AH] << 8);
            if (ocr1a !== lastOcr1a) {
                lastOcr1a = ocr1a;
                const icr1 = cpu.data[ICR1L] | (cpu.data[ICR1H] << 8);

                // Calculate pulse width in microseconds
                // prescaler 8, F_CPU 16MHz → 1 tick = 0.5µs
                // pulse_us = ocr1a * 0.5
                // But also handle prescaler 64 (1 tick = 4µs) and default ICR1 detection
                let pulseUs: number;
                if (icr1 > 0) {
                    // Proportional to ICR1 period (assume 20ms period)
                    pulseUs = 1000 + (ocr1a / icr1) * 1000;
                } else {
                    // Fallback: prescaler 8
                    pulseUs = ocr1a * 0.5;
                }

                // Clamp to 1000-2000µs and map to 0-180°
                const clamped = Math.max(1000, Math.min(2000, pulseUs));
                const angle = Math.round(((clamped - 1000) / 1000) * 180);
                el.angle = angle;
            }

            // Also support PWM duty cycle approach via PinManager
            if (pinSIG !== null) {
                const pinManager = (avrSimulator as any).pinManager;
                // Only override angle if cpu-based approach doesn't work
                // (ICR1 = 0 means Timer1 not configured as servo)
                const icr1 = cpu.data[ICR1L] | (cpu.data[ICR1H] << 8);
                if (icr1 === 0 && pinManager) {
                    const dc = pinManager.getPwmValue(pinSIG);
                    if (dc > 0) {
                        el.angle = Math.round(dc * 180);
                    }
                }
            }

            rafId = requestAnimationFrame(poll);
        };

        rafId = requestAnimationFrame(poll);

        return () => {
            if (rafId !== null) cancelAnimationFrame(rafId);
        };
    },
});

// ─── Buzzer ──────────────────────────────────────────────────────────────────

/**
 * Buzzer — uses Web Audio API to generate a tone.
 *
 * Reads OCR2A (Timer2 CTC mode) to determine frequency:
 *   f = F_CPU / (2 × prescaler × (OCR2A + 1))
 *
 * Prescaler detected from TCCR2B[2:0] bits.
 * Activates when duty cycle > 0 (pin is driven HIGH).
 */
PartSimulationRegistry.register('buzzer', {
    attachEvents: (element, avrSimulator, getArduinoPinHelper) => {
        const pinSIG = getArduinoPinHelper('1') ?? getArduinoPinHelper('+') ?? getArduinoPinHelper('POS');
        const pinManager = (avrSimulator as any).pinManager;

        let audioCtx: AudioContext | null = null;
        let oscillator: OscillatorNode | null = null;
        let gainNode: GainNode | null = null;
        let isSounding = false;
        const el = element as any;

        // Timer2 register addresses
        const OCR2A  = 0xB3;
        const TCCR2B = 0xB1;
        const F_CPU  = 16_000_000;

        const prescalerTable: Record<number, number> = {
            1: 1, 2: 8, 3: 32, 4: 64, 5: 128, 6: 256, 7: 1024,
        };

        function getFrequency(cpu: any): number {
            const ocr2a   = cpu.data[OCR2A] ?? 0;
            const tccr2b  = cpu.data[TCCR2B] ?? 0;
            const csField = tccr2b & 0x07;
            const prescaler = prescalerTable[csField] ?? 64;
            // CTC mode: f = F_CPU / (2 × prescaler × (OCR2A + 1))
            return F_CPU / (2 * prescaler * (ocr2a + 1));
        }

        function startTone(freq: number) {
            if (!audioCtx) {
                audioCtx = new AudioContext();
                gainNode = audioCtx.createGain();
                gainNode.gain.value = 0.1;
                gainNode.connect(audioCtx.destination);
            }
            if (oscillator) {
                oscillator.frequency.setTargetAtTime(freq, audioCtx.currentTime, 0.01);
                return;
            }
            oscillator = audioCtx.createOscillator();
            oscillator.type = 'square';
            oscillator.frequency.value = freq;
            oscillator.connect(gainNode!);
            oscillator.start();
            isSounding = true;
            if (el.playing !== undefined) el.playing = true;
        }

        function stopTone() {
            if (oscillator) {
                oscillator.stop();
                oscillator.disconnect();
                oscillator = null;
            }
            isSounding = false;
            if (el.playing !== undefined) el.playing = false;
        }

        // Poll via PWM duty cycle on the buzzer pin
        const unsubscribers: (() => void)[] = [];

        if (pinSIG !== null && pinManager) {
            unsubscribers.push(pinManager.onPwmChange(pinSIG, (_: number, dc: number) => {
                const cpu = (avrSimulator as any).cpu;
                if (dc > 0) {
                    const freq = cpu ? getFrequency(cpu) : 440;
                    startTone(Math.max(20, Math.min(20000, freq)));
                } else {
                    stopTone();
                }
            }));

            // Also respond to digital HIGH/LOW (tone() toggles the pin)
            unsubscribers.push(pinManager.onPinChange(pinSIG, (_: number, state: boolean) => {
                if (!isSounding && state) {
                    const cpu = (avrSimulator as any).cpu;
                    const freq = cpu ? getFrequency(cpu) : 440;
                    startTone(Math.max(20, Math.min(20000, freq)));
                } else if (isSounding && !state) {
                    // Don't stop on every LOW — tone() generates a square wave
                    // We stop only when duty cycle drops to 0 via onPwmChange
                }
            }));
        }

        return () => {
            stopTone();
            if (audioCtx) { audioCtx.close(); audioCtx = null; }
            unsubscribers.forEach(u => u());
        };
    },
});

// ─── LCD 1602 / 2004 ─────────────────────────────────────────────────────────

function createLcdSimulation(cols: number, rows: number) {
    return {
        attachEvents: (element: HTMLElement, avrSimulator: AnySimulator, getArduinoPinHelper: (pin: string) => number | null) => {
            const el = element as any;

            const ddram = new Uint8Array(128).fill(0x20);
            let ddramAddress = 0;
            let entryIncrement = true;
            let displayOn = true;
            let cursorOn = false;
            let blinkOn = false;
            let nibbleState: 'high' | 'low' = 'high';
            let highNibble = 0;
            let initialized = false;
            let initCount = 0;

            let rsState = false;
            let eState = false;
            let d4State = false;
            let d5State = false;
            let d6State = false;
            let d7State = false;

            const lineOffsets = rows >= 4
                ? [0x00, 0x40, 0x14, 0x54]
                : [0x00, 0x40];

            function ddramToLinear(addr: number): number {
                for (let row = 0; row < rows; row++) {
                    const offset = lineOffsets[row];
                    if (addr >= offset && addr < offset + cols) {
                        return row * cols + (addr - offset);
                    }
                }
                return -1;
            }

            function refreshDisplay() {
                if (!displayOn) {
                    el.characters = new Uint8Array(cols * rows).fill(0x20);
                    return;
                }
                const chars = new Uint8Array(cols * rows);
                for (let row = 0; row < rows; row++) {
                    const offset = lineOffsets[row];
                    for (let col = 0; col < cols; col++) {
                        chars[row * cols + col] = ddram[offset + col];
                    }
                }
                el.characters = chars;
                el.cursor = cursorOn;
                el.blink = blinkOn;
                const cursorLinear = ddramToLinear(ddramAddress);
                if (cursorLinear >= 0) {
                    el.cursorX = cursorLinear % cols;
                    el.cursorY = Math.floor(cursorLinear / cols);
                }
            }

            function processByte(rs: boolean, data: number) {
                if (!rs) {
                    if (data & 0x80) {
                        ddramAddress = data & 0x7F;
                    } else if (data & 0x40) {
                        // CGRAM — not implemented
                    } else if (data & 0x20) {
                        initialized = true;
                    } else if (data & 0x10) {
                        const sc = (data >> 3) & 1;
                        const rl = (data >> 2) & 1;
                        if (!sc) { ddramAddress = (ddramAddress + (rl ? 1 : -1)) & 0x7F; }
                    } else if (data & 0x08) {
                        displayOn = !!(data & 0x04);
                        cursorOn  = !!(data & 0x02);
                        blinkOn   = !!(data & 0x01);
                    } else if (data & 0x04) {
                        entryIncrement = !!(data & 0x02);
                    } else if (data & 0x02) {
                        ddramAddress = 0;
                    } else if (data & 0x01) {
                        ddram.fill(0x20);
                        ddramAddress = 0;
                    }
                } else {
                    ddram[ddramAddress & 0x7F] = data;
                    ddramAddress = entryIncrement
                        ? (ddramAddress + 1) & 0x7F
                        : (ddramAddress - 1) & 0x7F;
                }
                refreshDisplay();
            }

            function onEnableFallingEdge() {
                const nibble =
                    (d4State ? 0x01 : 0) |
                    (d5State ? 0x02 : 0) |
                    (d6State ? 0x04 : 0) |
                    (d7State ? 0x08 : 0);

                if (!initialized) {
                    initCount++;
                    if (initCount >= 4) { initialized = true; nibbleState = 'high'; }
                    return;
                }

                if (nibbleState === 'high') {
                    highNibble = nibble << 4;
                    nibbleState = 'low';
                } else {
                    processByte(rsState, highNibble | nibble);
                    nibbleState = 'high';
                }
            }

            const pinRS = getArduinoPinHelper('RS');
            const pinE  = getArduinoPinHelper('E');
            const pinD4 = getArduinoPinHelper('D4');
            const pinD5 = getArduinoPinHelper('D5');
            const pinD6 = getArduinoPinHelper('D6');
            const pinD7 = getArduinoPinHelper('D7');

            const pinManager = (avrSimulator as any).pinManager;
            if (!pinManager) return () => { };

            const unsubscribers: (() => void)[] = [];

            if (pinRS !== null) unsubscribers.push(pinManager.onPinChange(pinRS, (_: number, s: boolean) => { rsState = s; }));
            if (pinD4 !== null) unsubscribers.push(pinManager.onPinChange(pinD4, (_: number, s: boolean) => { d4State = s; }));
            if (pinD5 !== null) unsubscribers.push(pinManager.onPinChange(pinD5, (_: number, s: boolean) => { d5State = s; }));
            if (pinD6 !== null) unsubscribers.push(pinManager.onPinChange(pinD6, (_: number, s: boolean) => { d6State = s; }));
            if (pinD7 !== null) unsubscribers.push(pinManager.onPinChange(pinD7, (_: number, s: boolean) => { d7State = s; }));

            if (pinE !== null) {
                unsubscribers.push(pinManager.onPinChange(pinE, (_: number, s: boolean) => {
                    const wasHigh = eState;
                    eState = s;
                    if (wasHigh && !s) onEnableFallingEdge();
                }));
            }

            refreshDisplay();
            console.log(`[LCD] ${cols}x${rows} simulation initialized`);

            return () => {
                unsubscribers.forEach(u => u());
            };
        },
    };
}

PartSimulationRegistry.register('lcd1602', createLcdSimulation(16, 2));
PartSimulationRegistry.register('lcd2004', createLcdSimulation(20, 4));
