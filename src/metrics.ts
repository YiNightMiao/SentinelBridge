export class Metrics {
  private readonly counters = new Map<string, number>([
    ["sentinel_ingested_total", 0],
    ["sentinel_duplicates_total", 0],
    ["sentinel_invalid_total", 0],
    ["sentinel_delivery_success_total", 0],
    ["sentinel_delivery_retry_total", 0],
    ["sentinel_delivery_dead_total", 0],
  ]);
  increment(name: string): void {
    if (!this.counters.has(name)) throw new Error("Unknown metric");
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
  }
  render(): string {
    return [...this.counters].map(([name, count]) => `# TYPE ${name} counter\n${name} ${count}\n`).join("");
  }
}
