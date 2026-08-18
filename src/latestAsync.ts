export interface LatestAsyncCallbacks<T> {
  commit: (value: T) => void;
  reject?: (error: unknown) => void;
  finish?: () => void;
}

/**
 * Runs overlapping requests while allowing only the newest result to update UI
 * state. This keeps a stale host response from replacing the active host.
 */
export function createLatestAsyncRunner<T>() {
  let latestRequest = 0;

  return async (request: () => Promise<T>, callbacks: LatestAsyncCallbacks<T>): Promise<void> => {
    const requestId = ++latestRequest;
    try {
      const value = await request();
      if (requestId === latestRequest) callbacks.commit(value);
    } catch (error) {
      if (requestId === latestRequest) callbacks.reject?.(error);
    } finally {
      if (requestId === latestRequest) callbacks.finish?.();
    }
  };
}
