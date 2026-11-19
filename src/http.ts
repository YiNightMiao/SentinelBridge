import Fastify from "fastify";
import type { Pool } from "pg";
import type { Metrics } from "./metrics.js";

export function createHttpApp(pool: Pool, metrics: Metrics) {
  const app = Fastify({ logger: false, bodyLimit: 16384 });
  app.get("/health", async () => ({ status: "alive" }));
  app.get("/ready", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ready" };
    } catch {
      reply.status(503);
      return { status: "unavailable" };
    }
  });
  app.get("/metrics", async (_req, reply) => {
    reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return metrics.render();
  });
  return app;
}
