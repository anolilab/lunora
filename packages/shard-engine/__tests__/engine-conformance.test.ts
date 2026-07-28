import { createReferenceHost } from "@lunora/platform/conformance";
import { describe, expect, it } from "vitest";

import { defineEngineContractSuite } from "../src/conformance";

/**
 * The engine contract suite, run against `@lunora/platform`'s reference host.
 *
 * This is the reference run: it proves the suite is executable and that the
 * engine's guarantees hold on the simplest conforming host. Reusing the
 * platform TCK's reference host rather than a local double is deliberate —
 * anything the engine needs that the reference host lacks is a gap in the
 * contracts*, and this is where it shows up. A bespoke double would paper over
 * exactly that.
 *
 * The Cloudflare run lives in `@lunora/do`'s workerd project, where a real
 * Durable Object supplies the pair — same suite, different `factory`.
 */
describe("@lunora/shard-engine/conformance", () => {
    defineEngineContractSuite(
        "platform reference host",
        () => {
            const host = createReferenceHost();

            if (host.readFrames === undefined) {
                throw new Error("the reference host must expose `readFrames` — every delivery leg is stated in terms of it");
            }

            return { close: host.cleanup, createSocket: host.createSocket, host: host.shard, readFrames: host.readFrames, sockets: host.socket };
        },
        { describe, expect, it },
    );
});
