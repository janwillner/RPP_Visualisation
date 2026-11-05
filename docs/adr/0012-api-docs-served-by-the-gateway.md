# The gateway serves its API documentation, generated from the protocol schemas

Programs other than the web app want the machine data too: an MES, a dashboard, a logger. They need to know the
WebSocket messages, `/health` and the recording file layout, and they need the documentation of the version that runs on
the IPC in front of them, not of the repository's newest commit. So the gateway serves the documentation itself at
`/docs`, on the same port as the app and the WebSocket. `/docs/schema.json` gives the same as JSON Schema.

The page has five parts. The introduction is written by hand in `docs/api.md`. The reference is generated from the zod
schemas of `@rpp/protocol`: every schema and field carries a `.describe()` text, and a test fails for a field without
one. Its examples are real messages from a simulator run, cut short, and a test checks them against the schemas. The
server options come from the list that `--help` also prints. The last two parts are the PLC contract and the library
guide. The gateway builds the page in memory on its first request, which takes about a second for the simulator run.
It needs no built web app, so the docs also work with `pnpm dev:gateway`. The package bundle embeds the Markdown texts,
so the install folder has no `docs/`.

The `/health` report and the recording file header and lines became zod schemas in the protocol package, so that they
are documented the same way. Gateway and web take their types from them.

The documentation states the compatibility rules for clients: ignore unknown fields and kinds, and check
`protocolVersion`. The protocol version goes up with every change of meaning. The JSON Schema therefore allows extra
properties.

## Considered Options

- **Write the whole reference by hand.** It would fall behind with the next protocol version.
- **Read the JSDoc comments with the TypeScript compiler API.** This would leave the schemas unchanged, but it needs its
  own fragile extractor at build time, and the running gateway could not use the texts.
- **AsyncAPI with its renderer.** This is a standard format, but the renderer is heavy and needs either a CDN or a large
  bundle, and the IPCs are offline. An AsyncAPI file can still be generated from the same schemas later.
- **Build static files into `apps/web/dist/docs`.** Then the docs would depend on the web app build and would be missing
  where the gateway serves no app.

## Consequences

- A protocol field without a description fails the tests.
- The PLC mapping looks up enum tables by the enum's options, because a described field is a copy of the shared enum
  schema, not the same instance.
- The docs import the status colours from the web app's palette, so the gateway bundle reaches into `apps/web/src`
  for that one file.
- The page has no authentication, like the rest of the server. Whoever reaches the port can read the documentation too.
