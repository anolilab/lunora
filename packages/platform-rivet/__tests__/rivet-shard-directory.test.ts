import { resolveShard } from "@lunora/platform";
import { describe, expect, it } from "vitest";

import { createRivetNamespaceDouble } from "../src/conformance/rivet-namespace-double";
import { createRivetShardDirectory } from "../src/rivet-shard-directory";

describe("rivet shard directory", () => {
    it("passes a shard key as a single-element array rather than interpolating it", async () => {
        expect.assertions(1);

        const namespace = createRivetNamespaceDouble();
        const directory = createRivetShardDirectory(namespace);

        // A colon in a tenant id is the case Rivet's own key guidance warns
        // about: interpolated into a delimited string it would address a
        // different actor, so the key has to travel as one opaque element.
        await resolveShard(directory, "tenant:42/room:1").fetch(new Request("http://localhost/"));

        expect([...namespace.resolutions.keys()]).toStrictEqual(["tenant:42/room:1"]);
    });

    it("drops a location hint when no region mapping is supplied", async () => {
        expect.assertions(1);

        const namespace = createRivetNamespaceDouble();
        const directory = createRivetShardDirectory(namespace);

        await resolveShard(directory, "tenant-1", "weur").fetch(new Request("http://localhost/"));

        // Rivet region slugs are deployment-defined, so a Cloudflare-shaped
        // hint with nothing to map it through must be dropped, never guessed.
        expect(namespace.createdRegions.get("tenant-1")).toBeUndefined();
    });

    it("forwards a mapped region on the call that creates the actor", async () => {
        expect.assertions(2);

        const namespace = createRivetNamespaceDouble();
        const directory = createRivetShardDirectory(namespace, { resolveRegion: (hint) => (hint === "weur" ? "fra" : undefined) });

        await resolveShard(directory, "tenant-1", "weur").fetch(new Request("http://localhost/"));

        expect(namespace.createdRegions.get("tenant-1")).toBe("fra");

        // An actor does not migrate, so a later hint for the same key is inert.
        await resolveShard(directory, "tenant-1", "apac").fetch(new Request("http://localhost/"));

        expect(namespace.createdRegions.get("tenant-1")).toBe("fra");
    });

    it("omits jurisdiction so callers fail closed on a residency constraint", () => {
        expect.assertions(1);

        const directory = createRivetShardDirectory(createRivetNamespaceDouble());

        // A jurisdiction is a hard constraint; Rivet's region selection is
        // best-effort placement. Implementing one over the other would turn
        // "this data may not leave the EU" into "we tried".
        expect(directory.jurisdiction).toBeUndefined();
    });
});
