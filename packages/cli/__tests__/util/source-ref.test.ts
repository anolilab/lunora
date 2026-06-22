import { describe, expect, it } from "vitest";

import { resolveSourceRef, resolveVersionRef } from "../../src/util/source-ref";

describe("resolveVersionRef", () => {
    it("maps a pre-release channel version to its branch", () => {
        expect.assertions(3);

        expect(resolveVersionRef("1.0.0-alpha.1")).toBe("alpha");
        expect(resolveVersionRef("2.3.4-beta.0")).toBe("beta");
        expect(resolveVersionRef("1.0.0-next.5")).toBe("next");
    });

    it("maps a stable version to the main branch (the repo tags @lunora/cli@X.Y.Z, not vX.Y.Z)", () => {
        expect.assertions(2);

        expect(resolveVersionRef("1.2.3")).toBe("main");
        expect(resolveVersionRef("10.0.0")).toBe("main");
    });

    it("falls back to alpha for the unpublished (0.0.0) version", () => {
        expect.assertions(1);

        expect(resolveVersionRef("0.0.0")).toBe("alpha");
    });

    it("maps a pre-release on an unrecognized channel to main", () => {
        expect.assertions(2);

        expect(resolveVersionRef("1.0.0-rc.2")).toBe("main");
        expect(resolveVersionRef("1.0.0-canary.3")).toBe("main");
    });

    it("ignores SemVer build metadata when detecting the channel", () => {
        expect.assertions(2);

        expect(resolveVersionRef("1.0.0-alpha.1+build.7")).toBe("alpha");
        // A `-` that lives only in the build metadata must not be read as a channel.
        expect(resolveVersionRef("1.0.0+build-alpha")).toBe("main");
    });
});

describe("resolveSourceRef", () => {
    it("returns a safe explicit ref verbatim", () => {
        expect.assertions(3);

        expect(resolveSourceRef("alpha")).toBe("alpha");
        expect(resolveSourceRef("v2.0.0")).toBe("v2.0.0");
        expect(resolveSourceRef("a1b2c3d")).toBe("a1b2c3d");
    });

    it("rejects a ref containing a path-traversal segment or disallowed characters", () => {
        expect.assertions(3);

        expect(() => resolveSourceRef("../../etc")).toThrow(/invalid --ref/);
        expect(() => resolveSourceRef("feature..branch")).toThrow(/invalid --ref/);
        expect(() => resolveSourceRef("a branch")).toThrow(/invalid --ref/);
    });

    it("ignores an empty explicit ref and derives one from the CLI version", () => {
        expect.assertions(1);

        // An empty ref is treated as "not provided", so the result is the
        // version-derived ref: a known release branch, never the empty string.
        expect(["alpha", "beta", "next", "main"]).toContain(resolveSourceRef(""));
    });
});
