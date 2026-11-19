import pg from "pg";
import { loadConfig } from "./config.js";
import { EventStore } from "./db.js";
import { Metrics } from "./metrics.js";
import { createHttpApp } from "./http.js";
import { OneBotSource } from "./source.js";
import { DeliveryWorker } from "./worker.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: Math.max(4, config.WORKERS + 2),
    connectionTimeoutMillis: 5000,
  });
  const store = new EventStore(pool);
  const metrics = new Metrics();
  const workers = new AbortController();
  let shuttingDown = false;
  let source: OneBotSource | undefined;
  const app = createHttpApp(pool, metrics);
  try {
    await store.migrate();
    await app.listen({ host: config.HOST, port: config.PORT });
    const runs = Array.from({ length: config.WORKERS }, () =>
      new DeliveryWorker(store, metrics, {
        webhookUrl: config.WEBHOOK_URL,
        webhookSecret: config.WEBHOOK_SECRET,
        webhookTimeoutMs: config.WEBHOOK_TIMEOUT_MS,
        leaseMs: config.LEASE_MS,
        maxAttempts: config.MAX_ATTEMPTS,
      }).run(workers.signal),
    );
    source = new OneBotSource({
      url: config.ONEBOT_WS_URL,
      heartbeatMs: config.HEARTBEAT_MS,
      maxPayloadBytes: config.MAX_PAYLOAD_BYTES,
    }, store, metrics);
    source.start();
    console.info("SentinelBridge started");

    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      workers.abort();
      await source?.stop();
      await Promise.allSettled(runs);
      await app.close();
      await pool.end();
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => { void shutdown().catch(() => { process.exitCode = 1; }); });
    }
  } catch (error) {
    workers.abort();
    await source?.stop();
    await app.close();
    await pool.end();
    throw error;
  }
}
main().catch(() => {
  console.error("SentinelBridge failed to start; inspect configuration and database availability");
  process.exitCode = 1;
});
