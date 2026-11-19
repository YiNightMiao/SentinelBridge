import { createServer } from "node:http";
import { once } from "node:events";
import pg from "pg";
import { WebSocketServer } from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventStore } from "../src/db.js";
import { Metrics } from "../src/metrics.js";
import { OneBotSource } from "../src/source.js";
import { DeliveryWorker } from "../src/worker.js";
import { createHttpApp } from "../src/http.js";
import { validateOneBotMessageEvent } from "../src/onebot-event.js";

const URL = process.env.TEST_DATABASE_URL;
const sample = {
  time: 1730000000, self_id: 123, post_type: "message" as const,
  message_type: "private" as const, sub_type: "friend",
  user_id: 456, message_id: 789, message: "hello",
};
const event = (() => {
  const parsed = validateOneBotMessageEvent(sample);
  if (!parsed.success) throw new Error("Invalid test fixture");
  return parsed.data;
})();

async function until(predicate: () => Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for observable state");
}

describe.skipIf(!URL)("PostgreSQL/WebSocket/webhook integration", () => {
  let pool: pg.Pool;
  let store: EventStore;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: URL });
    store = new EventStore(pool);
    await store.migrate();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE deliveries, events CASCADE");
  });
  afterAll(async () => { await pool?.end(); });

  it("atomically persists one logical event despite concurrent duplicates", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => store.ingest(event)));
    expect(results.filter((x) => x.accepted)).toHaveLength(1);
    const rows = await pool.query("SELECT (SELECT COUNT(*) FROM events)::int AS events, (SELECT COUNT(*) FROM deliveries)::int AS jobs");
    expect(rows.rows[0]).toEqual({ events: 1, jobs: 1 });
  });

  it("concurrent SKIP LOCKED claims cannot lease the same job", async () => {
    const first = await store.ingest(event);
    expect(first.accepted).toBe(true);
    const claims = await Promise.all(Array.from({ length: 8 }, () => store.claim(5000)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claimed = claims.find(Boolean);
    expect(claimed).toBeTruthy();
    if (claimed) {
      expect(await store.complete(claimed)).toBe(true);
      expect(await store.complete(claimed)).toBe(false);
    }
  });

  it("expires leases and fences stale workers", async () => {
    await store.ingest(event);
    const stale = await store.claim(5000);
    expect(stale).not.toBeNull();
    await pool.query("UPDATE deliveries SET lease_until = NOW() - INTERVAL '1 second' WHERE id = $1", [stale?.id]);
    const fresh = await store.claim(5000);
    expect(fresh?.id).toBe(stale?.id);
    expect(fresh?.lease_token).not.toBe(stale?.lease_token);
    if (stale && fresh) {
      expect(await store.complete(stale)).toBe(false);
      expect(await store.complete(fresh)).toBe(true);
    }
  });

  it("retries persisted jobs and marks successful webhook deliveries done", async () => {
    await store.ingest(event);
    let sends = 0;
    const server = createServer(async (req, res) => {
      sends++;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      expect(payload.event.message_id).toBe(789);
      expect(req.headers["x-sentinelbridge-idempotency-key"]).toBeTruthy();
      res.writeHead(sends === 1 ? 503 : 204).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No port");
      const worker = new DeliveryWorker(store, new Metrics(), {
        webhookUrl: `http://127.0.0.1:${address.port}/events`,
        webhookSecret: "local-test-secret", webhookTimeoutMs: 1000, leaseMs: 5000, maxAttempts: 3,
      });
      expect(await worker.processNext()).toBe(true);
      const afterFailure = await pool.query("SELECT status FROM deliveries");
      expect(afterFailure.rows[0].status).toBe("pending");
      // Fast-forward database retry clock; no arbitrary sleep.
      await pool.query("UPDATE deliveries SET available_at=NOW() - INTERVAL '1 second'");
      expect(await worker.processNext()).toBe(true);
      const final = await pool.query("SELECT status, attempts FROM deliveries");
      expect(final.rows[0]).toEqual({ status: "done", attempts: 2 });
      expect(sends).toBe(2);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("ingests valid WebSocket events, rejects malformed input and keeps the connection alive", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(wss, "listening");
    const addr = wss.address();
    if (!addr || typeof addr === "string") throw new Error("No port");
    const connected = new Promise<import("ws").WebSocket>((resolve) => wss.once("connection", resolve));
    const metrics = new Metrics();
    const source = new OneBotSource({
      url: `ws://127.0.0.1:${addr.port}`, heartbeatMs: 1000, maxPayloadBytes: 1048576,
    }, store, metrics);
    try {
      source.start();
      const client = await connected;
      client.send("{broken");
      client.send(JSON.stringify(event));
      client.send(JSON.stringify(event));
      await until(async () => Number((await pool.query("SELECT COUNT(*) AS total FROM events")).rows[0].total) === 1);
      await until(async () => metrics.render().includes("sentinel_duplicates_total 1"));
      expect(metrics.render()).toContain("sentinel_invalid_total 1");
      const http = createHttpApp(pool, metrics);
      try {
        expect((await http.inject("/health")).statusCode).toBe(200);
        expect((await http.inject("/ready")).statusCode).toBe(200);
        expect((await http.inject("/metrics")).body).toContain("sentinel_ingested_total 1");
      } finally {
        await http.close();
      }
    } finally {
      await source.stop();
      await new Promise<void>((resolve, reject) => wss.close((e) => e ? reject(e) : resolve()));
    }
  });
});
