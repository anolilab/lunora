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

/** npm dist-tag a stable CLI pins sibling `@lunora/*` deps to. */
const STABLE_DIST_TAG = "latest";

/**
 * Resolve the npm dist-tag that scaffolded consumer projects should pin sibling
 * `@lunora/*` dependencies to, derived from the running CLI's own version. This
 * is the dependency-range analogue of {@link resolveSourceRef}: it keeps a given
 * CLI release wiring projects to the channel it was published on. A pre-release
 * CLI (`1.0.0-alpha.1`) pins to its channel tag (`alpha`); the unpublished dev
 * version (`0.0.0`) also pins to `alpha` (its `latest` is a placeholder); every
 * stable version pins to `latest`.
 *
 * Mirrors {@link resolveVersionRef} but collapses its `main` (stable branch)
 * result to the `latest` dist-tag, since npm has no `main` channel.
 */
const resolveDistTag = (): string => {
    const ref = resolveVersionRef(resolveCliVersion());

    return ref === STABLE_BRANCH ? STABLE_DIST_TAG : ref;
};

/** Default public npm registry, used when no `npm_config_registry` is configured. */
const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/** The configured npm registry (honours `npm_config_registry`), without a trailing slash. */
const registryBase = (): string => {
    const configured = process.env["npm_config_registry"];
    const base = configured !== undefined && configured.length > 0 ? configured : DEFAULT_REGISTRY;

    return base.endsWith("/") ? base.slice(0, -1) : base;
};

/**
 * Resolve a dist-tag (`alpha` / `latest` / …) to the CONCRETE published version
 * it currently points at (e.g. `alpha` → `1.0.0-alpha.12`), via the npm registry.
 *
 * Scaffolds pin this concrete version rather than the floating tag: a tag in
 * `package.json` lets a stale lockfile or pnpm metadata cache silently keep an
 * older release (the specifier still "matches", so the lockfile is never
 * re-resolved). A concrete version forces the exact published code.
 *
 * Best-effort: returns `undefined` on any failure (offline, 404, malformed
 * packument, timeout) so the caller can fall back to the tag string. Uses the
 * abbreviated-packument accept header so only `dist-tags` (not every version's
 * full manifest) is transferred.
 */
const resolveTagVersion = async (packageName: string, tag: string): Promise<string | undefined> => {
    try {
        // Scoped names (`@lunora/vite`) encode only the `/`; the registry path is `/@lunora%2Fvite`.
        const response = await fetch(`${registryBase()}/${packageName.replace("/", "%2F")}`, {
            headers: { accept: "application/vnd.npm.install-v1+json" },
            signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
            return undefined;
        }

        const packument = (await response.json()) as { "dist-tags"?: Record<string, string> };

        return packument["dist-tags"]?.[tag];
    } catch {
        return undefined;
    }
};

/**
 * Resolve many package names' `tag` → concrete version in parallel (deduped).
 * A name whose lookup fails is simply absent from the returned map, so callers
 * fall back to the tag for it. See {@link resolveTagVersion}.
 */
const resolveTagVersions = async (names: Iterable<string>, tag: string): Promise<ReadonlyMap<string, string>> => {
    const resolved = new Map<string, string>();

    await Promise.all(
        [...new Set(names)].map(async (name) => {
            const version = await resolveTagVersion(name, tag);

            if (version !== undefined) {
                resolved.set(name, version);
            }
        }),
    );

    return resolved;
};

export { resolveDistTag, resolveSourceRef, resolveTagVersion, resolveTagVersions, resolveVersionRef };
