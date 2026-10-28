import { BridgeStore } from "../apps/bridge/src/stores/store.ts";
import { MemorySecretStore } from "../apps/bridge/src/secrets.ts";
import { createRuntime } from "../apps/bridge/src/runtime.ts";
import { startBridge } from "../apps/bridge/src/server.ts";

// Isolated development preview: no persisted configuration or provider accounts.
const store = BridgeStore.inMemory();
const runtime = createRuntime({ store, secrets: new MemorySecretStore() });
const key = await runtime.ensureGatewayKey();
const running = await startBridge({
  store, registry: runtime.registry, router: runtime.router,
  port: Number(process.env.PREVIEW_PORT ?? 8792),
  revealGatewayKey: async () => key.plaintext,
});
console.log(`Console preview: ${running.url}/console (in-memory only; provider setup is disabled)`);
async function close() {
  await running.close();
  await runtime.close();
  process.exit(0);
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
