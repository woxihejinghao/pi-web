import { useSyncExternalStore } from "react";

export interface Store<T> {
  get(): T;
  set(next: T): void;
  update(updater: (prev: T) => T): void;
  subscribe(listener: () => void): () => void;
}

/** Minimal observable store; mirrors dsh's React-free store primitives. */
export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  return {
    get: () => state,
    set: (next) => {
      if (Object.is(next, state)) return;
      state = next;
      notify();
    },
    update: (updater) => {
      const next = updater(state);
      if (Object.is(next, state)) return;
      state = next;
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/**
 * Subscribe to one slice of a store.
 *
 * `useStore` returns the whole state, so a write to any field re-renders the
 * component. That is what a shell wants and what a leaf reading one primitive
 * does not: this narrows the subscription to whatever `select` returns, and
 * React skips the render when it is unchanged (`Object.is`). `select` must
 * therefore return a primitive or a stable reference, never a fresh object.
 */
export function useStoreSelector<T, S>(store: Store<T>, select: (state: T) => S): S {
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.get()),
    () => select(store.get()),
  );
}

export interface Emitter<T> {
  emit(value: T): void;
  subscribe(listener: (value: T) => void): () => void;
}

/** Fire-and-forget channel for high-frequency data that must not re-render
 * the whole tree (session event streams). */
export function createEmitter<T>(): Emitter<T> {
  const listeners = new Set<(value: T) => void>();
  return {
    emit: (value) => {
      for (const listener of listeners) listener(value);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
