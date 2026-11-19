import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DeliveryWorker, retryDelayMs, shouldDeadLetter } from "../src/worker.js";
import { Metrics } from "../src/metrics.js";
import type { EventStore, ClaimedDelivery } from "../src/db.js";

const job: ClaimedDelivery = {
  id: "job-1", event_id: "event-1", lease_token: "lease-1", attempts: 1,
  payload: {
    time: 1730000000, self_id: 1, post_type: "message", message_type: "private",
    sub_type: "friend", user_id: 2, message_id: 3, message: "test",
  },
};

function setup(response: Response | Error, secret = "test-secret") {
  let completed = 0;
  let failure: { reason: string; retry: number | null } | null = null;
  let sentBody = "";
  let sentHeaders: Record<string, string> = {};
  const store = {
    claim: async () => job,
    complete: async () => { completed++; return true; },
    fail: async (_job: ClaimedDelivery, reason: string, retry: number | null) => {
      failure = { reason, retry }; return true;
    },
  } as unknown as EventStore;
  const worker = new DeliveryWorker(store, new Metrics(), {
    webhookUrl: "http://localhost:9999/events",
    webhookSecret: secret, webhookTimeoutMs: 1000, leaseMs: 5000, maxAttempts: 3,
    fetcher: async (_url, init) => {
      sentBody = String(init?.body);
      sentHeaders = init?.headers as Record<string, string>;
      if (response instanceof Error) throw response;
      return response;
    },
  });
  return { worker, snapshot: () => ({ completed, failure, sentBody, sentHeaders }) };
}

describe("leased delivery worker", () => {
  it("uses a stable idempotency key, signs payload and marks a 2xx delivery complete", async () => {
    const t = setup(new Response("ok", { status: 202 }));
    expect(await t.worker.processNext()).toBe(true);
    const s = t.snapshot();
    expect(s.completed).toBe(1);
    expect(s.failure).toBeNull();
    expect(s.sentHeaders["x-sentinelbridge-idempotency-key"]).toBe(job.event_id);
    expect(s.sentHeaders["x-sentinelbridge-signature"]).toBe("sha256=" + createHmac("sha256", "test-secret").update(s.sentBody).digest("hex"));
    expect(JSON.parse(s.sentBody).event.message_id).toBe(3);
  });

  it("retries retriable HTTP failures", async () => {
    const t = setup(new Response("busy", { status: 503 }));
    await t.worker.processNext();
    expect(t.snapshot().completed).toBe(0);
    expect(t.snapshot().failure).toMatchObject({ reason: "HTTP 503" });
    expect(t.snapshot().failure?.retry).toBeGreaterThan(0);
  });

  it("dead-letters permanent client errors", async () => {
    const t = setup(new Response("forbidden", { status: 403 }));
    await t.worker.processNext();
    expect(t.snapshot().failure).toEqual({ reason: "HTTP 403", retry: null });
  });

  it("retries transport failures without leaking error details", async () => {
    const t = setup(new Error("secret-error"));
    await t.worker.processNext();
    expect(t.snapshot().failure?.reason).toBe("Webhook request failed");
  });

  it("bounds retry delay and recognizes retryable statuses", () => {
    expect(retryDelayMs(1, () => 0.5)).toBe(1000);
    expect(retryDelayMs(50, () => 0.5)).toBe(60000);
    expect(shouldDeadLetter(429)).toBe(false);
    expect(shouldDeadLetter(408)).toBe(false);
    expect(shouldDeadLetter(401)).toBe(true);
    expect(shouldDeadLetter(500)).toBe(false);
  });
});
