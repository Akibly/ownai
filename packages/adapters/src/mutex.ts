/** FIFO mutex. Waiters leave the queue if their signal aborts before they acquire. */
export class Mutex {
  private locked = false;
  private readonly waiters: Array<() => void> = [];

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(signal!.reason);
      };
      this.waiters.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.locked = false;
  }
}
