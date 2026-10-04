/**
 * A typed event emitter shared by `SyncWorker` and `SyncIdbClient`, so both
 * expose the same `on(event, callback) => unsubscribe` shape from one
 * implementation.
 */

export interface Emitter<EventMap> {
  /** Calls every listener registered for `event`, in subscription order. */
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void;
  /** Registers a listener. Returns a function that removes it. */
  on<K extends keyof EventMap>(event: K, callback: (payload: EventMap[K]) => void): () => void;
}

export function createEmitter<EventMap>(): Emitter<EventMap> {
  const listeners = new Map<keyof EventMap, Set<(payload: never) => void>>();

  return {
    emit(event, payload) {
      for (const callback of listeners.get(event) ?? []) callback(payload as never);
    },
    on(event, callback) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(callback);
      return () => set.delete(callback);
    },
  };
}
