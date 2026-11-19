import { readFileSync } from "node:fs";
import { validateOneBotMessageEvent } from "./onebot-event.js";

// Minimal executable smoke test: read one JSON event from stdin.
// This is NOT a live WebSocket gateway, queue, or persistence layer.
function main(): number {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(0, "utf8")) as unknown;
  } catch {
    console.error("Input must contain one valid JSON value.");
    return 1;
  }

  const result = validateOneBotMessageEvent(input);
  if (!result.success) {
    console.error("Invalid OneBot message event:");
    for (const issue of result.error.issues) {
      console.error("- " + (issue.path.join(".") || "(root)") + ": " + issue.message);
    }
    return 1;
  }

  const event = result.data;
  console.log(JSON.stringify({
    valid: true,
    post_type: event.post_type,
    message_type: event.message_type,
    message_id: event.message_id,
    ...(event.message_type === "group" ? { group_id: event.group_id } : {}),
  }));
  return 0;
}

process.exitCode = main();
