import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import type { OneBotMessageEvent } from "./onebot-event.js";

export type ClaimedDelivery = {
  id: string;
  event_id: string;
  lease_token: string;
  attempts: number;
  payload: OneBotMessageEvent;
};

export function eventDedupeKey(event: OneBotMessageEvent): string {
  const conversation = event.message_type === "group" ? `group:${event.group_id}` : `private:${event.user_id}`;
  return `${event.self_id}:${conversation}:${event.message_id}`;
}

export class EventStore {
  constructor(readonly pool: Pool) {}

  async migrate(): Promise<void> {
    const sql = readFileSync(new URL("../sql/001_init.sql", import.meta.url), "utf8");
    await this.pool.query(sql);
  }

  /** An event is accepted only after both event and delivery records COMMIT. */
  async ingest(event: OneBotMessageEvent): Promise<{ accepted: boolean; id: string | null }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO events (source, dedupe_key, payload)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (source, dedupe_key) DO NOTHING
         RETURNING id`,
        ["onebot-v11", eventDedupeKey(event), JSON.stringify(event)],
      );
      const id = inserted.rows[0]?.id;
      if (id) {
        await client.query("INSERT INTO deliveries (event_id) VALUES ($1)", [id]);
      }
      await client.query("COMMIT");
      return { accepted: Boolean(id), id: id ?? null };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Atomic row acquisition; lease token fences stale workers after expiry. */
  async claim(leaseMs: number): Promise<ClaimedDelivery | null> {
    const result = await this.pool.query<ClaimedDelivery>(
      `WITH picked AS (
        SELECT id FROM deliveries
        WHERE (status = 'pending' AND available_at <= NOW())
           OR (status = 'leased' AND lease_until <= NOW())
        ORDER BY available_at, id
        FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE deliveries AS d SET
         status = 'leased',
         attempts = d.attempts + 1,
         lease_until = NOW() + ($1::int * INTERVAL '1 millisecond'),
         lease_token = gen_random_uuid(),
         updated_at = NOW()
       FROM picked, events AS e
       WHERE d.id = picked.id AND e.id = d.event_id
       RETURNING d.id, d.event_id, d.lease_token, d.attempts, e.payload`,
      [leaseMs],
    );
    return result.rows[0] ?? null;
  }

  async complete(job: ClaimedDelivery): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE deliveries SET status = 'done', completed_at = NOW(),
       lease_until = NULL, lease_token = NULL, last_error = NULL, updated_at = NOW()
       WHERE id = $1 AND lease_token = $2 AND status = 'leased'`,
      [job.id, job.lease_token],
    );
    return result.rowCount === 1;
  }

  async fail(job: ClaimedDelivery, error: string, retryMs: number | null): Promise<boolean> {
    const dead = retryMs === null;
    const result = await this.pool.query(
      `UPDATE deliveries SET status = $3,
       available_at = CASE WHEN $4::int IS NULL THEN available_at
                        ELSE NOW() + ($4::int * INTERVAL '1 millisecond') END,
       lease_until = NULL, lease_token = NULL, last_error = $5, updated_at = NOW()
       WHERE id = $1 AND lease_token = $2 AND status = 'leased'`,
      [job.id, job.lease_token, dead ? "dead" : "pending", retryMs, error.slice(0, 300)],
    );
    return result.rowCount === 1;
  }
}
