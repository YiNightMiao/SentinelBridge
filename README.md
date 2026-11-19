# SentinelBridge

**A fault-tolerant event gateway for OneBot v11 and NapCat.**

> **Status:** Architecture / Day 1 bootstrap specification. This repository does **not** yet contain a working gateway, a deployed service, or verified benchmark results.

SentinelBridge is a proposed, open-source TypeScript infrastructure service for reliably ingesting OneBot v11 events, persisting accepted events, and delivering them to downstream automation services with observable recovery behavior. It is designed for use with NapCat but keeps the ingestion protocol boundary explicit.

**License:** Apache License 2.0 (see `LICENSE` once added).

## Why this project?

Bot integrations can encounter malformed events, WebSocket disconnects, gateway/worker crashes, duplicate deliveries, and downstream outages. The gateway should protect downstream consumers from those failures *without inventing guarantees the upstream protocol does not provide*.

### Reliability guarantees and non-goals

- **Durable acceptance:** Once an event has been successfully committed to the database, it can be retried after a process restart.
- **At-least-once downstream delivery:** Persisted accepted events may be delivered more than once; consumers must be idempotent.
- **Deduplication:** Prefer stable upstream event identifiers when available. Otherwise use scoped, documented best-effort deduplication; do not promise exactly-once delivery.
- **No upstream replay promise:** Events lost before the gateway persists them cannot be recovered unless the upstream offers replay.
- **No silent repair:** Invalid JSON or required fields should be rejected/quarantined with sanitized diagnostics, not patched up heuristically.
- **Security:** Never log secrets or raw sensitive message content by default. Production deployment and credential use require human approval.

## Proposed architecture

```text
NapCat / OneBot v11 WebSocket
            |
            v
   WebSocket transport
  (lifecycle, size limits)
            |
            v
  Parse -> Validate (Zod) -> Normalize
            |
            v
   PostgreSQL durable ingest
            |
            v
  Queue / worker leasing (future phase)
  (SKIP LOCKED, retries, dead-letter queue)
            |
            v
  Idempotent downstream consumers

  OpenTelemetry -> Prometheus / Grafana
```

A canonical envelope will include schema version, source, received timestamp, event type, a gateway-generated ID, an optional stable upstream ID, and validated payload metadata. Unknown optional fields may be preserved for forward compatibility, while malformed required routing fields are rejected.

**Important:** Connection fragmentation is handled at the WebSocket transport layer; two separate invalid application messages must never be concatenated in an attempt to make valid JSON.

## Planned technology stack

| Component | Choice |
| --- | --- |
| Runtime | Node.js 22; TypeScript (strict) |
| Package manager | pnpm |
| HTTP / health endpoints | Fastify |
| WebSocket client | ws |
| Schema validation | Zod |
| Durable storage | PostgreSQL |
| Tests | Vitest, Testcontainers, mock OneBot server |
| Fault injection (later phase) | Toxiproxy |
| Observability (later phase) | OpenTelemetry, Prometheus, Grafana |
| Automation | GitHub Actions, Docker Compose |

These are **design choices**, not already-installed dependencies.

## Day 1 — Devin Bot bootstrap specification

### Exact Day 1 prompt

> You are the lead software engineer bootstrapping `YiNightMiao/SentinelBridge`. Create a reviewable, production-oriented TypeScript foundation for a OneBot v11 / NapCat event gateway. Work only within the repository; do not access production systems, real QQ accounts, or secrets. Start with one agent and one focused pull request.
>
> **Step 1 — Bootstrap:** Add Apache-2.0 licensing/notice as needed, Node.js 22 and pnpm setup, strict TypeScript configuration, ESLint, Prettier, Vitest, `.gitignore`, and scripts for lint, typecheck, test, and build. Add a clear README, CONTRIBUTING.md, SECURITY.md, and an architecture decision record. Add GitHub Actions checks.
>
> **Step 2 — Thin vertical slice:** Implement a OneBot v11 WebSocket client, bounded message-size handling, Zod event validation, a versioned normalized event envelope, and PostgreSQL persistence using migrations. Only acknowledge an event as durably accepted after the database transaction commits. Include startup/shutdown paths and correlation-ID logging. Do not attempt to implement the entire delivery worker system on Day 1; define the interface and track the rest as issues.
>
> **Step 3 — Isolated tests:** Build a local mock OneBot WebSocket server and Testcontainers PostgreSQL test environment. Verify valid-event persistence, malformed JSON handling, invalid routing fields, forward-compatible optional fields, restart durability, and isolation from external services. If core tests are stable, add one deterministic Toxiproxy disconnect/reconnect test with explicit readiness barriers and observable state assertions rather than fixed sleeps.
>
> **Step 4 — Review and evidence:** Run documented lint, typecheck, unit tests, integration tests, and build commands. Open a PR that includes real command output, known risks, reproducible setup steps, and follow-up issues. Do not merge your own PR or claim unverified results. Stop and report blockers rather than inventing metrics or hidden implementation details.

### Acceptance criteria (must be demonstrated, not assumed)

1. A clean checkout can install dependencies and run documented lint, typecheck, build, and unit-test commands on Node.js 22.
2. Integration tests use isolated mock WebSocket + PostgreSQL infrastructure, without production accounts or credentials.
3. Valid events are persisted; malformed and unsupported input cannot crash the ingestion loop or corrupt already-accepted events.
4. A gateway restart preserves previously committed events.
5. CI executes the deterministic checks and preserves failure evidence. No arbitrary `sleep(5000)` assertions or blind retries to hide flakes.
6. A human-reviewable PR explains what actually passed, what failed, and what is not implemented.
7. Any unsupported reliability claim is explicitly documented rather than presented as achieved.

### Follow-up milestones (not Day 1)

- **M2 — Delivery:** Lease-based PostgreSQL workers, bounded retries with jitter, dead-letter handling, downstream idempotency keys.
- **M3 — Resilience:** Deterministic Toxiproxy failure scenarios in PR checks, separately seeded randomized chaos tests nightly.
- **M4 — Observability:** OpenTelemetry instrumentation, actionable metrics, Grafana dashboards, performance benchmarks, threat model.

### CI test philosophy

Use state-based synchronization and bounded deadlines. Control PR-gating fault cases deterministically (hard disconnect, half-open transport, worker crash); keep randomized packet-loss/latency stress in a separately reported nightly suite. A failure should preserve test seed (when applicable), proxy configuration, container logs, and an event-state timeline.

Do **not** infer end-to-end exactly-once processing from a passing test. Validate durable persistence, at-least-once behavior, deduplication boundaries, and idempotent processing independently.

## Project status

- [x] Project architecture and Day 1 specification documented.
- [ ] Bootstrap implementation.
- [ ] Automated CI and isolated integration tests.
- [ ] Durable delivery workers.
- [ ] Fault-injection benchmark evidence.
- [ ] Production deployment (requires human review).

Contributions and technical reviews are welcome once the initial implementation lands.
