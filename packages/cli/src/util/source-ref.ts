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

import { LunoraError } from "@lunora/errors";
import { dirname, join } from "@visulima/path";

import type { Logger } from "./logger";

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
            throw new LunoraError("INTERNAL", `invalid --ref "${ref}" — a ref may contain letters, digits, ".", "_", "-", "/", "@" and must not contain "..".`);
        }

        return ref;
    }

    return resolveVersionRef(resolveCliVersion());
};

/**
 * The GitHub repo the default `init` templates + registry items are fetched from
 * (the `gh:anolilab/lunora/…` base). Branch → commit-SHA pinning resolves against
 * this repo's API; a custom `--source` pointing elsewhere is left unpinned.
 */
const SOURCE_REPO = "anolilab/lunora";

/** A 40-hex git commit SHA — already immutable, so it is never re-resolved. */
const COMMIT_SHA = /^[0-9a-f]{40}$/iu;

/**
 * The SemVer version body the release tooling emits: `MAJOR.MINOR.PATCH` plus an
 * optional dotted `channel.counter` pre-release (`-alpha.1`, `-next.5`) and
 * optional build metadata. The pre-release requires the dotted form the tooling
 * produces, so a bare single-identifier suffix like `-latest` (a MOVING alias,
 * never a fixed tag) is deliberately NOT matched.
 */
const SEMVER_BODY = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)+)?(?:\+[0-9A-Za-z.-]+)?`;

/**
 * A leading-`v` or bare SemVer version tag (`v1.2.3`, `1.0.0-alpha.1`) — points at
 * a fixed commit. Anchored to the WHOLE ref so a moving branch that merely begins
 * with a version (`v1.2.3-latest`) is not mistaken for an immutable tag.
 */
const LEADING_VERSION_TAG = new RegExp(String.raw`^v?${SEMVER_BODY}$`, "u");

/**
 * The release tooling's per-package tag form (`@lunora/cli@1.2.3`,
 * `lunorash@1.0.0-alpha.1`) — also a fixed commit. Anchored to the WHOLE ref
 * (an optional `@scope/`, a package name, `@`, then the version) so a branch that
 * merely embeds a `@x.y.z` span (`feature/@1.2.3/foo`) is not treated as immutable.
 */
const PACKAGE_VERSION_TAG = new RegExp(String.raw`^(?:@[\w.-]+\/)?[\w.-]+@${SEMVER_BODY}$`, "u");

/**
 * True when `ref` is already immutable — a full commit SHA or a version tag — so
 * it never needs to be re-resolved to a commit. The version-tag patterns are
 * full-string anchored, so a moving branch that only starts with / embeds a
 * version (e.g. `v1.2.3-latest`, `feature/@1.2.3/foo`) is still pinned to a SHA.
 */
const isImmutableRef = (ref: string): boolean => COMMIT_SHA.test(ref) || LEADING_VERSION_TAG.test(ref) || PACKAGE_VERSION_TAG.test(ref);

/**
 * The `Authorization` header for the GitHub API, honouring `GITHUB_TOKEN` /
 * `GH_TOKEN` when present so CI / heavy users don't hit the 60/hr unauthenticated
 * rate limit. Absent → an empty header set (anonymous request, still fine).
 */
const githubAuthHeaders = (): Record<string, string> => {
    const token = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];

    return token !== undefined && token.length > 0 ? { authorization: `Bearer ${token}` } : {};
};

/**
 * Resolve a branch name to the commit SHA it currently points at, via the GitHub
 * commits API. Best-effort: returns `undefined` on any failure (offline, 404,
 * rate-limited, malformed body, timeout) so the caller can fall back to the
 * moving branch. Uses `fetch` (Node 22/24 global) — no new dependency.
 */
const fetchBranchSha = async (branch: string, repo: string = SOURCE_REPO): Promise<string | undefined> => {
    try {
        // Encode the ref as a single path segment. GitHub's `GET /repos/{o}/{r}/commits/{ref}`
        // accepts a slash-containing ref percent-encoded (`feat/x` → `feat%2Fx`), and encoding
        // keeps a ref with other special characters from breaking out of the URL path.
        const response = await fetch(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(branch)}`, {
            headers: { accept: "application/vnd.github+json", "user-agent": "lunora-cli", ...githubAuthHeaders() },
            signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
            return undefined;
        }

        const body = (await response.json()) as { sha?: unknown };

        // Only accept a well-formed 40-hex SHA — anything else can't be trusted
        // as a pin (and would fail the `isSafeRef` charset gate downstream).
        return typeof body.sha === "string" && COMMIT_SHA.test(body.sha) ? body.sha : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Pin a moving branch to the immutable commit SHA it currently points at, so a
 * remote template / registry / base fetch is reproducible and tamper-evident
 * (supply-chain hardening).
 *
 * An already-immutable ref — a 40-hex SHA or a version tag
 * ({@link isImmutableRef}) — is returned verbatim; no API call is made.
 * Otherwise the branch is resolved to its current SHA via the GitHub API and
 * that SHA (which still passes the `isSafeRef` charset gate) is fetched instead;
 * the pin is logged so the user can audit it. If resolution fails (offline /
 * rate-limited / air-gapped), the branch is used with a one-line warning that
 * the fetch is UNPINNED — never a hard fail.
 *
 * `repo` is a parameter because `lunora init --vite` scaffolds its base out of
 * `vitejs/vite`, not the Lunora repo — a third-party moving branch is exactly
 * the fetch that most wants a logged, auditable SHA.
 */
const resolvePinnedRepoRef = async (repo: string, branch: string, logger: Logger): Promise<string> => {
    if (isImmutableRef(branch)) {
        return branch;
    }

    const sha = await fetchBranchSha(branch, repo);

    if (sha === undefined) {
        logger.warn(`could not pin ${repo}#${branch} to a commit — fetching the UNPINNED branch (set GITHUB_TOKEN if rate-limited).`);

        return branch;
    }

    logger.info(`pinned ${repo}#${branch} → ${sha}`);

    return sha;
};

/**
 * Pin the Lunora repo's source ref: {@link resolvePinnedRepoRef} bound to
 * {@link SOURCE_REPO}, with the ref derived by {@link resolveSourceRef} (an
 * explicit `--ref`, else the version-derived release branch).
 */
const resolvePinnedSourceRef = async (ref: string | undefined, logger: Logger): Promise<string> =>
    resolvePinnedRepoRef(SOURCE_REPO, resolveSourceRef(ref), logger);

/**
 * The immutable git tag the release tooling cuts for the running CLI's own
 * version (`@lunora/cli@1.0.0-alpha.157`).
 *
 * `lunora sdk generate` fetches the vendored transport at this ref rather than at
 * a release branch. The transport implements the wire protocol the CLI's emitter
 * generates calls against, so pinning them to one commit is what makes a
 * regeneration an upgrade: a newer CLI brings a newer transport, and the pair is
 * always the vintage that was released together. A branch would instead hand a
 * six-month-old CLI whatever the protocol looks like today.
 *
 * `version` is injectable so a test can assert the tag shape without being
 * pinned to whatever version the checkout happens to carry.
 */
const resolveCliVersionRef = (version: string = resolveCliVersion()): string => `@lunora/cli@${version}`;

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
 *
 * `version` defaults to the running CLI's own version; tests inject a version
 * to verify the mapping for channels the checked-out CLI isn't currently on
 * (e.g. that a stable `1.0.0` CLI pins scaffolds to `latest`, not `alpha`).
 */
const resolveDistTag = (version: string = resolveCliVersion()): string => {
    const ref = resolveVersionRef(version);

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
        const response = await fetch(`${registryBase()}/${packageName.replaceAll("/", "%2F")}`, {
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

export {
    isImmutableRef,
    resolveCliVersion,
    resolveCliVersionRef,
    resolveDistTag,
    resolvePinnedRepoRef,
    resolvePinnedSourceRef,
    resolveSourceRef,
    resolveTagVersion,
    resolveTagVersions,
    resolveVersionRef,
};
