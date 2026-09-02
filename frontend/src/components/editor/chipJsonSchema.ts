/**
 * JSON Schema for a custom chip's `chip.json`, registered on Monaco so the
 * manifest gets validation + completion while edited in the common editor.
 * Canonical `pins` is the flat array (Wokwi convention) — the legacy
 * {left,right} object is rejected here with a pointed message even though
 * the runtime still flattens it for old projects.
 */
export const CHIP_JSON_SCHEMA_URI = 'velxio://schemas/chip.json';

export const CHIP_JSON_SCHEMA = {
  type: 'object',
  required: ['name', 'pins'],
  properties: {
    schema: {
      type: 'string',
      description: 'Manifest format tag. Always "velxio-chip/v1". Optional.',
    },
    name: { type: 'string', description: 'Display name of the chip.' },
    author: { type: 'string' },
    license: { type: 'string' },
    description: { type: 'string' },
    pins: {
      type: 'array',
      description:
        'FLAT array of pin names in order (Wokwi convention). Half are laid ' +
        'out left, half right; "" skips a slot; {name,x,y} places a pin ' +
        'explicitly. Never a {left,right} object.',
      items: {
        oneOf: [
          { type: 'string' },
          {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
            },
            additionalProperties: false,
          },
        ],
      },
    },
    attributes: {
      type: 'array',
      description:
        'User-tunable values read by the chip with vx_attr_read. An entry ' +
        'with min+max renders as a slider.',
      items: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          label: { type: 'string' },
          type: { enum: ['int', 'float', 'number'] },
          default: { type: 'number' },
          min: { type: 'number' },
          max: { type: 'number' },
          step: { type: 'number' },
        },
        additionalProperties: false,
      },
    },
    controls: {
      type: 'array',
      description:
        'Interactive controls shown WHILE THE SIMULATION RUNS (Wokwi-' +
        'compatible). Each control drives the attribute with the same name.',
      items: {
        type: 'object',
        required: ['id', 'type'],
        properties: {
          id: {
            type: 'string',
            description: 'Attribute name this control drives (vx_attr_read).',
          },
          label: { type: 'string' },
          type: { enum: ['range', 'button'] },
          min: { type: 'number' },
          max: { type: 'number' },
          step: { type: 'number' },
          unit: { type: 'string' },
          scale: { enum: ['log'] },
        },
        additionalProperties: false,
      },
    },
    display: {
      type: 'object',
      description: 'Framebuffer size for vx_framebuffer_init (RGBA8888).',
      required: ['width', 'height'],
      properties: {
        width: { type: 'number' },
        height: { type: 'number' },
      },
      additionalProperties: false,
    },
    programTargets: {
      type: 'array',
      description:
        'CPU targets for programmable chips — enables the program.c / ROM ' +
        'pipeline (SDCC / assembler).',
      items: { enum: ['8080', 'z80', '8086', '4004'] },
    },
  },
  additionalProperties: true,
} as const;
