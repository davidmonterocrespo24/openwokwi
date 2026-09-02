/**
 * Pre-built example chips shipped with Velxio. Sources live in `examples/`
 * (and `examples/intel/` for the retro CPU collection) and are loaded at
 * build time via Vite's `?raw` query so they end up as inline string
 * constants in the bundle.
 *
 * The .c sources are the canonical implementations validated by the
 * sandbox at `test/test_custom_chips/` and `test/test_intel/`.
 */

// .c sources — original Velxio chip collection
import inverterC      from './examples/inverter.c?raw';
import xorC           from './examples/xor.c?raw';
import cd4094C        from './examples/cd4094.c?raw';
import eeprom24c01C   from './examples/eeprom-24c01.c?raw';
import eeprom24lc256C from './examples/eeprom-24lc256.c?raw';
import uartRot13C     from './examples/uart-rot13.c?raw';
import sn74hc595C     from './examples/sn74hc595.c?raw';
import mcp3008C       from './examples/mcp3008.c?raw';
import pcf8574C       from './examples/pcf8574.c?raw';
import ds3231C        from './examples/ds3231.c?raw';
import pulseCounterC  from './examples/pulse-counter.c?raw';

// .chip.json sources
import inverterJ      from './examples/inverter.chip.json?raw';
import xorJ           from './examples/xor.chip.json?raw';
import cd4094J        from './examples/cd4094.chip.json?raw';
import eeprom24c01J   from './examples/eeprom-24c01.chip.json?raw';
import eeprom24lc256J from './examples/eeprom-24lc256.chip.json?raw';
import uartRot13J     from './examples/uart-rot13.chip.json?raw';
import sn74hc595J     from './examples/sn74hc595.chip.json?raw';
import mcp3008J       from './examples/mcp3008.chip.json?raw';
import pcf8574J       from './examples/pcf8574.chip.json?raw';
import ds3231J        from './examples/ds3231.chip.json?raw';
import pulseCounterJ  from './examples/pulse-counter.chip.json?raw';

// .c sources — clean-room retro Intel/Zilog CPUs and bus chips
// (test/test_intel — 129 tests, all passing; manuals cited in autosearch/)
import cpu4004C       from './examples/intel/4004.c?raw';
import cpu4040C       from './examples/intel/4040.c?raw';
import cpu8080C       from './examples/intel/8080.c?raw';
import cpu8086C       from './examples/intel/8086.c?raw';
import cpuZ80C        from './examples/intel/z80.c?raw';
import busRom32kC     from './examples/intel/rom-32k.c?raw';
import busRam64kC     from './examples/intel/ram-64k.c?raw';
import busRom1mC      from './examples/intel/rom-1m.c?raw';
import busLatch8282C  from './examples/intel/latch-8282.c?raw';
import bus4001RomC    from './examples/intel/4001-rom.c?raw';
import bus4002RamC    from './examples/intel/4002-ram.c?raw';
import bus8255PpiC    from './examples/intel/8255-ppi.c?raw';
import bus8251UsartC  from './examples/intel/8251-usart.c?raw';
import bus8259PicC    from './examples/intel/8259-pic.c?raw';
import bus8253PitC    from './examples/intel/8253-pit.c?raw';
import i8080ReplC     from './examples/intel/i8080-repl.c?raw';
import i8080CounterC  from './examples/intel/i8080-counter.c?raw';
import i8080CpuC      from './examples/intel/i8080-cpu.c?raw';
import z80CpuC         from './examples/intel/z80-cpu.c?raw';

import cpu4004J       from './examples/intel/4004.chip.json?raw';
import cpu4040J       from './examples/intel/4040.chip.json?raw';
import cpu8080J       from './examples/intel/8080.chip.json?raw';
import cpu8086J       from './examples/intel/8086.chip.json?raw';
import cpuZ80J        from './examples/intel/z80.chip.json?raw';
import busRom32kJ     from './examples/intel/rom-32k.chip.json?raw';
import busRam64kJ     from './examples/intel/ram-64k.chip.json?raw';
import busRom1mJ      from './examples/intel/rom-1m.chip.json?raw';
import busLatch8282J  from './examples/intel/latch-8282.chip.json?raw';
import bus4001RomJ    from './examples/intel/4001-rom.chip.json?raw';
import bus4002RamJ    from './examples/intel/4002-ram.chip.json?raw';
import bus8255PpiJ    from './examples/intel/8255-ppi.chip.json?raw';
import bus8251UsartJ  from './examples/intel/8251-usart.chip.json?raw';
import bus8259PicJ    from './examples/intel/8259-pic.chip.json?raw';
import bus8253PitJ    from './examples/intel/8253-pit.chip.json?raw';
import i8080ReplJ     from './examples/intel/i8080-repl.chip.json?raw';
import i8080CounterJ  from './examples/intel/i8080-counter.chip.json?raw';
import i8080CpuJ      from './examples/intel/i8080-cpu.chip.json?raw';
import z80CpuJ         from './examples/intel/z80-cpu.chip.json?raw';

export interface ChipExample {
  id: string;
  name: string;
  description: string;
  category: 'logic' | 'memory' | 'protocol' | 'analog' | 'utility' | 'retro-cpu' | 'retro-bus' | 'retro-bundle';
  sourceC: string;
  chipJson: string;
}

/**
 * Overlay seam — extra gallery examples (e.g. pro programmable sensors).
 * The gallery reads getChipExamples() and subscribes to pick up entries
 * registered after the overlay's dynamic import lands.
 */
const extraExamples: ChipExample[] = [];
let examplesVersion = 0;
const exampleListeners = new Set<() => void>();

export function registerChipExamples(examples: ChipExample[]): void {
  for (const e of examples) {
    const i = extraExamples.findIndex((x) => x.id === e.id);
    if (i >= 0) extraExamples[i] = e;
    else extraExamples.push(e);
  }
  examplesVersion++;
  exampleListeners.forEach((l) => l());
}

export function getChipExamples(): ChipExample[] {
  return [...CHIP_EXAMPLES, ...extraExamples];
}

export const getChipExamplesVersion = (): number => examplesVersion;
export const subscribeChipExamples = (cb: () => void): (() => void) => {
  exampleListeners.add(cb);
  return () => exampleListeners.delete(cb);
};

export const CHIP_EXAMPLES: ChipExample[] = [
  {
    id: 'inverter',
    name: 'Inverter',
    description: 'OUT = !IN. The simplest possible chip — perfect first example.',
    category: 'logic',
    sourceC: inverterC,
    chipJson: inverterJ,
  },
  {
    id: 'xor',
    name: 'XOR Gate',
    description: '2-input exclusive-OR. OUT = A xor B.',
    category: 'logic',
    sourceC: xorC,
    chipJson: xorJ,
  },
  {
    id: 'cd4094',
    name: 'CD4094 Shift Register',
    description: '8-stage shift-and-store register. Serial in, parallel out, latch on STR.',
    category: 'logic',
    sourceC: cd4094C,
    chipJson: cd4094J,
  },
  {
    id: 'sn74hc595',
    name: '74HC595 SPI Shift Register',
    description: '8-bit serial-in parallel-out via SPI. Latch on RCLK rising edge.',
    category: 'logic',
    sourceC: sn74hc595C,
    chipJson: sn74hc595J,
  },
  {
    id: 'eeprom-24c01',
    name: '24C01 EEPROM (128 B)',
    description: 'I2C EEPROM at base address 0x50. 128 bytes, 8-bit addressing.',
    category: 'memory',
    sourceC: eeprom24c01C,
    chipJson: eeprom24c01J,
  },
  {
    id: 'eeprom-24lc256',
    name: '24LC256 EEPROM (32 KB)',
    description: 'I2C EEPROM at 0x50. 32 KB, 16-bit addressing, page writes.',
    category: 'memory',
    sourceC: eeprom24lc256C,
    chipJson: eeprom24lc256J,
  },
  {
    id: 'pcf8574',
    name: 'PCF8574 I/O Expander',
    description: 'I2C 8-bit I/O expander at base 0x20. Reads/writes 8 lines.',
    category: 'protocol',
    sourceC: pcf8574C,
    chipJson: pcf8574J,
  },
  {
    id: 'ds3231',
    name: 'DS3231 RTC',
    description: 'I2C real-time clock at 0x68. 19 registers, BCD-encoded.',
    category: 'protocol',
    sourceC: ds3231C,
    chipJson: ds3231J,
  },
  {
    id: 'mcp3008',
    name: 'MCP3008 SPI ADC',
    description: '8-channel 10-bit ADC over SPI. Reads 0–5V analog inputs.',
    category: 'analog',
    sourceC: mcp3008C,
    chipJson: mcp3008J,
  },
  {
    id: 'uart-rot13',
    name: 'ROT13 UART',
    description: 'UART loopback that ROT13-shifts every received byte.',
    category: 'protocol',
    sourceC: uartRot13C,
    chipJson: uartRot13J,
  },
  {
    id: 'pulse-counter',
    name: 'Pulse Counter',
    description: 'Counts rising edges on PULSE. Toggles OVF every N pulses (configurable).',
    category: 'utility',
    sourceC: pulseCounterC,
    chipJson: pulseCounterJ,
  },

  // ── Bundled "drop-and-go" retro demos ─────────────────────────────────
  {
    id: 'i8080-cpu',
    name: 'i8080 CPU (programmable)',
    description:
      'Programmable Intel 8080 chip. Add a .s/.hex/.bin file to your project, ' +
      'click Compile, then Run. Same chip, any program — mini PC, calculator, ' +
      'LED demo, Kill-the-Bit, your call. 32 KB ROM + 16 KB RAM + 8 LEDs + 8 ' +
      'buttons + UART.',
    category: 'retro-bundle',
    sourceC: i8080CpuC,
    chipJson: i8080CpuJ,
  },
  {
    id: 'z80-cpu',
    name: 'Z80 CPU (programmable)',
    description:
      'Programmable Zilog Z80 chip — full Z80 ISA including JR, DJNZ, EXX, ' +
      'LDIR, IM 0/1/2, IX/IY. Write Z80 assembly in a .s file or drop a ' +
      'pre-compiled .hex/.bin, click Compile, click Run.',
    category: 'retro-bundle',
    sourceC: z80CpuC,
    chipJson: z80CpuJ,
  },
  {
    id: 'i8080-repl',
    name: 'i8080 Mini-Computer (Banner)',
    description:
      'Complete 8080 mini-computer in one chip — internal ROM/RAM + UART. ' +
      'Boots, prints a banner, then increments an uptime counter on UART ' +
      'every ~50 ms using a real busy-wait. Watch it run via the Serial Monitor.',
    category: 'retro-bundle',
    sourceC: i8080ReplC,
    chipJson: i8080ReplJ,
  },
  {
    id: 'i8080-counter',
    name: 'i8080 Button Counter',
    description:
      'Self-contained 8080 board: press BTN_INC to count up on LED0..LED7, ' +
      'press BTN_RST to clear. The whole program is a 34-byte 8080 ROM ' +
      'embedded in the chip.',
    category: 'retro-bundle',
    sourceC: i8080CounterC,
    chipJson: i8080CounterJ,
  },

  // ── Clean-room retro CPUs (test/test_intel — 129 passing tests) ───────
  {
    id: 'intel-4004',
    name: 'Intel 4004 CPU',
    description:
      '1971 — first commercial microprocessor. 4-bit ISA, 46 instructions, ' +
      'multiplexed nibble bus on D0..D3. Wire it to a 4001-rom and 4002-ram.',
    category: 'retro-cpu',
    sourceC: cpu4004C,
    chipJson: cpu4004J,
  },
  {
    id: 'intel-4040',
    name: 'Intel 4040 CPU',
    description:
      '1974 — 4004 successor with interrupts, single-step and 14 new opcodes. ' +
      'Same nibble-bus protocol as the 4004.',
    category: 'retro-cpu',
    sourceC: cpu4040C,
    chipJson: cpu4040J,
  },
  {
    id: 'intel-8080',
    name: 'Intel 8080 CPU',
    description:
      '1975 — 8-bit ISA with 16-bit address bus. Validated against ' +
      "Microcosm's 1980 CPUDIAG (\"CPU IS OPERATIONAL\").",
    category: 'retro-cpu',
    sourceC: cpu8080C,
    chipJson: cpu8080J,
  },
  {
    id: 'intel-8086',
    name: 'Intel 8086 CPU',
    description:
      '1978 — 16-bit ISA, 1 MB address space via segments, multiplexed AD bus ' +
      'latched by ALE. Minimum-mode by default.',
    category: 'retro-cpu',
    sourceC: cpu8086C,
    chipJson: cpu8086J,
  },
  {
    id: 'zilog-z80',
    name: 'Zilog Z80 CPU',
    description:
      '1976 — 8080-compatible plus IX/IY, shadow registers, block ops, ' +
      "IM 0/1/2 interrupts. Validated against Frank Cringle's ZEXDOC.",
    category: 'retro-cpu',
    sourceC: cpuZ80C,
    chipJson: cpuZ80J,
  },

  // ── Retro bus / peripheral chips ──────────────────────────────────────
  {
    id: 'rom-32k',
    name: '27C256 ROM (32 KB)',
    description:
      'Generic 32 KB EPROM. 15-bit address bus, 8-bit data, /CE + /OE.',
    category: 'retro-bus',
    sourceC: busRom32kC,
    chipJson: busRom32kJ,
  },
  {
    id: 'ram-64k',
    name: 'HM62256 SRAM (64 KB)',
    description:
      'Generic 64 KB static RAM. 16-bit address, 8-bit data, /CE + /OE + /WE.',
    category: 'retro-bus',
    sourceC: busRam64kC,
    chipJson: busRam64kJ,
  },
  {
    id: 'rom-1m',
    name: '1 MB ROM (8086 boot)',
    description:
      '1 MB ROM with 64 KB mapped at 0xF0000 — the canonical 8086 reset-vector layout.',
    category: 'retro-bus',
    sourceC: busRom1mC,
    chipJson: busRom1mJ,
  },
  {
    id: 'latch-8282',
    name: 'Intel 8282 Latch',
    description:
      'Octal address latch (8 inputs + 8 outputs + STB + /OE). ' +
      "The classic 8086 AD-bus demuxer.",
    category: 'retro-bus',
    sourceC: busLatch8282C,
    chipJson: busLatch8282J,
  },
  {
    id: 'intel-4001-rom',
    name: 'Intel 4001 ROM (256 B + I/O)',
    description:
      "256-byte ROM with 4 I/O lines — the 4004's original system companion. " +
      'Talks to the 4004 over the nibble bus.',
    category: 'retro-bus',
    sourceC: bus4001RomC,
    chipJson: bus4001RomJ,
  },
  {
    id: 'intel-4002-ram',
    name: 'Intel 4002 RAM (320 bits + I/O)',
    description:
      "320-bit RAM with 4 output lines — the 4004's original RAM companion.",
    category: 'retro-bus',
    sourceC: bus4002RamC,
    chipJson: bus4002RamJ,
  },
  {
    id: 'intel-8255-ppi',
    name: 'Intel 8255 PPI',
    description:
      '3× 8-bit parallel I/O ports (PA/PB/PC), Mode 0 implemented. ' +
      'The IBM PC keyboard/printer chip.',
    category: 'retro-bus',
    sourceC: bus8255PpiC,
    chipJson: bus8255PpiJ,
  },
  {
    id: 'intel-8251-usart',
    name: 'Intel 8251 USART',
    description:
      'Programmable async serial — TXD/RXD/status/command. ' +
      "Routed to Velxio's UART bridge for Serial Monitor I/O.",
    category: 'retro-bus',
    sourceC: bus8251UsartC,
    chipJson: bus8251UsartJ,
  },
  {
    id: 'intel-8259-pic',
    name: 'Intel 8259 PIC',
    description:
      'Programmable Interrupt Controller — single-master, 8 IRQ lines, ' +
      'full ICW/OCW programming model.',
    category: 'retro-bus',
    sourceC: bus8259PicC,
    chipJson: bus8259PicJ,
  },
  {
    id: 'intel-8253-pit',
    name: 'Intel 8253 PIT',
    description:
      'Programmable Interval Timer — 3 independent 16-bit counters, ' +
      'Modes 0/2/3. The IBM PC 18.2 Hz tick chip.',
    category: 'retro-bus',
    sourceC: bus8253PitC,
    chipJson: bus8253PitJ,
  },
];

export function findExample(id: string): ChipExample | undefined {
  return CHIP_EXAMPLES.find((e) => e.id === id);
}

export const BLANK_CHIP: ChipExample = {
  id: 'blank',
  name: 'Blank',
  description: 'Start from scratch.',
  category: 'utility',
  sourceC: `#include "velxio-chip.h"
#include <stdlib.h>

typedef struct {
  vx_pin in;
  vx_pin out;
} chip_state_t;

static void on_in_change(void *ud, vx_pin pin, int value) {
  chip_state_t *s = (chip_state_t*)ud;
  vx_pin_write(s->out, value);
}

void chip_setup(void) {
  chip_state_t *s = (chip_state_t*)malloc(sizeof(chip_state_t));
  s->in  = vx_pin_register("IN",  VX_INPUT);
  s->out = vx_pin_register("OUT", VX_OUTPUT);
  vx_pin_watch(s->in, VX_EDGE_BOTH, on_in_change, s);
  vx_log("blank chip ready");
}
`,
  chipJson: `{
  "schema": "velxio-chip/v1",
  "name": "My Chip",
  "author": "",
  "license": "MIT",
  "description": "",
  "pins": ["IN", "OUT", "GND", "VCC"],
  "attributes": []
}
`,
};
