/**
 * SensorUpdateRegistry — module-level singleton for React UI → simulation communication.
 *
 * When a sensor's attachEvents() runs it registers a callback keyed by componentId.
 * The SensorControlPanel calls dispatchSensorUpdate() to push new values into the
 * running simulation without any React/Zustand dependency in the simulation layer.
 */

type SensorValues = Record<string, number | boolean>;
type SensorUpdateCallback = (values: SensorValues) => void;

const registry = new Map<string, SensorUpdateCallback>();
const lastValues = new Map<string, SensorValues>();

/**
 * Register a callback for a component. Called from inside attachEvents().
 * The callback receives a partial values object (only changed keys).
 */
export function registerSensorUpdate(componentId: string, cb: SensorUpdateCallback): void {
  registry.set(componentId, cb);
}

/**
 * Dispatch new sensor values for a component. Called from SensorControlPanel.
 * No-ops silently if the component has no registered callback. Values are
 * also cached so the panel can rehydrate the slider when reopened on the
 * same sensor (or when switching between sensors of the same type).
 */
export function dispatchSensorUpdate(componentId: string, values: SensorValues): void {
  registry.get(componentId)?.(values);
  const prev = lastValues.get(componentId);
  lastValues.set(componentId, prev ? { ...prev, ...values } : { ...values });
}

/**
 * Read the last values dispatched for a component. Returns undefined if the
 * component has never received a dispatch. Used by SensorControlPanel to
 * restore slider state when reopened.
 */
export function getLastSensorValues(componentId: string): SensorValues | undefined {
  return lastValues.get(componentId);
}

/**
 * The callback currently registered for a component, if any.
 *
 * For wrapping rather than replacing: a part that borrows another part's
 * simulation logic lets that logic register first, then chains its own
 * behaviour in front of it. Without this the wrapper would have to replace
 * the callback and the borrowed model would stop hearing the panel.
 */
export function getSensorUpdate(componentId: string): SensorUpdateCallback | undefined {
  return registry.get(componentId);
}

/**
 * Unregister a component's callback. Called in the cleanup function returned
 * by attachEvents() so stale callbacks don't persist after simulation stops.
 * Values are also cleared so a deleted/recreated component starts fresh.
 */
export function unregisterSensorUpdate(componentId: string): void {
  registry.delete(componentId);
  lastValues.delete(componentId);
}
