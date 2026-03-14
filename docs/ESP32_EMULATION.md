# ESP32 Emulation — Documentación Técnica

> Estado: **Funcional** · Backend completo · Frontend completo
> Motor: **lcgamboa/qemu-8.1.3** · Plataforma: **arduino-esp32 2.0.17 (IDF 4.4.x)**

---

## Índice

1. [Instalación rápida](#1-instalación-rápida)
2. [Arquitectura general](#2-arquitectura-general)
3. [Componentes del sistema](#3-componentes-del-sistema)
4. [Firmware — Requisitos para lcgamboa](#4-firmware--requisitos-para-lcgamboa)
5. [WiFi emulada](#5-wifi-emulada)
6. [I2C emulado](#6-i2c-emulado)
7. [RMT / NeoPixel (WS2812)](#7-rmt--neopixel-ws2812)
8. [LEDC / PWM](#8-ledc--pwm)
9. [Compilación de la DLL](#9-compilación-de-la-dll)
10. [Tests](#10-tests)
11. [Frontend — Eventos implementados](#11-frontend--eventos-implementados)
12. [Limitaciones conocidas](#12-limitaciones-conocidas)
13. [Variables de entorno](#13-variables-de-entorno)

---

## 1. Instalación rápida

Esta sección cubre todo lo necesario para tener la emulación ESP32 funcionando desde cero en Windows.

### 1.1 Prerrequisitos de sistema

| Herramienta | Versión mínima | Para qué se usa |
|-------------|----------------|-----------------|
| Python | 3.11+ | Backend FastAPI |
| MSYS2 | cualquiera | Compilar la DLL de QEMU |
| arduino-cli | 1.x | Compilar sketches ESP32 |
| esptool | 4.x o 5.x | Crear imágenes flash de 4 MB |
| Git | 2.x | Clonar submodule qemu-lcgamboa |

### 1.2 Instalar MSYS2

Descarga e instala desde [msys2.org](https://www.msys2.org) o via winget:

```powershell
winget install MSYS2.MSYS2
```

Abre la terminal **MSYS2 MINGW64** y ejecuta:

```bash
pacman -Syu   # actualizar base

pacman -S \
  mingw-w64-x86_64-gcc \
  mingw-w64-x86_64-glib2 \
  mingw-w64-x86_64-libgcrypt \
  mingw-w64-x86_64-libslirp \
  mingw-w64-x86_64-pixman \
  mingw-w64-x86_64-ninja \
  mingw-w64-x86_64-meson \
  mingw-w64-x86_64-python \
  mingw-w64-x86_64-pkg-config \
  git diffutils
```

### 1.3 Instalar arduino-cli y el core ESP32 2.0.17

```bash
# Instalar arduino-cli (si no lo tienes)
winget install ArduinoSA.arduino-cli

# Verificar
arduino-cli version

# Añadir soporte ESP32
arduino-cli core update-index
arduino-cli core install esp32:esp32@2.0.17   # ← IMPORTANTE: 2.x, NO 3.x

# Verificar
arduino-cli core list   # debe mostrar esp32:esp32  2.0.17
```

> **¿Por qué 2.0.17 y no 3.x?** El WiFi emulado de lcgamboa desactiva la caché SPI flash
> periódicamente. En IDF 5.x (arduino-esp32 3.x) esto provoca un crash de caché cuando las
> interrupciones del core 0 intentan ejecutar código desde IROM. IDF 4.4.x es compatible.

### 1.4 Instalar esptool

```bash
pip install esptool
# Verificar
esptool version   # o: python -m esptool version
```

### 1.5 Compilar la DLL de QEMU (libqemu-xtensa.dll)

La DLL es el motor principal de la emulación. Hay que compilarla una vez desde el submodule `wokwi-libs/qemu-lcgamboa`.

```bash
# Asegurarse de tener el submodule
git submodule update --init wokwi-libs/qemu-lcgamboa

# Abrir terminal MSYS2 MINGW64 y navegar al repo
cd /e/Hardware/wokwi_clon   # ajusta la ruta

# Paso 1: Configurar QEMU para Xtensa
cd wokwi-libs/qemu-lcgamboa
./configure \
  --target-list=xtensa-softmmu \
  --disable-werror \
  --enable-tcg \
  --enable-gcrypt \
  --enable-slirp \
  --enable-iconv \
  --without-default-features

# Paso 2: Compilar el binario principal (5-20 min según CPU)
ninja -j$(nproc) qemu-system-xtensa.exe

# Paso 3: Relinkar como DLL (script automático)
cd /e/Hardware/wokwi_clon
bash build_qemu_step4.sh
```

El script `build_qemu_step4.sh` genera `libqemu-xtensa.dll` y la copia automáticamente a `backend/app/services/`.

**Verificar que la DLL se creó:**
```bash
ls -lh backend/app/services/libqemu-xtensa.dll
# → debe ser ~40-50 MB
```

**Verificar exports:**
```bash
objdump -p backend/app/services/libqemu-xtensa.dll | grep -i "qemu_picsimlab\|qemu_init"
# → debe mostrar qemu_init, qemu_main_loop, qemu_picsimlab_register_callbacks, etc.
```

### 1.6 Obtener los ROM binaries del ESP32

La DLL necesita dos archivos ROM de Espressif para arrancar el ESP32. Vienen incluidos en la instalación de Espressif QEMU:

**Opción A — Desde esp-qemu (si está instalado):**
```bash
copy "C:\esp-qemu\qemu\share\qemu\esp32-v3-rom.bin" backend\app\services\
copy "C:\esp-qemu\qemu\share\qemu\esp32-v3-rom-app.bin" backend\app\services\
```

**Opción B — Descargar directamente:**

Los ROM binaries son del repositorio oficial de Espressif:
```bash
# Busca en: https://github.com/espressif/qemu/tree/esp-develop/pc-bios
# Descargar: esp32-v3-rom.bin  y  esp32-v3-rom-app.bin
# Colocarlos en backend/app/services/
```

**Verificar:**
```bash
ls -lh backend/app/services/esp32-v3-rom.bin
ls -lh backend/app/services/esp32-v3-rom-app.bin
# → ambos ~446 KB
```

### 1.7 Instalar dependencias Python del backend

```bash
cd backend
python -m venv venv
venv\Scripts\activate        # Windows
pip install -r requirements.txt
```

### 1.8 Verificar instalación con los tests

```bash
# Desde la raíz del repo (con venv activado):
python -m pytest test/esp32/test_esp32_lib_bridge.py -v

# Resultado esperado: 28 passed en ~13 segundos
```

Si ves `28 passed` — la emulación está completamente funcional.

**Tests adicionales (Arduino ↔ ESP32 serial):**
```bash
python -m pytest test/esp32/test_arduino_esp32_integration.py -v
# Resultado esperado: 13 passed
```

### 1.9 Arrancar el backend con emulación ESP32

```bash
cd backend
venv\Scripts\activate
uvicorn app.main:app --reload --port 8001
```

El sistema detecta automáticamente la DLL. Verifica en los logs:
```
INFO: libqemu-xtensa.dll found at backend/app/services/libqemu-xtensa.dll
INFO: EspLibManager: DLL mode active (GPIO, ADC, UART, WiFi, I2C, SPI, RMT, LEDC)
```

Si no aparece, verifica con:
```bash
python -c "
import sys; sys.path.insert(0,'backend')
from app.services.esp32_lib_manager import esp_lib_manager
print('DLL disponible:', esp_lib_manager.is_available())
"
```

### 1.10 Compilar un sketch propio para ESP32

```bash
# Compilar con DIO flash mode (requerido por QEMU lcgamboa):
arduino-cli compile \
  --fqbn esp32:esp32:esp32:FlashMode=dio \
  --output-dir build/ \
  mi_sketch/

# Crear imagen 4 MB completa (obligatorio para QEMU):
esptool --chip esp32 merge_bin \
  --fill-flash-size 4MB \
  -o firmware.merged.bin \
  --flash_mode dio \
  --flash_size 4MB \
  0x1000  build/mi_sketch.ino.bootloader.bin \
  0x8000  build/mi_sketch.ino.partitions.bin \
  0x10000 build/mi_sketch.ino.bin
```

El archivo `firmware.merged.bin` es el que se carga en la emulación.

---

## 2. Arquitectura general

```
Usuario (browser)
  └── WebSocket (/ws/{client_id})
        └── simulation.py  (FastAPI router)
              ├── EspLibManager          ← backend con DLL (GPIO, WiFi, I2C, SPI, RMT…)
              └── EspQemuManager         ← fallback solo-UART via subprocess
                    │
              [QEMU_ESP32_LIB=libqemu-xtensa.dll]
                    │
              Esp32LibBridge (ctypes)
                    │
              libqemu-xtensa.dll  ←  lcgamboa fork de QEMU 8.1.3
                    │
              Machine: esp32-picsimlab
                    │
         ┌──────────┴──────────┐
     CPU Xtensa LX6      periféricos emulados
     (dual-core)    GPIO · ADC · UART · I2C · SPI
                    RMT · LEDC · Timer · WiFi · Flash
```

El sistema selecciona backend automáticamente:
- **DLL disponible** → `EspLibManager` (GPIO completo + todos los periféricos)
- **DLL ausente** → `EspQemuManager` (solo UART serial via TCP, subprocess QEMU)

Activación de DLL: colocar `libqemu-xtensa.dll` en `backend/app/services/` o setear:
```bash
QEMU_ESP32_LIB=C:/ruta/a/libqemu-xtensa.dll uvicorn app.main:app
```

---

## 3. Componentes del sistema

### 3.1 `libqemu-xtensa.dll`

Compilada desde el fork [lcgamboa/qemu](https://github.com/lcgamboa/qemu) rama `qemu-8.1.3`.

**Dependencias en runtime (Windows) — resueltas automáticamente:**
```
C:\msys64\mingw64\bin\
  libglib-2.0-0.dll
  libgcrypt-20.dll
  libgpg-error-0.dll
  libslirp-0.dll
  libintl-8.dll
  libpcre2-8-0.dll
  (y ~15 DLLs más de MinGW64)
```

El bridge las registra automáticamente con `os.add_dll_directory()`.

**ROM binaries requeridas** (en la misma carpeta que la DLL):
```
backend/app/services/
  libqemu-xtensa.dll        ← motor principal (no en git — 43 MB)
  esp32-v3-rom.bin          ← ROM de boot del ESP32 (no en git — 446 KB)
  esp32-v3-rom-app.bin      ← ROM de aplicación  (no en git — 446 KB)
```

> Estos archivos están en `.gitignore` por su tamaño. Cada desarrollador los genera/obtiene localmente (ver sección 1.5 y 1.6).

**Exports de la DLL:**
```c
void    qemu_init(int argc, char** argv, char** envp)
void    qemu_main_loop(void)
void    qemu_cleanup(void)
void    qemu_picsimlab_register_callbacks(callbacks_t* cbs)
void    qemu_picsimlab_set_pin(int slot, int value)        // GPIO input
void    qemu_picsimlab_set_apin(int channel, int value)    // ADC input (0-4095)
void    qemu_picsimlab_uart_receive(int id, uint8_t* buf, int size)
void*   qemu_picsimlab_get_internals(int type)             // LEDC duty array
int     qemu_picsimlab_get_TIOCM(void)                     // UART modem lines
```

**Struct de callbacks C:**
```c
typedef struct {
    void    (*picsimlab_write_pin)(int pin, int value);       // GPIO output changed
    void    (*picsimlab_dir_pin)(int pin, int value);         // GPIO direction changed
    int     (*picsimlab_i2c_event)(uint8_t id, uint8_t addr, uint16_t event);
    uint8_t (*picsimlab_spi_event)(uint8_t id, uint16_t event);
    void    (*picsimlab_uart_tx_event)(uint8_t id, uint8_t value);
    const short int *pinmap;   // slot → GPIO number mapping
    void    (*picsimlab_rmt_event)(uint8_t ch, uint32_t config0, uint32_t value);
} callbacks_t;
```

---

### 3.2 GPIO Pinmap

```python
# Identity mapping: QEMU IRQ slot i → GPIO number i-1
_PINMAP = (ctypes.c_int16 * 41)(
    40,               # pinmap[0] = count
    *range(40)        # pinmap[1..40] = GPIO 0..39
)
```

Cuando GPIO N cambia, QEMU llama `picsimlab_write_pin(slot=N+1, value)`.
El bridge traduce automáticamente slot → GPIO real antes de notificar listeners.

**GPIOs input-only en ESP32-WROOM-32:** `{34, 35, 36, 39}` — no pueden ser output.

---

### 3.3 `Esp32LibBridge` (Python ctypes)

Archivo: `backend/app/services/esp32_lib_bridge.py`

```python
bridge = Esp32LibBridge(lib_path, asyncio_loop)

# Registrar listeners (async, llamados desde asyncio)
bridge.register_gpio_listener(fn)    # fn(gpio_num: int, value: int)
bridge.register_dir_listener(fn)     # fn(gpio_num: int, direction: int)
bridge.register_uart_listener(fn)    # fn(uart_id: int, byte_val: int)
bridge.register_rmt_listener(fn)     # fn(channel: int, config0: int, value: int)

# Registrar handlers I2C/SPI (sync, llamados desde thread QEMU)
bridge.register_i2c_handler(fn)      # fn(bus, addr, event) -> int
bridge.register_spi_handler(fn)      # fn(bus, event) -> int

# Control
bridge.start(firmware_b64, machine='esp32-picsimlab')
bridge.stop()
bridge.is_alive  # bool

# GPIO / ADC / UART
bridge.set_pin(gpio_num, value)      # Drive GPIO input (usa GPIO real 0-39)
bridge.set_adc(channel, millivolts)  # ADC en mV (0-3300)
bridge.set_adc_raw(channel, raw)     # ADC en raw 12-bit (0-4095)
bridge.uart_send(uart_id, data)      # Enviar bytes al UART RX del ESP32

# LEDC/PWM
bridge.get_ledc_duty(channel)        # canal 0-15 → raw duty | None
bridge.get_tiocm()                   # UART modem lines bitmask
```

**Threading crítico:**
`qemu_init()` y `qemu_main_loop()` **deben correr en el mismo thread** (BQL — Big QEMU Lock es thread-local). El bridge los ejecuta en un único daemon thread y usa `threading.Event` para sincronizar el inicio:

```python
# Correcto:
def _qemu_thread():
    lib.qemu_init(argc, argv, None)   # init + init_done.set()
    lib.qemu_main_loop()              # bloquea indefinidamente

# Incorrecto:
lib.qemu_init(...)         # en thread A
lib.qemu_main_loop()       # en thread B  ← crash: "qemu_mutex_unlock_iothread assertion failed"
```

---

### 3.4 `EspLibManager` (Python)

Archivo: `backend/app/services/esp32_lib_manager.py`

Convierte callbacks de hardware en **eventos WebSocket** para el frontend:

| Evento emitido | Datos | Cuándo |
|----------------|-------|--------|
| `system` | `{event: 'booting'│'booted'│'crash'│'reboot', ...}` | Ciclo de vida |
| `serial_output` | `{data: str, uart: 0│1│2}` | UART TX del ESP32 |
| `gpio_change` | `{pin: int, state: 0│1}` | GPIO output cambia |
| `gpio_dir` | `{pin: int, dir: 0│1}` | GPIO cambia dirección |
| `i2c_event` | `{bus, addr, event, response}` | Transacción I2C |
| `spi_event` | `{bus, event, response}` | Transacción SPI |
| `rmt_event` | `{channel, config0, value, level0, dur0, level1, dur1}` | Pulso RMT |
| `ws2812_update` | `{channel, pixels: [[r,g,b],...]}` | Frame NeoPixel completo |
| `ledc_update` | `{channel, duty, duty_pct}` | PWM duty cycle |
| `error` | `{message: str}` | Error de boot |

**Detección de crash y reboot:**
```python
# El firmware imprime en UART cuando crashea:
"Cache disabled but cached memory region accessed"  → event: crash
"Rebooting..."                                      → event: reboot
```

**API pública del manager:**
```python
manager = esp_lib_manager  # singleton

manager.start_instance(client_id, board_type, callback, firmware_b64)
manager.stop_instance(client_id)
manager.load_firmware(client_id, firmware_b64)        # hot-reload

manager.set_pin_state(client_id, gpio_num, value)     # GPIO input
manager.set_adc(client_id, channel, millivolts)
manager.set_adc_raw(client_id, channel, raw)
await manager.send_serial_bytes(client_id, data, uart_id=0)

manager.set_i2c_response(client_id, addr, byte)       # Simular dispositivo I2C
manager.set_spi_response(client_id, byte)             # Simular dispositivo SPI
await manager.poll_ledc(client_id)                    # Leer PWM (llamar periódicamente)
manager.get_status(client_id)                         # → dict con runtime state
```

---

### 3.5 `simulation.py` — Mensajes WebSocket

**Frontend → Backend (mensajes entrantes):**

| Tipo | Datos | Acción |
|------|-------|--------|
| `start_esp32` | `{board, firmware_b64?}` | Iniciar emulación |
| `stop_esp32` | `{}` | Detener |
| `load_firmware` | `{firmware_b64}` | Hot-reload firmware |
| `esp32_gpio_in` | `{pin, state}` | Drive GPIO input (GPIO real 0-39) |
| `esp32_serial_input` | `{bytes: [int], uart: 0}` | Enviar serial al ESP32 |
| `esp32_uart1_input` | `{bytes: [int]}` | UART1 RX |
| `esp32_uart2_input` | `{bytes: [int]}` | UART2 RX |
| `esp32_adc_set` | `{channel, millivolts?}` o `{channel, raw?}` | Setear ADC |
| `esp32_i2c_response` | `{addr, response}` | Configurar respuesta I2C |
| `esp32_spi_response` | `{response}` | Configurar MISO SPI |
| `esp32_status` | `{}` | Query estado runtime |

---

## 4. Firmware — Requisitos para lcgamboa

### 4.1 Versión de plataforma requerida

**✅ Usar: arduino-esp32 2.x (IDF 4.4.x)**
**❌ No usar: arduino-esp32 3.x (IDF 5.x)**

```bash
arduino-cli core install esp32:esp32@2.0.17
```

**Por qué:** El WiFi emulado de lcgamboa (core 1) desactiva la caché SPI flash periódicamente. En IDF 5.x esto provoca un crash cuando las interrupciones del core 0 intentan ejecutar código desde IROM (flash cache). En IDF 4.4.x el comportamiento de la caché es diferente y compatible.

**Mensaje de crash (IDF 5.x):**
```
Guru Meditation Error: Core  / panic'ed (Cache error).
Cache disabled but cached memory region accessed
EXCCAUSE: 0x00000007
```

### 4.2 Imagen de flash

La imagen debe ser un archivo binario completo de **4 MB** (formato merged flash):

```bash
# Compilar con DIO flash mode:
arduino-cli compile --fqbn esp32:esp32:esp32:FlashMode=dio \
  --output-dir build/ sketch/

# Crear imagen 4MB completa (¡obligatorio! QEMU requiere 2/4/8/16 MB exactos):
esptool --chip esp32 merge_bin \
  --fill-flash-size 4MB \
  -o firmware.merged.bin \
  --flash_mode dio \
  --flash_size 4MB \
  0x1000  build/sketch.ino.bootloader.bin \
  0x8000  build/sketch.ino.partitions.bin \
  0x10000 build/sketch.ino.bin
```

El backend (`arduino_cli.py`) fuerza `FlashMode=dio` automáticamente para todos los targets `esp32:*`.

### 4.3 Sketch compatible con lcgamboa (ejemplo mínimo IRAM-safe)

Para sketches que necesiten máxima compatibilidad (sin Arduino framework):

```cpp
// GPIO directo vía registros (evita código en flash en ISRs)
#define GPIO_OUT_W1TS    (*((volatile uint32_t*)0x3FF44008))
#define GPIO_OUT_W1TC    (*((volatile uint32_t*)0x3FF4400C))
#define GPIO_ENABLE_W1TS (*((volatile uint32_t*)0x3FF44020))
#define LED_BIT          (1u << 2)   // GPIO2

// Funciones ROM (siempre en IRAM, nunca crashean)
extern "C" {
    void ets_delay_us(uint32_t us);
    int  esp_rom_printf(const char* fmt, ...);
}

// Strings en DRAM (no en flash)
static const char DRAM_ATTR s_on[]  = "LED_ON\n";
static const char DRAM_ATTR s_off[] = "LED_OFF\n";

void IRAM_ATTR setup() {
    GPIO_ENABLE_W1TS = LED_BIT;
    for (int i = 0; i < 5; i++) {
        GPIO_OUT_W1TS = LED_BIT;
        esp_rom_printf(s_on);
        ets_delay_us(300000);          // 300 ms
        GPIO_OUT_W1TC = LED_BIT;
        esp_rom_printf(s_off);
        ets_delay_us(300000);
    }
}

void IRAM_ATTR loop() { ets_delay_us(1000000); }
```

**Sketches Arduino normales** (con `Serial.print`, `delay`, `digitalWrite`) también funcionan correctamente con IDF 4.4.x.

---

## 5. WiFi emulada

lcgamboa implementa una WiFi simulada con SSIDs hardcoded:

```cpp
// Solo estas redes están disponibles en la emulación:
WiFi.begin("PICSimLabWifi", "");    // sin contraseña
WiFi.begin("Espressif", "");
```

El ESP32 emulado puede:
- Escanear redes (`WiFi.scanNetworks()`) → devuelve las dos SSIDs
- Conectar y obtener IP (`192.168.4.x`)
- Abrir sockets TCP/UDP (via SLIRP — NAT hacia el host)
- Usar `HTTPClient`, `WebServer`, etc.

**Limitaciones:**
- No hay forma de configurar las SSIDs o contraseñas desde Python
- La IP del "router" virtual es `10.0.2.2` (host Windows)
- El ESP32 emulado es accesible en `localhost:PORT` via port forwarding SLIRP

---

## 6. I2C emulado

El callback I2C es **síncrono** — QEMU espera la respuesta antes de continuar:

```python
# Protocolo de eventos I2C (campo `event`):
0x0100  # START + dirección (READ si bit0 de addr=1)
0x0200  # WRITE byte (byte en bits 7:0 del event)
0x0300  # READ request (el callback debe retornar el byte a poner en SDA)
0x0000  # STOP / idle
```

**Simular un sensor I2C** (ej. temperatura):
```python
# Configurar qué byte devuelve el ESP32 cuando lee la dirección 0x48:
esp_lib_manager.set_i2c_response(client_id, addr=0x48, response_byte=75)
```

Desde WebSocket:
```json
{"type": "esp32_i2c_response", "data": {"addr": 72, "response": 75}}
```

---

## 7. RMT / NeoPixel (WS2812)

El evento RMT lleva un item de 32 bits codificado así:
```
bit31: level0  | bits[30:16]: duration0 | bit15: level1 | bits[14:0]: duration1
```

El `_RmtDecoder` acumula bits y decodifica frames WS2812 (24 bits por LED en orden GRB):

```python
# Threshold de bit: pulso alto > 48 ticks (a 80 MHz APB = ~600 ns) → bit 1
_WS2812_HIGH_THRESHOLD = 48

# Bit 1: high ~64 ticks (800 ns), low ~36 ticks (450 ns)
# Bit 0: high ~32 ticks (400 ns), low ~68 ticks (850 ns)
```

El evento emitido al frontend:
```json
{
  "type": "ws2812_update",
  "data": {
    "channel": 0,
    "pixels": [[255, 0, 0], [0, 255, 0]]
  }
}
```

---

## 8. LEDC / PWM

`qemu_picsimlab_get_internals(0)` retorna un puntero a un array de 16 `uint32_t` con el duty cycle de cada canal LEDC. Llamar periódicamente (cada ~50 ms):

```python
await esp_lib_manager.poll_ledc(client_id)
# Emite: {"type": "ledc_update", "data": {"channel": 0, "duty": 4096, "duty_pct": 50.0}}
```

El duty máximo típico es 8192 (timer de 13 bits). Para brillo de LED: `duty_pct / 100`.

---

## 9. Compilación de la DLL

### 9.1 Proceso completo (resumen)

```bash
# En MSYS2 MINGW64:
cd wokwi-libs/qemu-lcgamboa

./configure \
  --target-list=xtensa-softmmu \
  --disable-werror \
  --enable-tcg \
  --enable-gcrypt \
  --enable-slirp \
  --enable-iconv \
  --without-default-features

ninja -j$(nproc) qemu-system-xtensa.exe

# Desde bash normal (no MSYS2):
bash build_qemu_step4.sh
```

### 9.2 Detalle del relink como DLL

El proceso extrae el comando de link de `build.ninja`, elimina `softmmu_main.c.obj` (que contiene `main()`), y agrega flags de DLL:

```bash
cc -m64 -mcx16 -shared \
   -Wl,--export-all-symbols \
   -Wl,--allow-multiple-definition \
   -o libqemu-xtensa.dll \
   @dll_link.rsp      # todos los .obj excepto softmmu_main
```

### 9.3 Verificar exports

```bash
objdump -p libqemu-xtensa.dll | grep -i "qemu_picsimlab\|qemu_init\|qemu_main"
# Debe mostrar:
#   qemu_init
#   qemu_main_loop
#   qemu_cleanup
#   qemu_picsimlab_register_callbacks
#   qemu_picsimlab_set_pin
#   qemu_picsimlab_set_apin
#   qemu_picsimlab_uart_receive
#   qemu_picsimlab_get_internals
#   qemu_picsimlab_get_TIOCM
```

### 9.4 Parche requerido en scripts/symlink-install-tree.py

Windows no permite crear symlinks sin privilegios de administrador. El script de QEMU falla con `WinError 1314`. Parche aplicado:

```python
# En scripts/symlink-install-tree.py, dentro del loop de symlinks:
if os.name == 'nt':
    if not os.path.exists(source):
        continue
    import shutil
    try:
        shutil.copy2(source, bundle_dest)
    except Exception as copy_err:
        print(f'error copying {source}: {copy_err}', file=sys.stderr)
    continue
```

---

## 10. Tests

### 10.1 Test suite principal (28 tests)

Archivo: `test/esp32/test_esp32_lib_bridge.py`

```bash
python -m pytest test/esp32/test_esp32_lib_bridge.py -v
# Resultado esperado: 28 passed en ~13 segundos
```

| Grupo | Tests | Qué verifica |
|-------|-------|--------------|
| `TestDllExists` | 5 | Rutas de DLL, ROM binaries, MinGW64 |
| `TestDllLoads` | 3 | Carga de DLL, symbols exportados |
| `TestPinmap` | 3 | Estructura del pinmap, GPIO2 en slot 3 |
| `TestManagerAvailability` | 2 | `is_available()`, API surface |
| `TestEsp32LibIntegration` | 15 | QEMU real con firmware blink: boot, UART, GPIO, ADC, SPI, I2C |

### 10.2 Test integración Arduino ↔ ESP32 (13 tests)

Archivo: `test/esp32/test_arduino_esp32_integration.py`

Simula comunicación serial completa entre un Arduino Uno (emulado en Python) y el ESP32 (QEMU lcgamboa). El "Arduino" envía comandos `LED_ON`/`LED_OFF`/`PING` al ESP32 y verifica respuestas + cambios GPIO.

```bash
python -m pytest test/esp32/test_arduino_esp32_integration.py -v
# Resultado esperado: 13 passed en ~30 segundos
```

| Test | Qué verifica |
|------|-------------|
| `test_01_esp32_boots_ready` | ESP32 arranca y envía "READY" por UART |
| `test_02_ping_pong` | Arduino→"PING", ESP32→"PONG" |
| `test_03_led_on_command` | LED_ON → GPIO2=HIGH + "OK:ON" |
| `test_04_led_off_command` | LED_OFF → GPIO2=LOW + "OK:OFF" |
| `test_05_toggle_five_times` | 5 ciclos ON/OFF → ≥10 transiciones GPIO2 |
| `test_06_gpio_sequence` | Secuencia correcta: ON→OFF→ON→OFF |
| `test_07_unknown_cmd_ignored` | Comando desconocido no crashea el ESP32 |
| `test_08_rapid_commands` | 20 comandos en burst → todas las respuestas llegan |

**Firmware de test:** `test/esp32-emulator/binaries_lcgamboa/serial_led.ino.merged.bin`
Sketch fuente: `test/esp32-emulator/sketches/serial_led/serial_led.ino`

### 10.3 Omitir tests de integración (solo unitarios)

```bash
SKIP_LIB_INTEGRATION=1 python -m pytest test/esp32/ -v
```

### 10.4 Recompilar el firmware de test

Si necesitas recompilar los binarios de test:

```bash
# Blink (firmware IRAM-safe para test de GPIO):
arduino-cli compile \
  --fqbn esp32:esp32:esp32:FlashMode=dio \
  --output-dir test/esp32-emulator/out_blink \
  test/esp32-emulator/sketches/blink_lcgamboa

esptool --chip esp32 merge_bin --fill-flash-size 4MB \
  -o test/esp32-emulator/binaries_lcgamboa/blink_lcgamboa.ino.merged.bin \
  --flash_mode dio --flash_size 4MB \
  0x1000  test/esp32-emulator/out_blink/blink_lcgamboa.ino.bootloader.bin \
  0x8000  test/esp32-emulator/out_blink/blink_lcgamboa.ino.partitions.bin \
  0x10000 test/esp32-emulator/out_blink/blink_lcgamboa.ino.bin

# Serial LED (firmware para test Arduino↔ESP32):
arduino-cli compile \
  --fqbn esp32:esp32:esp32:FlashMode=dio \
  --output-dir test/esp32-emulator/out_serial_led \
  test/esp32-emulator/sketches/serial_led

esptool --chip esp32 merge_bin --fill-flash-size 4MB \
  -o test/esp32-emulator/binaries_lcgamboa/serial_led.ino.merged.bin \
  --flash_mode dio --flash_size 4MB \
  0x1000  test/esp32-emulator/out_serial_led/serial_led.ino.bootloader.bin \
  0x8000  test/esp32-emulator/out_serial_led/serial_led.ino.partitions.bin \
  0x10000 test/esp32-emulator/out_serial_led/serial_led.ino.bin
```

---

## 11. Frontend — Eventos implementados

Todos los eventos del backend están conectados al frontend:

| Evento | Componente | Estado |
|--------|-----------|--------|
| `gpio_change` | `PinManager.triggerPinChange()` → LEDs/componentes conectados | ✅ Implementado |
| `ledc_update` | `PinManager.updatePwm()` → brillo variable en `LED.tsx` | ✅ Implementado |
| `ws2812_update` | `NeoPixel.tsx` — strip de LEDs RGB con canvas | ✅ Implementado |
| `gpio_dir` | Callback `onPinDir` en `Esp32Bridge.ts` | ✅ Implementado |
| `i2c_event` | Callback `onI2cEvent` en `Esp32Bridge.ts` | ✅ Implementado |
| `spi_event` | Callback `onSpiEvent` en `Esp32Bridge.ts` | ✅ Implementado |
| `system: crash` | Banner rojo en `SimulatorCanvas.tsx` con botón Dismiss | ✅ Implementado |
| `system: reboot` | `onSystemEvent` en `Esp32Bridge.ts` | ✅ Implementado |

**Métodos de envío disponibles en `Esp32Bridge` (frontend → backend):**
```typescript
bridge.sendSerialBytes(bytes, uart?)   // Enviar datos serial al ESP32
bridge.sendPinEvent(gpioPin, state)    // Simular input externo en un GPIO
bridge.setAdc(channel, millivolts)     // Setear voltaje ADC (0-3300 mV)
bridge.setI2cResponse(addr, response)  // Respuesta de dispositivo I2C
bridge.setSpiResponse(response)        // Byte MISO de dispositivo SPI
```

**Uso del componente NeoPixel:**
```tsx
// El id debe seguir el patrón ws2812-{boardId}-{channel}
// para que el store pueda enviarle los pixels via CustomEvent
<NeoPixel
  id="ws2812-esp32-0"
  count={8}
  x={200}
  y={300}
  direction="horizontal"
/>
```

---

## 12. Limitaciones conocidas (no solucionables sin modificar QEMU)

| Limitación | Causa | Workaround |
|------------|-------|------------|
| **Una sola instancia ESP32 por proceso** | QEMU usa estado global en variables estáticas | Lanzar múltiples procesos Python |
| **WiFi solo con SSIDs hardcoded** | lcgamboa codifica "PICSimLabWifi" y "Espressif" en C | Modificar y recompilar la DLL |
| **Sin BLE / Bluetooth Classic** | No implementado en lcgamboa | No disponible |
| **Sin touch capacitivo** | `touchRead()` no tiene callback en picsimlab | No disponible |
| **Sin DAC** | GPIO25/GPIO26 analógico no expuesto por picsimlab | No disponible |
| **Flash fija en 4MB** | Hardcoded en la machine esp32-picsimlab | Recompilar DLL |
| **arduino-esp32 3.x causa crash** | IDF 5.x maneja caché diferente al WiFi emulado | Usar 2.x (IDF 4.4.x) |

---

## 13. Variables de entorno

| Variable | Valor | Efecto |
|----------|-------|--------|
| `QEMU_ESP32_LIB` | ruta a `libqemu-xtensa.dll` | Fuerza ruta de DLL (override auto-detect) |
| `QEMU_ESP32_BINARY` | ruta a `qemu-system-xtensa.exe` | Fallback subprocess (sin DLL) |
| `SKIP_LIB_INTEGRATION` | `1` | Omite tests de integración QEMU en pytest |

Si `QEMU_ESP32_LIB` no está seteado, el sistema busca `libqemu-xtensa.dll` en la misma carpeta que `esp32_lib_bridge.py` (`backend/app/services/`).

**Ejemplo arranque completo:**
```bash
# Con DLL (emulación completa GPIO + WiFi + ADC + I2C + SPI + RMT + LEDC):
cd backend && venv\Scripts\activate
uvicorn app.main:app --reload --port 8001

# Sin DLL (fallback: solo UART serial via subprocess QEMU):
QEMU_ESP32_BINARY=C:/esp-qemu/qemu/bin/qemu-system-xtensa.exe \
  uvicorn app.main:app --reload --port 8001
```
