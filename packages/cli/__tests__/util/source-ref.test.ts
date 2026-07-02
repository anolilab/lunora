import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../../src/util/logger";
import { isImmutableRef, resolvePinnedSourceRef, resolveSourceRef, resolveVersionRef } from "../../src/util/source-ref";

/** A recording logger so the pin / warn provenance lines can be asserted. */
const recordingLogger = (): { infos: string[]; logger: Logger; warnings: string[] } => {
    const infos: string[] = [];
    const warnings: string[] = [];

    return {
        infos,
        logger: {
            error: () => {},
            info: (message) => infos.push(message),
            success: () => {},
            warn: (message) => warnings.push(message),
        },
        warnings,
    };
};

/** A fully-hex 40-char commit SHA fixture. */
const SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

/** The (loosely-typed) shape of the global `fetch` the pinning code calls — enough for a stub. */
type FetchStub = (input: string, init?: { headers: Record<string, string> }) => Promise<{ json: () => Promise<unknown>; ok: boolean; status?: number }>;

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

describe("isImmutableRef", () => {
    it("treats a full commit SHA and version tags as immutable", () => {
        expect.assertions(4);

        expect(isImmutableRef(SHA)).toBe(true);
        expect(isImmutableRef("v2.0.0")).toBe(true);
        expect(isImmutableRef("1.0.0-alpha.1")).toBe(true);
        expect(isImmutableRef("@lunora/cli@1.2.3")).toBe(true);
    });

    it("treats a release branch and a short SHA as NOT immutable (pinnable)", () => {
        expect.assertions(3);

        expect(isImmutableRef("alpha")).toBe(false);
        expect(isImmutableRef("main")).toBe(false);
        // A 7-char short SHA isn't a guaranteed-stable pin — resolve it too.
        expect(isImmutableRef("a1b2c3d")).toBe(false);
    });
});

describe("resolvePinnedSourceRef", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        delete process.env["GITHUB_TOKEN"];
        delete process.env["GH_TOKEN"];
    });

    it("pins a moving branch to the commit SHA from the GitHub API", async () => {
        expect.assertions(4);

        const calls: string[] = [];
        const fetchMock = vi.fn<FetchStub>(async (url) => {
            calls.push(url);

            return {
                json: async () => {
                    return { sha: SHA };
                },
                ok: true,
            };
        });

        vi.stubGlobal("fetch", fetchMock);

        const { infos, logger } = recordingLogger();
        const resolved = await resolvePinnedSourceRef("alpha", logger);

        expect(resolved).toBe(SHA);
        expect(calls[0]).toBe("https://api.github.com/repos/anolilab/lunora/commits/alpha");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        // The pin is logged so the user can audit the exact commit fetched.
        expect(infos.some((line) => line.includes(SHA))).toBe(true);
    });

    it("sends a bearer token when GITHUB_TOKEN is set (rate-limit relief)", async () => {
        expect.assertions(1);

        process.env["GITHUB_TOKEN"] = "ghp_secret";

        let sentAuth: string | undefined;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
                sentAuth = init.headers.authorization;

                return {
                    json: async () => {
                        return { sha: SHA };
                    },
                    ok: true,
                };
            }),
        );

        const { logger } = recordingLogger();

        await resolvePinnedSourceRef("alpha", logger);

        expect(sentAuth).toBe("Bearer ghp_secret");
    });

    it("falls back to the branch with a warning when the API fails (offline / rate-limited)", async () => {
        expect.assertions(3);

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("no network");
            }),
        );

        const { logger, warnings } = recordingLogger();
        const resolved = await resolvePinnedSourceRef("alpha", logger);

        expect(resolved).toBe("alpha");
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("UNPINNED");
    });

    it("falls back to the branch with a warning on a non-OK API response", async () => {
        expect.assertions(2);

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                return {
                    json: async () => {
                        return {};
                    },
                    ok: false,
                    status: 403,
                };
            }),
        );

        const { logger, warnings } = recordingLogger();
        const resolved = await resolvePinnedSourceRef("main", logger);

        expect(resolved).toBe("main");
        expect(warnings).toHaveLength(1);
    });

    it("uses an explicit commit SHA verbatim without any API call", async () => {
        expect.assertions(3);

        const fetchMock = vi.fn<FetchStub>(async () => {
            return {
                json: async () => {
                    return { sha: SHA };
                },
                ok: true,
            };
        });

        vi.stubGlobal("fetch", fetchMock);

        const { logger } = recordingLogger();
        const resolved = await resolvePinnedSourceRef(SHA, logger);

        expect(resolved).toBe(SHA);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(isImmutableRef(resolved)).toBe(true);
    });

    it("uses an explicit version tag verbatim without any API call", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<FetchStub>(async () => {
            return {
                json: async () => {
                    return { sha: SHA };
                },
                ok: true,
            };
        });

        vi.stubGlobal("fetch", fetchMock);

        const { logger } = recordingLogger();
        const resolved = await resolvePinnedSourceRef("v2.0.0", logger);

        expect(resolved).toBe("v2.0.0");
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
