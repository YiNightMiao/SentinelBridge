import { createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { EventStore, ClaimedDelivery } from "./db.js";
import type { Metrics } from "./metrics.js";

export type WorkerOptions = {
  webhookUrl: string;
  webhookSecret: string;
  webhookTimeoutMs: number;
  leaseMs: number;
  maxAttempts: number;
  fetcher?: typeof fetch;
};

export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(60000, 1000 * 2 ** Math.min(10, Math.max(0, attempt - 1)));
  return Math.round(base * (0.9 + 0.2 * random()));
}

export function shouldDeadLetter(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export class DeliveryWorker {
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly store: EventStore,
    private readonly metrics: Metrics,
    private readonly options: WorkerOptions,
  ) {
    this.fetcher = options.fetcher ?? fetch;
    if (options.leaseMs <= options.webhookTimeoutMs + 1000) {
      throw new Error("Lease must exceed webhook timeout by at least 1000ms");
    }
  }

  /** Runs at most one job. Returns false when there is no available work. */
  async processNext(): Promise<boolean> {
    const job = await this.store.claim(this.options.leaseMs);
    if (!job) return false;
    await this.deliver(job);
    return true;
  }

  private async deliver(job: ClaimedDelivery): Promise<void> {
    const body = JSON.stringify({
      schemaVersion: 1, eventId: job.event_id, source: "onebot-v11",
      event: job.payload,
    });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-sentinelbridge-idempotency-key": job.event_id,
    };
    if (this.options.webhookSecret) {
      headers["x-sentinelbridge-signature"] =
        "sha256=" + createHmac("sha256", this.options.webhookSecret).update(body).digest("hex");
    }
    let errorMessage = "Webhook request failed";
    let permanent = false;
    try {
      const response = await this.fetcher(this.options.webhookUrl, {
        method: "POST", headers, body,
        signal: AbortSignal.timeout(this.options.webhookTimeoutMs),
      });
      if (response.ok) {
        if (await this.store.complete(job)) this.metrics.increment("sentinel_delivery_success_total");
        return;
      }
      errorMessage = `HTTP ${response.status}`;
      permanent = shouldDeadLetter(response.status);
    } catch {
      // Log no URLs, payloads, or secrets. Timeout/network errors are retried.
    }
    const isDead = permanent || job.attempts >= this.options.maxAttempts;
    const updated = await this.store.fail(job, errorMessage, isDead ? null : retryDelayMs(job.attempts));
    if (updated) this.metrics.increment(isDead ? "sentinel_delivery_dead_total" : "sentinel_delivery_retry_total");
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const worked = await this.processNext();
        if (!worked) await delay(250, undefined, { signal });
      } catch {
        if (signal.aborted) return;
        console.error("Delivery worker failure (details redacted)");
        try { await delay(1000, undefined, { signal }); } catch { return; }
      }
    }
  }
}
