import { BridgeError } from "@ownai/contracts";

/** Bounded per-connection admission: at most maxActive running, at most maxQueued waiting. */
export class ConcurrencyGate {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly maxActive: number,
    private readonly maxQueued: number,
  ) {
    if (!Number.isInteger(maxActive) || maxActive < 1 || !Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new RangeError("Concurrency must be a positive integer; queue capacity must be a non-negative integer.");
    }
  }

  async run<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      signal.throwIfAborted();
      return await fn();
    } finally {
      release();
    }
  }

  get stats(): { active: number; queued: number } {
    return { active: this.active, queued: this.queue.length };
  }

  /** Resolves with a release function. Throws queue_full immediately if the queue is at capacity. */
  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw signal.reason;
    if (this.active < this.maxActive) {
      this.active++;
      return this.releaser();
    }
    if (this.queue.length >= this.maxQueued) {
      throw new BridgeError("queue_full", "This connection is busy; too many requests are waiting.", {
        generation_started: false,
      });
    }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const i = this.queue.indexOf(grant);
        if (i >= 0) this.queue.splice(i, 1);
        reject(signal.reason);
      };
      this.queue.push(grant);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next(); // Slot passes directly to the next waiter.
      else this.active--;
    };
  }
}
