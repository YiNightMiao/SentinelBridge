# SentinelBridge — Operations

## Local development

Requirements: Node.js 22+, pnpm 10, PostgreSQL 16. Set `DATABASE_URL`, `ONEBOT_WS_URL`, `WEBHOOK_URL` (see `.env.example`).

```bash
corepack enable
pnpm install
pnpm build
pnpm test
DATABASE_URL=... ONEBOT_WS_URL=ws://127.0.0.1:3001 WEBHOOK_URL=http://127.0.0.1:9000/events pnpm start
```

The process applies `sql/001_init.sql` on startup. Migrations are additive and idempotent for the initial version; future schema changes must be explicit numbered migrations.

To run with Docker, start a NapCat-compatible OneBot v11 WebSocket server at host port 3001 and a webhook receiver at port 9000 (e.g. `node examples/webhook.mjs`), then:

```bash
docker compose up --build
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/ready
curl http://127.0.0.1:8080/metrics
```

The Compose database password is **development-only**. Change credentials for any shared/external deployment. The demo webhook and its in-memory idempotency set are **not** production-grade.

## Reliability model

An event is accepted only when both the event row and its pending delivery row are committed in one PostgreSQL transaction. Retries happen after a worker failure, crash, or lease timeout. `FOR UPDATE SKIP LOCKED` ensures workers do not claim the same unlocked job simultaneously; `lease_token` guards database state updates by stale workers. External requests can still be duplicated if a worker crashes after delivery but before recording success. **Downstream consumers MUST implement persistent idempotency.**

An upstream OneBot WebSocket does not offer a guaranteed replay mechanism; messages emitted during a network partition before persistence may be lost. The service does **not** guarantee exactly-once delivery or upstream losslessness.

- 2xx: delivered
- 408 / 429 / 5xx / transport errors: bounded exponential retry (with jitter)
- Other 4xx: dead letter
- Exceeded `MAX_ATTEMPTS`: dead letter
- Dead letters: inspect `deliveries` and `events` in PostgreSQL; use `pnpm redrive <event-uuid>` from a trusted operator shell after inspecting a dead job; there is no unauthenticated replay HTTP endpoint.

## Security and deployment limits

The gateway stores message payload JSONB, potentially including sensitive chat text. Restrict database access and retention; do not expose PostgreSQL to the public network. Use HTTPS for production webhook destinations, a strong `WEBHOOK_SECRET` and HMAC signature validation, network policies, and source WebSocket authentication as provided by NapCat. Health/metrics endpoints have no built-in authentication and must stay on loopback or behind trusted access controls. A public deployment requires a separate threat-model/security review.

## Testing

The GitHub Actions CI provisions PostgreSQL and runs real database and mock WebSocket integration tests, plus typecheck and Docker build. Run locally with `TEST_DATABASE_URL=...` to include database tests. Unit tests run without PostgreSQL.

The CI also runs a deterministic Toxiproxy bidirectional timeout=0 network-blackhole test. A privileged dead-letter redrive CLI is available. Automatic schema-version migrations, Grafana dashboards, production security hardening, and throughput benchmarks are **not implemented** in this version. They remain backlog work; do not treat operational targets in the architecture proposal as measured results.
