/**
 * piSlaveScanner — turn canvas wires into pi_attach_slave commands.
 *
 * When the user wires a virtual I2C/SPI/UART component (e.g. BMP280)
 * to a Raspberry Pi's protocol pins on the canvas, this helper detects
 * the connection and emits the backend WebSocket frame that tells the
 * pro overlay to instantiate the corresponding slave model in the
 * PiSlaveRegistry.
 *
 * The mapping from a wokwi component metadata ID to a backend
 * model_id lives in COMPONENT_TO_MODEL. New devices are added there
 * plus a new file under pro/backend/app/pro/services/pi_slaves/.
 */
import type { RaspberryPi3Bridge } from './RaspberryPi3Bridge';

type CanvasWire = {
  start: { componentId: string; pinName: string };
  end:   { componentId: string; pinName: string };
};

/** Shape we depend on from useSimulatorStore.Component. */
type CanvasComponent = {
  id: string;
  metadataId: string;
  properties?: Record<string, unknown>;
};

// Raspberry Pi 40-pin header → bus assignment. Keys are physical pin
// numbers as strings (matching the wire endpoint pinName format).
//   - SDA1/SCL1 → I2C bus 1
//   - MOSI/MISO/SCLK → SPI bus 0 (CE0/CE1 distinguish slaves)
//   - TXD/RXD → primary UART (port 0)
// Both namings are accepted: the wire may carry the PHYSICAL pin number
// ('3') or the BCM label the board art actually exposes ('GPIO2'). The
// scanner shipped matching only physical numbers while every element
// names its pads GPIOxx — so no wire ever classified and the whole
// slave-attach path was dead.
const I2C_PINS = new Set(['3', '5', 'GPIO2', 'GPIO3', 'SDA', 'SCL', 'SDA1', 'SCL1']);
const SPI_DATA_PINS = new Set(['19', '21', '23', 'GPIO10', 'GPIO9', 'GPIO11', 'MOSI', 'MISO', 'SCLK', 'SCK']);
const SPI_CE0_PINS = new Set(['24', 'GPIO8', 'CE0']);
const SPI_CE1_PINS = new Set(['26', 'GPIO7', 'CE1']);
const UART_PINS = new Set(['8', '10', 'GPIO14', 'GPIO15', 'TXD', 'RXD', 'TX', 'RX']);

// Map wokwi component metadata IDs / element types → backend model_id.
// Lowercase. Components not in this table get skipped silently.
const COMPONENT_TO_MODEL: Record<string, string> = {
  'wokwi-bmp280':  'bme280',   // same chip family, treat as superset
  'velxio-bmp280': 'bme280',
  'wokwi-bme280':  'bme280',
};

const DEFAULT_I2C_ADDRESS: Record<string, number> = {
  bme280: 0x76,
};

function modelIdFor(component: CanvasComponent): string | null {
  const t = component.metadataId?.toLowerCase();
  return t ? COMPONENT_TO_MODEL[t] ?? null : null;
}

function i2cAddressFor(component: CanvasComponent, modelId: string): number {
  const propAddr = component.properties?.address;
  if (typeof propAddr === 'number') return propAddr;
  if (typeof propAddr === 'string' && propAddr.length > 0) {
    const parsed = Number(propAddr);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return DEFAULT_I2C_ADDRESS[modelId] ?? 0x76;
}

function configFor(component: CanvasComponent): Record<string, unknown> {
  // Initial pass: only forward known keys so backend ctor surface is
  // narrow. Each model declares its own kwargs.
  const out: Record<string, unknown> = {};
  const p = component.properties ?? {};
  for (const key of ['temperature_c', 'humidity_pct', 'pressure_pa']) {
    if (typeof p[key] === 'number') out[key] = p[key];
  }
  return out;
}

/**
 * Returns the (bus_kind, identifying_pin) describing how `pinName`
 * on the Pi is being used, or null if it isn't a protocol pin.
 */
function classifyPiPin(pinName: string): {
  bus_kind: 'i2c' | 'spi' | 'uart';
  bus_num: number;
} | null {
  if (I2C_PINS.has(pinName)) return { bus_kind: 'i2c', bus_num: 1 };
  if (SPI_DATA_PINS.has(pinName) || SPI_CE0_PINS.has(pinName) || SPI_CE1_PINS.has(pinName))
    return { bus_kind: 'spi', bus_num: 0 };
  if (UART_PINS.has(pinName)) return { bus_kind: 'uart', bus_num: 0 };
  return null;
}

/**
 * Iterate every wire; if one side is a Pi protocol pin and the other
 * side is a known I2C/SPI/UART component, emit pi_attach_slave.
 *
 * Returns the list of attach specs emitted (for tests).
 */
export function attachSlavesFromCanvas(
  piBoardId: string,
  bridge: Pick<RaspberryPi3Bridge, 'attachSlave'>,
  components: CanvasComponent[],
  wires: CanvasWire[],
): Array<Parameters<RaspberryPi3Bridge['attachSlave']>[0]> {
  const componentsById = new Map(components.map((c) => [c.id, c]));
  // dedupe attaches by (bus_kind, bus_num, address_or_cs)
  const seen = new Set<string>();
  const emitted: Array<Parameters<RaspberryPi3Bridge['attachSlave']>[0]> = [];

  for (const wire of wires) {
    let piEndpoint: { pinName: string } | null = null;
    let otherEndpoint: { componentId: string } | null = null;
    if (wire.start.componentId === piBoardId) {
      piEndpoint = wire.start;
      otherEndpoint = wire.end;
    } else if (wire.end.componentId === piBoardId) {
      piEndpoint = wire.end;
      otherEndpoint = wire.start;
    } else {
      continue;
    }

    const bus = classifyPiPin(piEndpoint.pinName);
    if (!bus) continue;

    const peer = componentsById.get(otherEndpoint.componentId);
    if (!peer) continue;
    const modelId = modelIdFor(peer);
    if (!modelId) continue;

    let spec: Parameters<RaspberryPi3Bridge['attachSlave']>[0];
    if (bus.bus_kind === 'i2c') {
      const address = i2cAddressFor(peer, modelId);
      spec = {
        bus_kind: 'i2c',
        bus_num:  bus.bus_num,
        address,
        model_id: modelId,
        config:   configFor(peer),
      };
    } else if (bus.bus_kind === 'spi') {
      // CS line determines logical slave index. Treat MOSI/MISO/SCLK
      // wires as informational only — the CE wire is the one that
      // pins down which slave gets attached.
      let cs: number;
      if (SPI_CE0_PINS.has(piEndpoint.pinName)) cs = 0;
      else if (SPI_CE1_PINS.has(piEndpoint.pinName)) cs = 1;
      else continue;
      spec = {
        bus_kind: 'spi',
        bus_num:  bus.bus_num,
        cs,
        model_id: modelId,
        config:   configFor(peer),
      };
    } else {
      spec = {
        bus_kind: 'uart',
        bus_num:  bus.bus_num,
        model_id: modelId,
        config:   configFor(peer),
      };
    }

    const key =
      spec.bus_kind === 'i2c'
        ? `i2c:${spec.bus_num}:${spec.address}`
        : spec.bus_kind === 'spi'
          ? `spi:${spec.bus_num}:${spec.cs}`
          : `uart:${spec.bus_num}`;
    if (seen.has(key)) continue;
    seen.add(key);

    bridge.attachSlave(spec);
    emitted.push(spec);
  }
  return emitted;
}
