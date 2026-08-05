import type { ExampleProject } from './examples';

/**
 * ESP32-S3 + ILI9341 TFT over hardware SPI (GPSPI2 / FSPI). Lightweight draw
 * (fill + rounded rect + text) to exercise the S3 GPSPI2 controller ->
 * picsimlab_spi -> the TFT decoder on the canvas.
 */
export const esp32s3TftExamples: ExampleProject[] = [
  {
    id: 'esp32s3-ili9341-hello',
    title: 'ILI9341 TFT Hello — ESP32-S3',
    description:
      'Draws a filled screen, a rounded rectangle and text on a 320x240 ' +
      'ILI9341 TFT from an ESP32-S3 over hardware SPI (FSPI / GPSPI2).',
    category: 'displays',
    difficulty: 'intermediate',
    libraries: ['Adafruit ILI9341', 'Adafruit GFX Library', 'Adafruit BusIO'],
    tags: ['esp32-s3', 'ili9341', 'tft', 'spi', 'display'],
    boards: [
      {
        boardKind: 'esp32-s3',
        x: 60,
        y: 80,
        code: `// ILI9341 320x240 TFT on ESP32-S3 hardware SPI (FSPI / GPSPI2)
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>

#define TFT_SCK  12
#define TFT_MISO 13
#define TFT_MOSI 11
#define TFT_CS   10
#define TFT_DC    9
#define TFT_RST   8

Adafruit_ILI9341 tft = Adafruit_ILI9341(TFT_CS, TFT_DC, TFT_RST);

void setup() {
  Serial.begin(115200);
  SPI.begin(TFT_SCK, TFT_MISO, TFT_MOSI, TFT_CS);
  tft.begin();
  tft.setRotation(1);

  tft.fillScreen(ILI9341_NAVY);
  tft.fillRoundRect(20, 30, 280, 90, 10, ILI9341_RED);

  tft.setCursor(38, 55);
  tft.setTextColor(ILI9341_WHITE);
  tft.setTextSize(4);
  tft.println("ESP32-S3");

  tft.setCursor(38, 150);
  tft.setTextColor(ILI9341_YELLOW);
  tft.setTextSize(2);
  tft.println("TFT via GPSPI2");

  Serial.println("tft drawn");
}

void loop() {
  delay(2000);
}
`,
      },
    ],
    code: '',
    components: [
      { type: 'wokwi-ili9341', id: 'tft1', x: 470, y: 70, properties: {} },
    ],
    wires: [
      { id: 'w-tft-sck',  start: { componentId: 'esp32-s3', pinName: '12' }, end: { componentId: 'tft1', pinName: 'SCK'  }, color: '#ff8800' },
      { id: 'w-tft-mosi', start: { componentId: 'esp32-s3', pinName: '11' }, end: { componentId: 'tft1', pinName: 'MOSI' }, color: '#ff8800' },
      { id: 'w-tft-miso', start: { componentId: 'esp32-s3', pinName: '13' }, end: { componentId: 'tft1', pinName: 'MISO' }, color: '#ffaa44' },
      { id: 'w-tft-cs',   start: { componentId: 'esp32-s3', pinName: '10' }, end: { componentId: 'tft1', pinName: 'CS'   }, color: '#00aaff' },
      { id: 'w-tft-dc',   start: { componentId: 'esp32-s3', pinName: '9'  }, end: { componentId: 'tft1', pinName: 'D/C'  }, color: '#00cc00' },
      { id: 'w-tft-rst',  start: { componentId: 'esp32-s3', pinName: '8'  }, end: { componentId: 'tft1', pinName: 'RST'  }, color: '#cc0000' },
      { id: 'w-tft-led',  start: { componentId: 'esp32-s3', pinName: '3V3' }, end: { componentId: 'tft1', pinName: 'LED' }, color: '#ffffff' },
      { id: 'w-tft-vcc',  start: { componentId: 'esp32-s3', pinName: '3V3' }, end: { componentId: 'tft1', pinName: 'VCC' }, color: '#ff0000' },
      { id: 'w-tft-gnd',  start: { componentId: 'esp32-s3', pinName: 'GND' }, end: { componentId: 'tft1', pinName: 'GND' }, color: '#000000' },
    ],
  },
];
