/**
 * The `hostd-latest` pointer the release workflow keeps (`scripts/`): each
 * channel only moves forward, a pre-release never moves `stable`, and a newer
 * stable release moves `prerelease` too.
 */
import { describe, expect, it } from "vitest";

import nextLatestPointer from "../scripts/latest-pointer.mjs";
import { compareReleaseVersions } from "../src/release";

const next = (current: unknown, version: string) => nextLatestPointer(current, version, compareReleaseVersions);

describe(nextLatestPointer, () => {
    it("starts from nothing, or from a pointer it cannot read", () => {
        expect.assertions(3);

        expect(next({}, "1.0.0-alpha.1")).toStrictEqual({ prerelease: "1.0.0-alpha.1", schema: 1, stable: null });
        expect(next(undefined, "1.0.0")).toStrictEqual({ prerelease: "1.0.0", schema: 1, stable: "1.0.0" });
        expect(next({ prerelease: "garbage", stable: 7 }, "1.0.0")).toStrictEqual({ prerelease: "1.0.0", schema: 1, stable: "1.0.0" });
    });

    it("moves only the pre-release channel for a pre-release", () => {
        expect.assertions(1);

        expect(next({ prerelease: "1.0.0", stable: "1.0.0" }, "1.1.0-alpha.1")).toStrictEqual({ prerelease: "1.1.0-alpha.1", schema: 1, stable: "1.0.0" });
    });

    it("moves both channels for a stable release newer than either", () => {
        expect.assertions(1);

        expect(next({ prerelease: "1.1.0-alpha.3", stable: "1.0.0" }, "1.1.0")).toStrictEqual({ prerelease: "1.1.0", schema: 1, stable: "1.1.0" });
    });

    it("never moves a channel back, whatever order releases are published in", () => {
        expect.assertions(2);

        const current = { prerelease: "1.2.0-alpha.1", schema: 1, stable: "1.1.0" };

        expect(next(current, "1.0.5")).toStrictEqual(current);
        expect(next(current, "1.2.0-alpha.0")).toStrictEqual(current);
    });

    it("refuses a version boxes could not order", () => {
        expect.assertions(1);

        expect(() => next({}, "nightly")).toThrow(/not a semantic version/u);
    });
});
