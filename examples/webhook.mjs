// Demo-only downstream sink. Does not persist idempotency keys across restarts.
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const secret = process.env.WEBHOOK_SECRET || "";
const seen = new Set();
const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/events") {
    res.writeHead(404).end(); return;
  }
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 1024 * 1024) {
      res.writeHead(413).end(); return;
    }
  }
  const body = Buffer.concat(chunks);
  if (secret) {
    const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    const received = String(req.headers["x-sentinelbridge-signature"] || "");
    if (received.length !== expected.length ||
        !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) {
      res.writeHead(401).end(); return;
    }
  }
  const key = String(req.headers["x-sentinelbridge-idempotency-key"] || "");
  if (!key) { res.writeHead(400).end(); return; }
  if (!seen.has(key)) {
    seen.add(key);
    console.log("Received event:", key);
  }
  res.writeHead(204).end();
});
server.listen(9000, "0.0.0.0", () => console.log("Demo webhook listening on 9000"));
