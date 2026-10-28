import { describe, expect, it } from "vitest";
import { ConcurrencyGate } from "../src/concurrency.ts";

describe("request admission", () => {
  it("removes disconnected clients from the queue and preserves capacity", async () => {
    const gate = new ConcurrencyGate(1, 1);
    const release = await gate.acquire(new AbortController().signal);
    const client = new AbortController();
    const queued = gate.acquire(client.signal);
    const rejected = expect(queued).rejects.toThrow("Disconnected");
    client.abort(new Error("Disconnected"));
    await rejected;
    expect(gate.stats).toEqual({ active: 1, queued: 0 });
    const next = gate.acquire(new AbortController().signal);
    release();
    const releaseNext = await next;
    releaseNext();
    releaseNext();
    expect(gate.stats).toEqual({ active: 0, queued: 0 });
  });

  it("does not dispatch a request aborted during handoff", async () => {
    const gate = new ConcurrencyGate(1, 1);
    const release = await gate.acquire(new AbortController().signal);
    const client = new AbortController();
    let called = false;
    const result = gate.run(async () => { called = true; }, client.signal);
    const rejected = expect(result).rejects.toThrow("Disconnected");
    release();
    client.abort(new Error("Disconnected"));
    await rejected;
    expect(called).toBe(false);
    expect(gate.stats).toEqual({ active: 0, queued: 0 });
  });

  it("bounds the queue and returns a slot after a failed operation", async () => {
    const gate = new ConcurrencyGate(1, 0);
    const signal = new AbortController().signal;
    const release = await gate.acquire(signal);
    await expect(gate.acquire(signal)).rejects.toMatchObject({ code: "queue_full" });
    release();
    await expect(gate.run(async () => { throw new Error("provider failure"); }, signal)).rejects.toThrow("provider failure");
    expect(await gate.run(async () => "recovered", signal)).toBe("recovered");
    expect(gate.stats.active).toBe(0);
  });

  it("rejects invalid capacities", () => {
    expect(() => new ConcurrencyGate(0, 1)).toThrow(RangeError);
    expect(() => new ConcurrencyGate(1, -1)).toThrow(RangeError);
  });
});
