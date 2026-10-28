import { describe, expect, it } from "vitest";
import { Redactor } from "../src/redact.ts";
import { chatRequest, makeHarness, mockAdapterFor, recordOf } from "./helpers.ts";

/** T14: a secret that appears inside a provider error must not reach the client or a log. */
describe("redaction", () => {
  it("T14: an upstream failure carrying a canary session token is scrubbed", async () => {
    const harness = await makeHarness();
    const adapter = await mockAdapterFor(harness, recordOf(harness, "mock"));
    const canary = "claude-session-DnQ2Xr7vB9zK4mLpS8tYwE1u";
    adapter.errorLeak = `Set-Cookie: ${canary}; Authorization: Bearer ${harness.key}`;
    adapter.failWith = "provider_error";

    const res = await harness.post(chatRequest("mock"));
    expect(res.statusCode).toBe(502);
    expect(res.payload).not.toContain(canary);
    expect(res.payload).not.toContain(harness.key);
    expect(res.body.error.message).toContain("[redacted]");
    await harness.app.close();
  });

  it("known secrets are replaced even when they appear inside a longer string", () => {
    const redactor = new Redactor(["sk-local-abcdefghij0123456789"]);
    const out = redactor.redact("header was sk-local-abcdefghij0123456789 found at C:/users/x/.bridge-data");
    expect(out).not.toContain("sk-local-abcdefghij0123456789");
    expect(out).toContain("[redacted]");
  });

  it("scrubs a gateway key by shape, including one minted under the old prefix", () => {
    for (const prefix of ["sk-ownai-", "sk-local-"]) {
      const key = `${prefix}abcdefghij0123456789ABCDEFGH`;
      expect(new Redactor().redact(`rejected the key ${key} at the gateway`)).not.toContain(key);
    }
  });

  it("cookie and bearer assignments are stripped whether or not the value was registered", () => {
    const out = new Redactor().redact("failed with Cookie: mc_session=Zx9Kp3mQ7vB2nR5tY8wL1cF4 and api_key: A1B2C3D4E5F6G7H8I9J0K2L4");
    expect(out).not.toContain("Zx9Kp3mQ7vB2nR5tY8wL1cF4");
    expect(out.toLowerCase()).not.toContain("a1b2c3d4e5f6g7h8i9j0k2l4");
  });

  it("collapses newlines and caps length so a page dump cannot ride along", () => {
    const out = new Redactor().redact(`line one\n${"x".repeat(2000)}`);
    expect(out).not.toContain("\n");
    expect(out.length).toBeLessThanOrEqual(401);
  });

  it("never returns an empty message", () => {
    expect(new Redactor().redact(undefined)).toBe("No further detail available.");
  });
});
