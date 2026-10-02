# @lunora/hostd

`lunora-hostd` is the daemon a customer installs on their own server so Lunora
Cloud can run [celld](../../packages/platform-celld) fleets on it (plan 458). It
dials out over a WebSocket to the box's Durable Object in Lunora Cloud; the box
needs no inbound port for the control plane.

**Status:** only the wire protocol exists. Enrolment, the session and the
supervisor arrive with plan 458 W4; the `lunora-hostd` binary answers
`--version` and `--help` and refuses everything else.

## Wire protocol

`@lunora/hostd/protocol` holds the message types, the strict validators and the
signing payloads both sides use. It has no runtime dependencies and runs in Node
and workerd. The normative contract is
[`protocol/hostd/README.md`](../../protocol/hostd/README.md).

```ts
import { decodeBoxMessage, encodeMessage, negotiateProtocolVersion, peekProtocolVersion } from "@lunora/hostd/protocol";

const offered = peekProtocolVersion(frame);
const negotiation = negotiateProtocolVersion(offered ?? 0);

if (!negotiation.ok) {
    socket.send(encodeMessage({ code: negotiation.code, message: negotiation.message, type: "error" }));
    socket.close();
}

const decoded = decodeBoxMessage(frame); // never throws
```

`apps/cloud` depends on this package; this package never depends on
`apps/cloud`.

## License

[FSL-1.1-Apache-2.0](./LICENSE.md): use it for any purpose except a Competing
Use; each release converts to Apache-2.0 two years after it ships.
