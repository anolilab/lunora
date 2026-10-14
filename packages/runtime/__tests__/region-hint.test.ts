import { describe, expect, it } from "vitest";

import { isRegionHint, regionHintFromGeo, regionHintFromRequest } from "../../../shared/region-hint";

describe("regionHintFromGeo", () => {
    it.each([
        ["NA", -122.4, undefined, "wnam"],
        ["NA", -74, undefined, "enam"],
        // Exactly on the meridian falls east — the split is `< -100`.
        ["NA", -100, undefined, "enam"],
        ["EU", 2.35, undefined, "weur"],
        ["EU", 21, undefined, "eeur"],
        ["SA", -46.6, undefined, "sam"],
        ["OC", 151.2, undefined, "oc"],
        ["AF", 18.4, undefined, "afr"],
        ["AS", 139.7, "JP", "apac"],
        ["AS", 55.3, "AE", "me"],
    ] as const)("maps continent %s at %s to %s", (continent, longitude, country, expected) => {
        expect.assertions(1);

        expect(regionHintFromGeo({ continent, country, longitude })).toBe(expected);
    });

    it("falls back to the continent's coarse region when longitude is missing or unparseable", () => {
        expect.assertions(2);

        expect(regionHintFromGeo({ continent: "NA" })).toBe("enam");
        expect(regionHintFromGeo({ continent: "EU", longitude: "not-a-number" })).toBe("weur");
    });

    it("reads Cloudflare's stringified longitude", () => {
        expect.assertions(1);

        expect(regionHintFromGeo({ continent: "NA", longitude: "-122.4194" })).toBe("wnam");
    });

    it("returns no hint for geography it cannot place", () => {
        expect.assertions(3);

        // Antarctica has no region; an absent/unknown continent must not be
        // guessed at, or every ungeolocatable request would drag its shard to
        // whichever region we picked as the default.
        expect(regionHintFromGeo({ continent: "AN" })).toBeUndefined();
        expect(regionHintFromGeo({})).toBeUndefined();
        expect(regionHintFromGeo({ continent: "XX" })).toBeUndefined();
    });

    it("only ever returns a known placement region", () => {
        expect.assertions(1);

        const produced = new Set(
            ["AF", "AS", "EU", "NA", "OC", "SA", "AN"].flatMap((continent) =>
                [-180, -100, 0, 15, 180].map((longitude) => regionHintFromGeo({ continent, longitude })),
            ),
        );

        produced.delete(undefined);

        expect([...produced].every((hint) => isRegionHint(hint))).toBe(true);
    });
});

describe("regionHintFromRequest", () => {
    it("reads the region off request.cf", () => {
        expect.assertions(1);

        const request = Object.assign(new Request("https://example.com/"), { cf: { continent: "EU", longitude: "21.0" } });

        expect(regionHintFromRequest(request)).toBe("eeur");
    });

    it("returns no hint for a synthesized subrequest with no cf", () => {
        expect.assertions(1);

        // Every internal hop (the shard RPC envelope, an admin fan-out) is in
        // this class, which is why the client's region has to be threaded
        // through rather than re-read downstream.
        expect(regionHintFromRequest(new Request("https://shard.internal/rpc"))).toBeUndefined();
    });
});
