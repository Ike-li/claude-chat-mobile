import { createRingBuffer } from '../ring-buffer.js';

export function createClientLogger(context, { capacity = 200, onEntry = null } = {}) {
  const buffer = createRingBuffer(capacity);
  const now = context.dependencies.now || Date.now;

  function log(type, text) {
    const entry = {
      ts: now(),
      type: `client_${type}`,
      text,
      instanceId: context.state.viewingInstanceId ?? null,
    };
    if ((type === 'send' || type === 'recv') && context.state.currentModel) {
      entry.model = context.state.currentModel;
    }
    buffer.push(entry);
    onEntry?.(entry);
    return entry;
  }

  return {
    log,
    entries: () => buffer.toArray(),
    size: () => buffer.size(),
    clear: () => buffer.clear(),
  };
}
