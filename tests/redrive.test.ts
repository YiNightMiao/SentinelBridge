import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { redriveDeadLetter } from "../src/admin.js";
import { EventStore } from "../src/db.js";
import { validateOneBotMessageEvent } from "../src/onebot-event.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("dead-letter redrive", () => {
  let pool: pg.Pool;
  let store: EventStore;
  beforeAll(async () => { pool = new pg.Pool({ connectionString: url }); store = new EventStore(pool); await store.migrate(); });
  beforeEach(async () => { await pool.query("TRUNCATE deliveries, events CASCADE"); });
  afterAll(async () => { await pool?.end(); });
  it("redrives only dead jobs and resets attempts and lease", async () => {
    const parsed = validateOneBotMessageEvent({
      time: 1730000000, self_id: 1, post_type: "message",
      message_type: "private", sub_type: "friend", message_id: 2, user_id: 3, message: "hi",
    });
    if (!parsed.success) throw new Error("Invalid fixture");
    const inserted = await store.ingest(parsed.data);
    if (!inserted.id) throw new Error("No event ID");
    expect(await redriveDeadLetter(pool, inserted.id)).toBe(false);
    const job = await store.claim(5000);
    if (!job) throw new Error("No job");
    await store.fail(job, "HTTP 403", null);
    expect(await redriveDeadLetter(pool, inserted.id)).toBe(true);
    const res = await pool.query("SELECT status, attempts, lease_token, last_error FROM deliveries WHERE event_id = $1", [inserted.id]);
    expect(res.rows[0]).toEqual({status:"pending",attempts:0,lease_token:null,last_error:null});
  });
  it("rejects non UUID input", async () => {
    await expect(redriveDeadLetter(pool, "not-a-uuid")).rejects.toThrow("Expected a UUID");
  });
});
