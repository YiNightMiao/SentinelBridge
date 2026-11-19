import { describe, expect, it } from "vitest";
import { eventDedupeKey } from "../src/db.js";
import { validateOneBotEvent } from "../src/onebot-event.js";

describe("OneBot v11 event family handling", () => {
  it("accepts a notice and preserves vendor extensions", () => {
    const parsed = validateOneBotEvent({
      time: 1730000000, self_id: 1, post_type: "notice", notice_type: "group_increase",
      user_id: 2, group_id: 3, extra: { name: "value" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.post_type).toBe("notice");
      expect(parsed.data.extra).toEqual({ name: "value" });
    }
  });
  it("accepts request and uses request flag as a stable key", () => {
    const parsed = validateOneBotEvent({
      time: 1730000000, self_id: 1, post_type: "request", request_type: "friend",
      user_id: 4, flag: "abc123",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(eventDedupeKey(parsed.data)).toBe(eventDedupeKey(parsed.data));
    }
  });
  it("accepts meta events without incorrectly deduplicating unkeyed heartbeat events", () => {
    const parsed = validateOneBotEvent({
      time: 1730000000, self_id: 1, post_type: "meta_event",
      meta_event_type: "heartbeat", status: {}, interval: 5000,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(eventDedupeKey(parsed.data)).not.toBe(eventDedupeKey(parsed.data));
    }
  });
  it("rejects malformed routing fields", () => {
    expect(validateOneBotEvent({ time: 0, self_id: 1, post_type: "notice" }).success).toBe(false);
    expect(validateOneBotEvent({ time: 0, self_id: 1, post_type: "request", request_type: "friend" }).success).toBe(false);
    expect(validateOneBotEvent({ time: 0, self_id: 1, post_type: "unknown" }).success).toBe(false);
  });
});
