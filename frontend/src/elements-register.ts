/**
 * Side-effect module: register every custom element (upstream wokwi +
 * velxio-local) without pulling in any React component. Import this when you
 * need `document.createElement('wokwi-…')` to resolve — e.g. pin-metadata
 * introspection in tests/generators — but don't want DynamicComponent's
 * store/simulation dependency graph.
 */

import '@wokwi/elements';
import './velxio-elements';

// Element classes that live next to their React wrappers instead of in
// velxio-elements/ (each module self-registers its tags, guarded against
// double-registration and non-DOM environments).
import './components/velxio-components/Attiny85Element';
import './components/velxio-components/Bmp280Element';
import './components/velxio-components/DiodeElements';
import './components/velxio-components/Ds3231Element';
import './components/velxio-components/EPaperElement';
import './components/velxio-components/Esp32Element';
import './components/velxio-components/FlipFlopElements';
import './components/velxio-components/GpsNeo6mElement';
import './components/velxio-components/IC74HC595';
import './components/velxio-components/LogicGateElements';
import './components/velxio-components/LogicICElements';
import './components/velxio-components/MotorDriverElements';
import './components/velxio-components/OpAmpElements';
import './components/velxio-components/PiPicoWElement';
import './components/velxio-components/PowerElements';
import './components/velxio-components/RaspberryPi3Element';
import './components/velxio-components/RaspberryPi4Element';
import './components/velxio-components/RaspberryPi5Element';
import './components/velxio-components/RelayElements';
import './components/velxio-components/Ssd1306I2cElement';
import './components/velxio-components/Stm32BluePillElement';
import './components/velxio-components/TransistorElements';
