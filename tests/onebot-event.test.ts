import { describe, expect, it } from "vitest";
import { validateOneBotMessageEvent } from "../src/onebot-event.ts";

const privateMessage = {
  time: 1730000000,
  self_id: 12345,
  post_type: "message",
  message_type: "private",
  sub_type: "friend",
  message_id: 42,
  user_id: 67890,
  message: "Hello",
};

describe("OneBot v11 message event validation", () => {
  it("accepts a valid private message", () => {
    const result = validateOneBotMessageEvent(privateMessage);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.message_type).toBe("private");
  });

  it("accepts a group message with CQ segments", () => {
    const result = validateOneBotMessageEvent({
      ...privateMessage,
      message_type: "group",
      sub_type: "normal",
      group_id: 98765,
      message: [{ type: "text", data: { text: "hello" } }],
    });
    expect(result.success).toBe(true);
  });

  it("requires group_id on group messages", () => {
    const result = validateOneBotMessageEvent({
      ...privateMessage,
      message_type: "group",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid identifier types", () => {
    const result = validateOneBotMessageEvent({
      ...privateMessage,
      user_id: "67890",
    });
    expect(result.success).toBe(false);
  });

  it("does not silently coerce missing required fields", () => {
    const { message_id: _ignored, ...withoutMessageId } = privateMessage;
    expect(validateOneBotMessageEvent(withoutMessageId).success).toBe(false);
  });

  it("allows extra fields for protocol extensions", () => {
    const result = validateOneBotMessageEvent({
      ...privateMessage,
      source_extension: { trace_id: "dev-1" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source_extension).toEqual({ trace_id: "dev-1" });
    }
  });

  it("rejects unsupported non-message events rather than guessing their shape", () => {
    expect(validateOneBotMessageEvent({ ...privateMessage, post_type: "notice" }).success).toBe(false);
  });
});
