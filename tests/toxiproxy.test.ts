import { createServer } from "node:net";
import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { OneBotSource } from "../src/source.js";
import { Metrics } from "../src/metrics.js";
import type { EventStore } from "../src/db.js";

const api = process.env.TOXIPROXY_API_URL;
const event = {
  time: 1730000000, self_id: 123, post_type: "message",
  message_type: "private", sub_type: "friend",
  user_id: 456, message_id: 789, message: "test event",
};

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 15000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for an observable state");
}

async function unusedPort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const address = s.address();
  if (!address || typeof address === "string") throw new Error("No TCP port");
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return address.port;
}

async function apiRequest(path: string, method: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`Toxiproxy ${method} ${path} returned ${res.status}`);
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) as unknown : null;
}

describe.skipIf(!api)("deterministic Toxiproxy half-open connection", () => {
  it("detects a network blackhole using heartbeat, then reconnects after recovery", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(wss, "listening");
    const upstream = wss.address();
    if (!upstream || typeof upstream === "string") throw new Error("Missing ws port");
    const proxyPort = await unusedPort();
    const proxyName = `sentinel_${process.pid}_${proxyPort}`;
    const sessions: WebSocket[] = [];
    wss.on("connection", (ws) => sessions.push(ws));
    let persisted = 0;
    const store = { ingest: async () => { persisted++; return { accepted: true, id: "fake" }; } } as unknown as EventStore;
    const metrics = new Metrics();
    let source: OneBotSource | undefined;
    let created = false;
    try {
      await apiRequest("/proxies", "POST", {
        name: proxyName, listen: `127.0.0.1:${proxyPort}`,
        upstream: `127.0.0.1:${upstream.port}`,
      });
      created = true;
      source = new OneBotSource({
        url: `ws://127.0.0.1:${proxyPort}`,
        heartbeatMs: 200, reconnectBaseMs: 100, maxPayloadBytes: 1048576,
      }, store, metrics);
      source.start();
      await until(() => sessions.length >= 1 && sessions[0]?.readyState === WebSocket.OPEN);
      sessions[0]?.send(JSON.stringify(event));
      await until(() => persisted === 1);

      // Inject only after durable ingest is observed. Blackhole both directions.
      for (const stream of ["upstream", "downstream"]) {
        await apiRequest(`/proxies/${proxyName}/toxics`, "POST", {
          name: `blackhole_${stream}`, type: "timeout", stream,
          toxicity: 1, attributes: { timeout: 0 },
        });
      }
      const configured = await apiRequest(`/proxies/${proxyName}`, "GET") as { toxics?: { name: string }[] };
      expect(configured.toxics?.filter((t) => t.name.startsWith("blackhole_"))).toHaveLength(2);
      // Not a fixed sleep: wait for the heartbeat to kill the half-open stream.
      await until(() => sessions[0]?.readyState === WebSocket.CLOSED);

      for (const stream of ["upstream", "downstream"]) {
        await apiRequest(`/proxies/${proxyName}/toxics/blackhole_${stream}`, "DELETE");
      }
      await until(() => sessions.length >= 2 && sessions.at(-1)?.readyState === WebSocket.OPEN);
      sessions.at(-1)?.send(JSON.stringify({ ...event, message_id: 790 }));
      await until(() => persisted === 2);
      expect(metrics.render()).toContain("sentinel_ingested_total 2");
    } finally {
      await source?.stop();
      if (created) await apiRequest(`/proxies/${proxyName}`, "DELETE").catch(() => {});
      sessions.forEach((s) => s.terminate());
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  }, 25000);
});
