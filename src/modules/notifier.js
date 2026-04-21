const subs = [];

export function subscribe(fn) {
  subs.push(fn);
}

export function emit(kind, payload) {
  for (const fn of subs) {
    try {
      fn(kind, payload);
    } catch (e) {
      console.error('[notifier]', e);
    }
  }
}
