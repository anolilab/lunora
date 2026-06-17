import { describe, expect, it } from "vitest";

const sorted = (keys: ReadonlyArray<string>): ReadonlyArray<string> => [...keys].toSorted((a, b) => a.localeCompare(b));

// The umbrella is a pure re-export surface: each subpath must forward the
// upstream package's public API unchanged. These smoke tests guard against a
// subpath silently dropping its barrel (e.g. a typo in `export *`).
describe("lunora umbrella re-exports", () => {
    it("forwards the server authoring API from the default entry", async () => {
        expect.assertions(1);

        const root = await import("lunora");
        const server = await import("@lunora/server");

        expect(sorted(Object.keys(root))).toStrictEqual(sorted(Object.keys(server)));
    });

    it("forwards @lunora/server from lunora/server", async () => {
        expect.assertions(1);

        const viaUmbrella = await import("lunora/server");
        const direct = await import("@lunora/server");

        expect(sorted(Object.keys(viaUmbrella))).toStrictEqual(sorted(Object.keys(direct)));
    });

    it("forwards @lunora/values from lunora/values", async () => {
        expect.assertions(1);

        const viaUmbrella = await import("lunora/values");
        const direct = await import("@lunora/values");

        expect(sorted(Object.keys(viaUmbrella))).toStrictEqual(sorted(Object.keys(direct)));
    });

    it("forwards @lunora/client from lunora/client", async () => {
        expect.assertions(1);

        const viaUmbrella = await import("lunora/client");
        const direct = await import("@lunora/client");

        expect(sorted(Object.keys(viaUmbrella))).toStrictEqual(sorted(Object.keys(direct)));
    });
});
