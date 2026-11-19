import pg from "pg";
import { loadConfig } from "./config.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export async function redriveDeadLetter(pool: pg.Pool, eventId: string): Promise<boolean> {
  if (!UUID.test(eventId)) throw new Error("Expected a UUID event ID");
  const result = await pool.query(
    `UPDATE deliveries SET status = 'pending', attempts = 0, available_at = NOW(),
     lease_until = NULL, lease_token = NULL, last_error = NULL, completed_at = NULL,
     updated_at = NOW() WHERE event_id = $1::uuid AND status = 'dead'`,
    [eventId],
  );
  return result.rowCount === 1;
}

async function main(): Promise<void> {
  const eventId = process.argv[2];
  if (!eventId || process.argv.length !== 3 || !UUID.test(eventId)) {
    console.error("Usage: pnpm redrive <dead-letter-event-uuid>");
    process.exitCode = 2;
    return;
  }
  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
  try {
    const changed = await redriveDeadLetter(pool, eventId);
    console.log(changed ? "Dead-letter event queued for retry" : "No matching dead-letter event");
    if (!changed) process.exitCode = 1;
  } finally { await pool.end(); }
}

if (process.argv[1]?.endsWith("/admin.js")) {
  void main().catch(() => {
    console.error("Redrive failed; check database configuration and permissions");
    process.exitCode = 1;
  });
}
