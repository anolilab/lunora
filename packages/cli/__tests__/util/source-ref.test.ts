import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../../src/util/logger";
import { isImmutableRef, resolveDistTag, resolvePinnedSourceRef, resolveSourceRef, resolveVersionRef } from "../../src/util/source-ref";

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

describe("resolveDistTag", () => {
    it("maps a STABLE version to the latest dist-tag (never a pre-release channel)", () => {
        expect.assertions(3);

        // The 1.0 promotion contract: a CLI published as a stable version must
        // pin scaffolded `@lunora/*` deps to `latest`, not `@alpha`.
        expect(resolveDistTag("1.0.0")).toBe("latest");
        expect(resolveDistTag("1.2.3")).toBe("latest");
        expect(resolveDistTag("10.0.0")).toBe("latest");
    });

    it("maps a pre-release channel version to its channel dist-tag", () => {
        expect.assertions(3);

        expect(resolveDistTag("1.0.0-alpha.86")).toBe("alpha");
        expect(resolveDistTag("2.0.0-beta.1")).toBe("beta");
        expect(resolveDistTag("1.1.0-next.3")).toBe("next");
    });

    it("maps the unpublished (0.0.0) version to alpha (its latest is a placeholder)", () => {
        expect.assertions(1);

        expect(resolveDistTag("0.0.0")).toBe("alpha");
    });

    it("maps a pre-release on an unrecognized channel to latest", () => {
        expect.assertions(2);

        // No `rc` dist-tag is published; these versions come off `main`, so
        // `latest` is the only channel whose tag resolves to real code.
        expect(resolveDistTag("1.0.0-rc.1")).toBe("latest");
        expect(resolveDistTag("1.0.0-canary.3")).toBe("latest");
    });

    it("ignores SemVer build metadata when detecting the channel", () => {
        expect.assertions(1);

        expect(resolveDistTag("1.0.0+build-alpha")).toBe("latest");
    });

    it("derives from the running CLI's own version when no version is given", () => {
        expect.assertions(1);

        // The checked-out CLI is either unpublished (0.0.0) or on a release
        // channel; both derive a known dist-tag, never the empty string.
        expect(["alpha", "beta", "next", "latest"]).toContain(resolveDistTag());
    });
});

describe("stable 1.0 template-ref derivation (resolveSourceRef + resolveVersionRef)", () => {
    it("a stable CLI fetches templates from the main branch, a channel CLI from its branch", () => {
        expect.assertions(2);

        // `lunora init` derives its default `--ref` from the CLI version: the
        // stable 1.0.0 CLI must fetch `gh:anolilab/lunora/templates/*#main`
        // (templates on `main` match the released code), NOT `#alpha`.
        expect(resolveVersionRef("1.0.0")).toBe("main");
        expect(resolveVersionRef("1.0.0-alpha.86")).toBe("alpha");
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
        expect.assertions(5);

        expect(isImmutableRef(SHA)).toBe(true);
        expect(isImmutableRef("v1.2.3")).toBe(true);
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

    it("does NOT treat a moving branch that merely starts with / embeds a version as immutable", () => {
        expect.assertions(4);

        // A branch that only *starts* with a SemVer must still be SHA-pinned — the
        // patterns are anchored to the WHOLE ref, not a prefix.
        expect(isImmutableRef("v1.2.3-latest")).toBe(false);
        // A `-latest` bare-identifier suffix is a moving alias, not a tooling tag.
        expect(isImmutableRef("1.2.3-latest")).toBe(false);
        // A branch that merely embeds a `@x.y.z` span is not the per-package tag form.
        expect(isImmutableRef("feature/@1.2.3/foo")).toBe(false);
        expect(isImmutableRef("release/v1.2.3")).toBe(false);
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
