/**
 * Resolve the git ref (branch / tag / commit) that remote `gh:anolilab/lunora`
 * fetches read from — shared by `init` (project templates) and the registry
 * commands (component items). The ref is an explicit `--ref` when given, else
 * derived from the running CLI's own version so a given CLI release pulls from
 * the channel it was published on. Templates and registry items are not
 * versioned independently of the monorepo and the release tooling tags
 * per-package (`@lunora/cli@X.Y.Z`), not `vX.Y.Z` — so the derived ref is always
 * a long-lived release branch, never a version tag: pre-release channels map to
 * their branch (e.g. `1.0.0-alpha.1` → `alpha`), stable versions to `main`, and
 * the unpublished dev version (`0.0.0`) to the `alpha` channel.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { dirname, join } from "@visulima/path";

/** Branch used when the CLI is unpublished (`0.0.0`) or its package.json can't be read. */
const DEFAULT_SOURCE_REF_FALLBACK = "alpha";

/** Branch a stable (non-pre-release) CLI version fetches from. */
const STABLE_BRANCH = "main";

/**
 * Pre-release channels that publish from a long-lived branch of the same name
 * (the Branch Strategy + Release channels in AGENTS.md: `alpha` / `beta` /
 * `next`). A CLI published from one of these carries a version like
 * `1.0.0-alpha.1`; the matching snapshot lives on that branch — there is no
 * `v1.0.0-alpha.1` git tag — so such versions resolve to the channel branch.
 */
const PRERELEASE_CHANNEL_BRANCHES = new Set(["alpha", "beta", "next"]);

/**
 * Characters allowed in an explicit `--ref` (a conservative git-ref subset:
 * letters, digits, `.`, `_`, `-`, `/`, `@`). Combined with an explicit `..`
 * rejection in {@link isSafeRef}, this applies the same `..`/charset discipline
 * the `--source` gate enforces (though via a throw rather than that gate's
 * non-throwing, scheme-allowlist predicate) so a ref can't smuggle a
 * path-traversal segment into the giget cache path.
 */
const SAFE_REF = /^[\w./@-]+$/;

/** True when `ref` is a safe git ref: allowed charset only, and no `..` segment. */
const isSafeRef = (ref: string): boolean => !ref.includes("..") && SAFE_REF.test(ref);

/**
 * Read the running `@lunora/cli`'s own version. Walks up from this module's
 * directory to find the package.json whose `name` is `@lunora/cli` — works
 * whether the file is the built `dist/*.mjs` or the source under `src/`. Returns
 * `"0.0.0"` (the unpublished sentinel) when it can't be determined.
 */
const resolveCliVersion = (): string => {
    try {
        let directory = dirname(fileURLToPath(import.meta.url));

        for (let index = 0; index < 6; index += 1) {
            const candidate = join(directory, "package.json");

            if (existsSync(candidate)) {
                const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };

                if (parsed.name === "@lunora/cli" && typeof parsed.version === "string") {
                    return parsed.version;
                }
            }

            const parent = dirname(directory);

            if (parent === directory) {
                break;
            }

            directory = parent;
        }
    } catch {
        // Fall through to the sentinel.
    }

    return "0.0.0";
};

/**
 * Map a CLI version string to the git ref it should fetch. The unpublished
 * `0.0.0` version falls back to the `alpha` branch. A pre-release version like
 * `1.0.0-alpha.1` whose channel is one of {@link PRERELEASE_CHANNEL_BRANCHES}
 * resolves to that channel branch (e.g. `alpha`). Every other version — stable,
 * or a pre-release on an unrecognized channel — resolves to {@link STABLE_BRANCH}.
 */
const resolveVersionRef = (version: string): string => {
    if (version === "0.0.0") {
        return DEFAULT_SOURCE_REF_FALLBACK;
    }

    // Strip SemVer build metadata (`+…`) before scanning for the pre-release
    // `-` so e.g. `1.0.0+build-alpha` isn't misread as the `alpha` channel.
    const core = version.split("+")[0] ?? version;
    const dashIndex = core.indexOf("-");

    if (dashIndex !== -1) {
        const [channel] = core.slice(dashIndex + 1).split(".");

        if (channel !== undefined && PRERELEASE_CHANNEL_BRANCHES.has(channel)) {
            return channel;
        }
    }

    return STABLE_BRANCH;
};

/**
 * Resolve the git ref to fetch from. An explicit `ref` (a `--ref` branch, tag,
 * or commit) always wins, after a safety check ({@link isSafeRef}); otherwise
 * the ref is derived from the running CLI's version via {@link resolveVersionRef}.
 * Throws when an explicit `ref` contains a disallowed character or a `..`
 * path-traversal segment.
 */
const resolveSourceRef = (ref: string | undefined): string => {
    if (ref !== undefined && ref.length > 0) {
        if (!isSafeRef(ref)) {
            throw new Error(`invalid --ref "${ref}" — a ref may contain letters, digits, ".", "_", "-", "/", "@" and must not contain "..".`);
        }

        return ref;
    }

    return resolveVersionRef(resolveCliVersion());
};

export { resolveSourceRef, resolveVersionRef };
