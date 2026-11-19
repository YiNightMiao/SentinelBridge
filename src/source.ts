import WebSocket, { type RawData } from "ws";
import { validateOneBotEvent } from "./onebot-event.js";
import type { EventStore } from "./db.js";
import type { Metrics } from "./metrics.js";

export type SourceOptions = {
  url: string;
  heartbeatMs: number;
  maxPayloadBytes: number;
  reconnectBaseMs?: number;
};

export class OneBotSource {
  private connection: WebSocket | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private attempts = 0;
  private inflight: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: SourceOptions,
    private readonly store: Pick<EventStore, "ingest">,
    private readonly metrics: Metrics,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.options.url, {
      handshakeTimeout: 10000,
      maxPayload: this.options.maxPayloadBytes,
    });
    this.connection = ws;
    let pongReceived = true;

    ws.on("open", () => {
      this.attempts = 0;
      pongReceived = true;
      this.heartbeat = setInterval(() => {
        if (!pongReceived) {
          ws.terminate();
          return;
        }
        pongReceived = false;
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, this.options.heartbeatMs);
      console.info("OneBot WebSocket connected");
    });

    ws.on("pong", () => { pongReceived = true; });

    ws.on("message", (data: RawData, isBinary: boolean) => {
      // Pause transport while awaiting the durable write (bounded by ws maxPayload).
      ws.pause();
      this.inflight = this.inflight
        .then(() => this.process(data, isBinary))
        .catch(() => { console.error("OneBot ingestion failed; event may require upstream replay"); })
        .finally(() => { if (ws.readyState === WebSocket.OPEN) ws.resume(); });
    });

    ws.on("error", () => { /* 'close' handles retry; never print authentication URLs. */ });
    ws.on("close", () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      if (this.connection === ws) this.connection = undefined;
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private async process(data: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) {
      this.metrics.increment("sentinel_invalid_total");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(data.toString("utf8")) as unknown;
    } catch {
      this.metrics.increment("sentinel_invalid_total");
      return;
    }
    const parsed = validateOneBotEvent(value);
    if (!parsed.success) {
      this.metrics.increment("sentinel_invalid_total");
      return;
    }
    const { accepted } = await this.store.ingest(parsed.data);
    this.metrics.increment(accepted ? "sentinel_ingested_total" : "sentinel_duplicates_total");
  }

  private scheduleReconnect(): void {
    const backoff = Math.min(30000, (this.options.reconnectBaseMs ?? 500) * 2 ** Math.min(8, this.attempts++));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, backoff);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.reconnectTimer = undefined;
    this.heartbeat = undefined;
    this.connection?.terminate();
    this.connection = undefined;
    await this.inflight;
  }
}
