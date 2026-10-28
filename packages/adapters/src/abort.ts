import { BridgeError } from "@ownai/contracts";

/** Converts an aborted signal into the matching BridgeError (timeout vs client cancellation). */
export function abortError(signal: AbortSignal, generationStarted: boolean): BridgeError {
  const reason: unknown = signal.reason;
  if (reason instanceof BridgeError) return reason;
  if (reason instanceof DOMException && reason.name === "TimeoutError") {
    return new BridgeError("timeout", "The request exceeded its deadline.", { generation_started: generationStarted });
  }
  return new BridgeError("cancelled", "The request was cancelled.", { generation_started: generationStarted });
}

export function throwIfAborted(signal: AbortSignal, generationStarted: boolean): void {
  if (signal.aborted) throw abortError(signal, generationStarted);
}

/** Resolves after `ms`, rejecting early if the signal aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
