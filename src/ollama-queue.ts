// Engram Ollama Queue — Global concurrency limiter to prevent model thrashing
// v0.4: Serializes all Ollama requests to avoid concurrent model swaps on GPU

export interface QueueOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

const DEFAULT_OPTIONS: Required<QueueOptions> = {
  maxRetries: 2,
  retryDelayMs: 1000,
  timeoutMs: 120_000,
};

type QueuedTask<T> = {
  fn: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  opts: Required<QueueOptions>;
};

let queue: QueuedTask<unknown>[] = [];
let running = false;

async function processQueue(): Promise<void> {
  if (running) return;
  running = true;

  while (queue.length > 0) {
    const task = queue.shift()!;
    let lastError: unknown;

    for (let attempt = 0; attempt <= task.opts.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), task.opts.timeoutMs);

      try {
        const result = await task.fn(controller.signal);
        clearTimeout(timer);
        task.resolve(result);
        lastError = undefined;
        break;
      } catch (err) {
        clearTimeout(timer);
        lastError = err;

        const isAbort = err instanceof Error && err.name === "AbortError";
        // AbortError means timeout — do NOT retry (long inference will just timeout again)
        const isRetryable = !isAbort && (err instanceof Error && /ECONNREFUSED|ECONNRESET|503|429/.test(err.message));

        if (!isRetryable || attempt >= task.opts.maxRetries) break;

        // Exponential backoff
        const delay = task.opts.retryDelayMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    if (lastError !== undefined) {
      task.reject(lastError);
    }
  }

  running = false;
}

/**
 * Enqueue an Ollama request through the global serializer.
 * All requests run one at a time with automatic retry on transient failures.
 */
export function ollamaEnqueue<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts?: QueueOptions,
): Promise<T> {
  const mergedOpts = { ...DEFAULT_OPTIONS, ...opts };
  return new Promise<T>((resolve, reject) => {
    queue.push({ fn: fn as (signal: AbortSignal) => Promise<unknown>, resolve: resolve as (v: unknown) => void, reject, opts: mergedOpts });
    processQueue();
  });
}

/** Queue depth for diagnostics */
export function ollamaQueueDepth(): number {
  return queue.length;
}
