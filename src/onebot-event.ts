import { z } from "zod";

// Day 1 scope: OneBot v11 *message* events, not every OneBot event variant.
// Preserve optional vendor fields without manufacturing missing required fields.
const nonnegativeId = z.number().int().nonnegative();

const messageSegment = z.object({
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
}).passthrough();

const baseMessageFields = {
  time: z.number().int().nonnegative(),
  self_id: nonnegativeId,
  post_type: z.literal("message"),
  sub_type: z.string().min(1),
  message_id: z.number().int(),
  user_id: nonnegativeId,
  message: z.union([z.string(), z.array(messageSegment)]),
};

export const oneBotMessageEventSchema = z.discriminatedUnion("message_type", [
  z.object({
    ...baseMessageFields,
    message_type: z.literal("private"),
  }).passthrough(),
  z.object({
    ...baseMessageFields,
    message_type: z.literal("group"),
    group_id: nonnegativeId,
  }).passthrough(),
]);

export type OneBotMessageEvent = z.infer<typeof oneBotMessageEventSchema>;

// safeParse returns structured issues without throwing on malformed input.
export function validateOneBotMessageEvent(input: unknown) {
  return oneBotMessageEventSchema.safeParse(input);
}
