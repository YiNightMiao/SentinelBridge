import { z } from "zod";

const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
  ONEBOT_WS_URL: z.string().url().refine((s) => s.startsWith("ws://") || s.startsWith("wss://"), "Expected ws:// or wss://"),
  WEBHOOK_URL: z.string().url().refine((s) => s.startsWith("http://") || s.startsWith("https://"), "Expected http(s) URL"),
  WEBHOOK_SECRET: z.string().default(""),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  WORKERS: z.coerce.number().int().min(1).max(32).default(2),
  LEASE_MS: z.coerce.number().int().min(1000).default(30000),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(100).default(10000),
  MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(8),
  HEARTBEAT_MS: z.coerce.number().int().min(1000).default(15000),
  MAX_PAYLOAD_BYTES: z.coerce.number().int().min(1024).max(10485760).default(1048576),
}).superRefine((c, ctx) => {
  if (c.LEASE_MS <= c.WEBHOOK_TIMEOUT_MS + 1000) {
    ctx.addIssue({ code: "custom", path: ["LEASE_MS"], message: "LEASE_MS must exceed WEBHOOK_TIMEOUT_MS by at least 1000 ms" });
  }
});

export type AppConfig = z.infer<typeof configSchema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse(env);
}
