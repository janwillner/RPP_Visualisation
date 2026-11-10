import { bench, describe } from "vitest";
import type { GatewayMessage } from "@rpp/protocol";
import { createGateway } from "../src/gateway";
import { InMemoryPlc } from "../src/in-memory-plc";
import { conveyor, defineMachine } from "../src/plc-builders";

/**
 * What one acquisition cycle costs the gateway as the product register grows: reading (here from memory, so this is
 * the mapping and copying, not ADS), mapping to the neutral model and turning the state message into JSON once.
 * Run with `pnpm bench`; compare before and after a change on the same machine.
 */
const PRODUCT_COUNTS = [500, 2000, 4800];

function machineWith(products: number) {
  const plc = new InMemoryPlc();
  const value = conveyor({
    length: 20000,
    products: Array.from({ length: products }, (_, i) => ({
      nId: i + 1,
      stLatchPose: { fX: -i * 4, fY: ((i % 10) - 4.5) * 100, fZ: 0, fRz: 0 },
      nProductType: 1,
      nLastClientId: 50,
    })),
  });
  // As the ADS bridge delivers it: only the counted entries.
  value.stState.aProducts.length = products;
  defineMachine(plc, [{ id: 1, name: "Buffer belt", path: "MAIN.stBuffer", kind: "conveyor", value }]);
  const gateway = createGateway({ plc, sourceId: "bench", configRecheckMs: 0 });
  let last: GatewayMessage | undefined;
  gateway.subscribe((m) => {
    if (m.kind !== "parameters") last = m;
  });
  return { gateway, last: () => last };
}

for (const products of PRODUCT_COUNTS) {
  describe(`${products} products on one conveyor`, async () => {
    const machine = machineWith(products);
    await machine.gateway.cycle();
    const state = machine.last();

    bench("gateway cycle: read, map and publish one state", async () => {
      await machine.gateway.cycle();
    });

    bench("state message to JSON (once per message)", () => {
      JSON.stringify(state);
    });
  });
}
