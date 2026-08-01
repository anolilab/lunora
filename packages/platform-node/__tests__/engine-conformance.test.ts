import { defineEngineContractSuite } from "@lunora/shard-engine/conformance";
import { describe, expect, it } from "vitest";

import { createNodeShardHost } from "../src/node-shard-host";
import { createNodeSocketHost } from "../src/node-socket-host";

/**
 * The engine contract suite (`@lunora/shard-engine`'s OCC, RLS, and reactive
 * fan-out guarantees), run against this package's `ShardHost` + `SocketHost`.
 *
 * `@lunora/platform/conformance`'s TCK (see `conformance.test.ts`) proves the
 * host PRIMITIVES are sound. This proves the ENGINE built on top of them is —
 * the layer plan 234 is actually spiking on, since a caller never touches
 * `ShardHost`/`SocketHost` directly. Mirrors `@lunora/shard-engine`'s own
 * reference-host run and `@lunora/do`'s workerd run: same suite, third host.
 */
describe("@lunora/shard-engine/conformance (node host)", () => {
    defineEngineContractSuite(
        "platform-node",
        () => {
            const { host } = createNodeShardHost();
            const { readFrames, socket } = createNodeSocketHost();

            return { host, readFrames, sockets: socket };
        },
        { describe, expect, it },
    );
});
