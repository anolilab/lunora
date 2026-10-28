/**
 * Hints for the codes the browser client raises itself. Those errors never pass through a server envelope, so the client
 * attaches the hint when it builds them; they live apart from `hints.ts` so the client bundle carries these strings, not the
 * whole table. `hints.ts` keeps its own copy (the docs generator loads it with no module resolution), and
 * `catalog-integrity.test.ts` holds the two equal.
 */
const OFFLINE_NOT_QUEUED_HINT =
    "A mutation sent with `onlineOnly: true` found its connection down or reconnecting (the shard had connected before), or, on a shard that has never connected, its request failed on the wire. It was refused instead of queued. Nothing was persisted or replayed; issue the call again once the connection is back. See [keeping a write off the queue](/docs/concepts/offline-first#keeping-a-write-off-the-queue).";

const HTTP_STREAM_NO_BODY_HINT: ReadonlyArray<string> = [
    "The `fetch` implementation resolved with a response that exposes neither a `body` stream nor a `text()` read — a broken `fetch` substitute, not a runtime limitation.",
    "A response with no `body` stream that can still be read as text (React Native's `whatwg-fetch` polyfill) is buffered through `text()` instead and never raises this code. Check the `fetch` override passed to the client or the `httpStream` call.",
];

export { HTTP_STREAM_NO_BODY_HINT, OFFLINE_NOT_QUEUED_HINT };
