import type { StateMessage } from "@rpp/protocol";
import type { GatewayConnection, MessageListener, SceneSource, SourceInfo } from "@rpp/machine-view";
import { METRICS_WINDOW_MS, ProductHistory } from "@rpp/machine-view";
import type { LiveFeed } from "./viewer";

/**
 * The live machine as the visualisation reads it: the gateway connection's sources plus every product's history and
 * the product events the metrics count, followed from the first message on.
 */
export class LiveMachine implements LiveFeed {
  // Product events are kept a little longer than the metrics look back.
  private readonly products = new ProductHistory(undefined, 2 * METRICS_WINDOW_MS);
  /** Arrival of the first state: the metrics cover no more than the time since. */
  private firstStateAt: number | undefined;

  constructor(private readonly connection: GatewayConnection) {
    connection.onMessage((message, _raw, arrival, source) => {
      if (message.kind !== "state" || message.configVersion !== source?.config?.configVersion) return;
      this.products.add(arrival, message, source);
      this.firstStateAt ??= arrival;
    });
  }

  subscribe = (listener: () => void) => this.connection.subscribe(listener);

  getSnapshot = () => this.connection.getSnapshot();

  onMessage(listener: MessageListener): () => void {
    return this.connection.onMessage(listener);
  }

  /** Every source as it is now, where a recording starts. */
  recordingContext(): readonly SourceInfo[] {
    return this.connection.getSnapshot().sources;
  }

  frame(now = performance.now()): SceneSource[] {
    return this.connection.frame(now);
  }

  latestState(sourceId: string): StateMessage | undefined {
    return this.connection.latestState(sourceId);
  }

  productHistory(sourceId: string, conveyorId: number, productId: number) {
    return { steps: this.products.of(sourceId, conveyorId, productId), now: performance.now() };
  }

  productEvents(windowMs: number) {
    const now = performance.now();
    return { events: this.products.events(now - windowMs, now), now, since: this.firstStateAt ?? now };
  }
}
