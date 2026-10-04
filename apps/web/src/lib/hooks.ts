'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ApiRequestError, isAbort, toApiError } from './api';

/* ------------------------------------------------------------------ */
/* Resource loading                                                    */
/* ------------------------------------------------------------------ */

type Listener = (prefix: string) => void;
const listeners = new Set<Listener>();

/** Ask every mounted resource whose key starts with one of the prefixes to refetch quietly. */
export function invalidate(...prefixes: string[]): void {
  for (const listener of listeners) for (const prefix of prefixes) listener(prefix);
}

interface ResourceState<T> {
  key: string | null;
  data: T | undefined;
  error: ApiRequestError | null;
  loading: boolean;
  refreshing: boolean;
}

export interface Resource<T> {
  data: T | undefined;
  /** Set when the last request failed. `data` may still hold the previous good result. */
  error: ApiRequestError | null;
  /** First load for this key (no data yet). */
  loading: boolean;
  /** A background refetch is running while data is shown. */
  refreshing: boolean;
  reload: () => void;
  /** Replace the cached value locally, e.g. with a mutation's response. */
  mutate: (updater: (current: T) => T) => void;
}

/**
 * Loads `fetcher` whenever `key` changes. Pass `null` to stay idle. There is
 * deliberately no fallback data: a failed request surfaces as `error`.
 */
export function useResource<T>(
  key: string | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
  opts: { refreshMs?: number } = {},
): Resource<T> {
  const [state, setState] = useState<ResourceState<T>>({
    key,
    data: undefined,
    error: null,
    loading: key !== null,
    refreshing: false,
  });
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });
  const ctrlRef = useRef<AbortController | null>(null);
  const lastLoadedRef = useRef(0);

  const run = useCallback(
    (quiet: boolean) => {
      if (key === null) return;
      ctrlRef.current?.abort();
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      setState((prev) =>
        prev.key === key && prev.data !== undefined
          ? { ...prev, loading: false, refreshing: true }
          : { key, data: undefined, error: null, loading: true, refreshing: false },
      );
      fetcherRef.current(ctrl.signal).then(
        (data) => {
          if (ctrl.signal.aborted) return;
          lastLoadedRef.current = Date.now();
          setState({ key, data, error: null, loading: false, refreshing: false });
        },
        (err: unknown) => {
          if (ctrl.signal.aborted || isAbort(err)) return;
          setState((prev) => ({
            key,
            // Keep what was on screen only for background refreshes of the same key.
            data: quiet && prev.key === key ? prev.data : undefined,
            error: toApiError(err),
            loading: false,
            refreshing: false,
          }));
        },
      );
    },
    [key],
  );

  useEffect(() => {
    run(false);
    return () => ctrlRef.current?.abort();
  }, [run]);

  useEffect(() => {
    if (key === null) return;
    const listener: Listener = (prefix) => {
      if (key.startsWith(prefix)) run(true);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [key, run]);

  const refreshMs = opts.refreshMs;
  useEffect(() => {
    if (key === null || !refreshMs) return;
    const tick = () => {
      if (document.visibilityState === 'visible') run(true);
    };
    const interval = setInterval(tick, refreshMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastLoadedRef.current > refreshMs / 2) run(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key, refreshMs, run]);

  const reload = useCallback(() => run(true), [run]);
  const mutate = useCallback(
    (updater: (current: T) => T) => {
      setState((prev) =>
        prev.key === key && prev.data !== undefined ? { ...prev, data: updater(prev.data) } : prev,
      );
    },
    [key],
  );

  // A key change is visible one render before the effect runs; never show the old key's data.
  if (state.key !== key) {
    return { data: undefined, error: null, loading: key !== null, refreshing: false, reload, mutate };
  }
  return {
    data: state.data,
    error: state.error,
    loading: state.loading,
    refreshing: state.refreshing,
    reload,
    mutate,
  };
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Re-renders on an interval so relative times and the "now" line stay current. */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Calls `onAway` for pointer presses outside `ref` and for Escape, while `active`. */
export function useDismiss(
  ref: React.RefObject<HTMLElement | null>,
  active: boolean,
  onAway: () => void,
): void {
  const handler = useRef(onAway);
  useEffect(() => {
    handler.current = onAway;
  });
  useEffect(() => {
    if (!active) return;
    const onPointer = (event: PointerEvent) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) handler.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Close only this layer: without preventDefault an enclosing <dialog> would close too.
        event.preventDefault();
        event.stopPropagation();
        handler.current();
      }
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [active, ref]);
}

/* ------------------------------------------------------------------ */
/* Hash routing                                                        */
/* ------------------------------------------------------------------ */

export interface Route {
  view: string;
  /** Path segments after the view, already decoded. */
  args: string[];
}

function parseHash(hash: string): Route {
  const parts = hash
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  return { view: parts[0] ?? '', args: parts.slice(1) };
}

function subscribeHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

export function routePath(view: string, ...args: Array<string | null | undefined>): string {
  const rest = args.filter((arg): arg is string => Boolean(arg)).map(encodeURIComponent);
  return `#/${[view, ...rest].join('/')}`;
}

export function useHashRoute(): { route: Route; navigate: (path: string, replace?: boolean) => void } {
  const hash = useSyncExternalStore(
    subscribeHash,
    () => window.location.hash,
    () => '',
  );
  const navigate = useCallback((path: string, replace = false) => {
    if (window.location.hash === path) return;
    if (replace) {
      window.history.replaceState(null, '', path);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } else {
      window.location.hash = path;
    }
  }, []);
  const route = useMemo(() => parseHash(hash), [hash]);
  return { route, navigate };
}
