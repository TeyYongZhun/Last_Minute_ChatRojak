const listeners = new Map();

export function subscribe(event, handler) {
  if (!listeners.has(event)) {
    listeners.set(event, []);
  }
  listeners.get(event).push(handler);
}

export function emit(event, payload) {
  console.log(`🔔 [${event}]`, payload);

  const handlers = listeners.get(event) || [];
  for (const h of handlers) {
    try {
      h(payload);
    } catch (err) {
      console.error("Notifier handler error:", err.message);
    }
  }
}