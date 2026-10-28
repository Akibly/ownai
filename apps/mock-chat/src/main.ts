import { startMockChat } from "./server.ts";

const port = Number(process.env.MOCK_CHAT_PORT ?? 8790);
const server = await startMockChat({ port });
console.log(`Mock Chat test site listening on ${server.url} (loopback only)`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void server.close().then(() => process.exit(0)));
}
