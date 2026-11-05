# Product registers are sent as changes

Real machines hold thousands of products at once. Measured with 4000 products (`docs/performance.md`), a `state`
message was 770 KB, one browser received 17 MB/s, and parsing and checking each message took the browser about 10 ms,
although from one 20 ms cycle to the next only a few products change. So a `state` can now come in register form: per
conveyor only the products that changed since the previous state of the same source, plus `registers`, the ids of the
whole register in order. This is the form recording files have stored since ADR 0006, now shared as `RegisterEncoder`
and `RegisterDecoder` in `@rpp/protocol`.

Clients ask for it with `/ws?changes=1`; the web app does. Every other client keeps getting whole states, so the API
stays as it was (ADR 0012) and the protocol version does not change. The server encodes only while such a client is
connected, once per message for all of them. A client gets every product of a source in its first state after
connecting and in the next state after the server dropped one for it because it could not keep up; after that it gets
the shared changes again. A browser that finds a product it does not know (it should not happen) closes the connection,
and the new one starts with every product.

A product counts as changed when any of its fields differs (`sameValue`, a plain comparison of the JSON values), so the
encoder does not depend on the fields a product has.

With 4000 simulated products a `state` in register form is about 25 KB, most of it the id list, and receiving it costs
the browser about 1 ms instead of 10 ms.

The same idea applies between the ADS bridge and the gateway, where converting every product to JSON, passing it to
Node, parsing and mapping it cost about 34 ms per cycle with 4900 products. The gateway reads its states with a session
(`sumRead(paths, { changes })`), new on every discovery. The bridge then keeps the bytes of every entry of a counted
array that has an `nId` (a product register, also XTS movers) by id, and gives such an array as `{"$ids": [...],
"$changed": [...]}`: the ids of the counted entries in order and only the entries that are new or whose bytes differ.
The gateway maps only those and keeps the other mapped products, the same objects, so the server's encoder finds them
unchanged at once. A product id the gateway does not know (the bridge restarted and the gateway did not) makes it start
a new session and read again in the same cycle. The in-memory PLC behind the tests and the simulator gives changes the
same way; the TCP driver (`ads-tcp`) gives whole arrays, which the gateway still takes. Measured on the demo PLC with
4900 products: reading from 24.9 to 3.0 ms, mapping from 9.1 to 0.9 ms.

## Considered Options

- **Changes for every client.** Simpler in the server, but it breaks every program that reads the WebSocket today.
- **A version counter per register in the PLC**, so the gateway reads and sends a register only when it changed. A busy
  conveyor's register changes in almost every cycle, so this would save little there, and every machine project would
  need a new library and protocol version. Finding changes in the bridge (above) needs no PLC change.
- **Compress the WebSocket (permessage-deflate).** Cuts the bytes but not the parsing and checking in the browser, and
  costs CPU on the gateway and on weak panel PCs.

## Consequences

- The browser keeps the previous register per source and conveyor; unchanged products are the same objects from one
  state to the next.
- A state in register form is only meaningful after the ones before it. The server tracks per client and source
  whether it got the previous state, and sends every product when it did not.
- The id list still grows with the products (about 5 bytes each). Sending it only when the order changes would cut it
  further.
- The bridge holds a copy of every register entry (72 bytes per product) and the gateway the mapped products. Both are
  dropped with a new session.
- The PLC contract and the library do not change.
