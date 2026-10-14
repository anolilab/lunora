/**
 * An in-memory double for the Cloudflare Artifacts binding (`env.ARTIFACTS`).
 *
 * miniflare has no Artifacts simulator — its plugin only proxies to the remote
 * service — so a unit test that wants `ctx.artifacts` without an authenticated
 * account passes this to `createArtifacts({ binding })` (or as the generated
 * `.artifacts()` override). Like the real binding it cannot write files: tests
 * stage content with the `put*` seeding helpers, standing in for a `git push`.
 *
 * History is one linear list of commits (`putCommit`), not a graph with
 * branches: `log({ ref })` honours a commit id (history from that commit, `[]`
 * when unknown) and reads the whole list for a branch or tag name.
 */
/* eslint-disable unicorn/no-null -- the Artifacts binding's contract uses `null` (an unset description, a never-pushed repo, a missing object from the read methods); the fake has to return the same values */
/* eslint-disable @typescript-eslint/require-await -- every binding method is an RPC that settles asynchronously and reports failure as a rejection; the in-memory bodies are synchronous, and `async` is what turns their throws into rejections */
import type {
    ArtifactsBindingLike,
    ArtifactsCommitMetadata,
    ArtifactsCreateRepoResult,
    ArtifactsCreateTokenResult,
    ArtifactsErrorCode,
    ArtifactsRepoInfo,
    ArtifactsRepoLike,
    ArtifactsTokenInfo,
    ArtifactsTokenScope,
    ArtifactsTreeEntry,
} from "@lunora/bindings/artifacts";

/** The REST `errors[].code` each documented binding code carries. */
const NUMERIC_CODES: Partial<Record<ArtifactsErrorCode, number>> = {
    ALREADY_EXISTS: 10_201,
    FORK_IN_PROGRESS: 10_303,
    IMPORT_IN_PROGRESS: 10_302,
    INTERNAL_ERROR: 10_400,
    INVALID_INPUT: 10_100,
    INVALID_REPO_NAME: 10_101,
    INVALID_TTL: 10_103,
    INVALID_URL: 10_104,
    MEMORY_LIMIT: 10_402,
    NOT_FOUND: 10_200,
    REMOTE_AUTH_REQUIRED: 10_106,
    UPSTREAM_UNAVAILABLE: 10_401,
};

/** A full, lowercase SHA-1 object id — how `log()` tells a commit-id ref from a branch or tag name. */
const COMMIT_ID_PATTERN = /^[\da-f]{40}$/;

/** The fake's `list()` cursor: a decimal offset into the namespace. */
const DECIMAL_CURSOR_PATTERN = /^\d+$/;

/** The binding's public naming rule: a letter or digit, then letters, digits, `.`, `_` or `-`. */
const REPO_NAME_PATTERN = /^[a-z\d][\w.-]*$/i;

const MIN_TOKEN_TTL_SECONDS = 60;
const MAX_TOKEN_TTL_SECONDS = 31_536_000;
const DEFAULT_TOKEN_TTL_SECONDS = 86_400;

/**
 * Build the error the fake throws, in the shape the binding's errors reach a
 * Worker: over RPC there is no `ArtifactsError` class to `instanceof`, only an
 * `Error` named `ArtifactsError` carrying the binding's `code` and
 * `numericCode`. These are the binding's own codes, not `LunoraError` codes —
 * `createArtifacts` maps them, which is what a test using the fake exercises.
 */
const artifactsError = (code: ArtifactsErrorCode, message: string): Error & { code: ArtifactsErrorCode; numericCode: number | undefined } =>
    Object.assign(new Error(message), { code, name: "ArtifactsError", numericCode: NUMERIC_CODES[code] });

interface FakeToken {
    info: ArtifactsTokenInfo;
    plaintext: string;
}

interface FakeRepo {
    blobs: Map<string, Blob>;
    commits: ArtifactsCommitMetadata[];
    /** Files keyed `${ref}:${path}`. */
    files: Map<string, Blob>;
    info: ArtifactsRepoInfo;
    tokens: Map<string, FakeToken>;
    trees: Map<string, ArtifactsTreeEntry[]>;
}

/** Test controls returned alongside the fake binding. */
interface ArtifactsFake {
    /** The fake `env.ARTIFACTS` binding. */
    binding: ArtifactsBindingLike;
    /** Make the next binding or repo call throw an `ArtifactsError` with `code` (e.g. `UPSTREAM_UNAVAILABLE`). */
    failNext: (code: ArtifactsErrorCode) => void;
    /** How many repo handles `get()` has handed out and how many were disposed — a leak shows as `opened > disposed`. */
    readonly handles: { disposed: number; opened: number };
    /** Stage a blob by object id. Returns the stored `Blob` (the exact instance `readBlob` hands back). */
    putBlob: (repo: string, hash: string, content: Blob | string) => Blob;
    /** Append a commit to the repo's history (newest first in `log()`), readable by `readCommit`. */
    putCommit: (repo: string, commit: ArtifactsCommitMetadata) => void;
    /** Stage a file at a ref, standing in for a push. Returns the stored `Blob` (the exact instance `readFile` hands back). */
    putFile: (repo: string, file: { content: Blob | string; path: string; ref: string; type?: string }) => Blob;
    /** Stage a tree by object id. */
    putTree: (repo: string, hash: string, entries: ArtifactsTreeEntry[]) => void;
    /** The repo names currently in the namespace. */
    repoNames: () => string[];
}

const toBlob = (content: Blob | string, type = ""): Blob => (typeof content === "string" ? new Blob([content], { type }) : content);

/**
 * Build an in-memory Artifacts binding plus seeding and inspection controls.
 *
 * ```ts
 * const fake = createArtifactsFake({ namespace: "default" });
 * const artifacts = createArtifacts({ binding: fake.binding });
 * await artifacts.create("docs");
 * fake.putFile("docs", { ref: "main", path: "README.md", content: "# hi" });
 * ```
 */
const createArtifactsFake = (options: { namespace?: string } = {}): ArtifactsFake => {
    const namespace = options.namespace ?? "default";
    const repos = new Map<string, FakeRepo>();
    const handles = { disposed: 0, opened: 0 };
    let pendingFailure: ArtifactsErrorCode | undefined;
    let sequence = 0;

    const nextId = (prefix: string): string => {
        sequence += 1;

        return `${prefix}${String(sequence).padStart(6, "0")}`;
    };

    /** Throw the queued failure, once. Every binding and repo method calls this first. */
    const checkFailure = (): void => {
        if (pendingFailure !== undefined) {
            const code = pendingFailure;

            pendingFailure = undefined;

            throw artifactsError(code, `injected ${code}`);
        }
    };

    const requireRepo = (name: string): FakeRepo => {
        const repo = repos.get(name);

        if (repo === undefined) {
            throw artifactsError("NOT_FOUND", `repository "${name}" does not exist`);
        }

        return repo;
    };

    const mintToken = (repo: FakeRepo, scope: ArtifactsTokenScope, ttlSeconds: number): ArtifactsCreateTokenResult => {
        const id = nextId("tok");
        const now = Date.now();
        const expiresAt = new Date(now + ttlSeconds * 1000).toISOString();
        // The real token carries an `?expires=` suffix; keeping it here exercises
        // `authenticatedRemote`'s strip in any test that builds a remote.
        const plaintext = `art_fake_${id}?expires=${String(Math.floor(now / 1000) + ttlSeconds)}`;

        repo.tokens.set(id, { info: { createdAt: new Date(now).toISOString(), expiresAt, id, scope, state: "active" }, plaintext });

        return { expiresAt, id, plaintext, scope };
    };

    const addRepo = (
        name: string,
        settings: { defaultBranch?: string; description?: string; readOnly?: boolean; source?: string },
    ): ArtifactsCreateRepoResult => {
        if (!REPO_NAME_PATTERN.test(name)) {
            throw artifactsError("INVALID_REPO_NAME", `invalid repository name "${name}"`);
        }

        if (repos.has(name)) {
            throw artifactsError("ALREADY_EXISTS", `repository "${name}" already exists`);
        }

        const now = new Date().toISOString();
        const info: ArtifactsRepoInfo = {
            createdAt: now,
            defaultBranch: settings.defaultBranch ?? "main",
            description: settings.description ?? null,
            id: nextId("repo"),
            lastPushAt: null,
            name,
            readOnly: settings.readOnly ?? false,
            remote: `https://artifacts.fake.test/${namespace}/${name}.git`,
            source: settings.source ?? null,
            updatedAt: now,
        };
        const repo: FakeRepo = { blobs: new Map(), commits: [], files: new Map(), info, tokens: new Map(), trees: new Map() };

        repos.set(name, repo);

        const { plaintext } = mintToken(repo, "write", DEFAULT_TOKEN_TTL_SECONDS);

        return { defaultBranch: info.defaultBranch, description: info.description, id: info.id, name, remote: info.remote, token: plaintext };
    };

    const openHandle = (repo: FakeRepo): ArtifactsRepoLike => {
        handles.opened += 1;

        /** Throw the queued failure, then `NOT_FOUND` once the repo was deleted (or replaced by a same-named one) — as the binding does for a stale handle. */
        const checkLive = (): void => {
            checkFailure();

            if (repos.get(repo.info.name) !== repo) {
                throw artifactsError("NOT_FOUND", `repository "${repo.info.name}" does not exist`);
            }
        };

        return {
            [Symbol.dispose]: () => {
                handles.disposed += 1;
            },
            createToken: async (scope = "write", ttl = DEFAULT_TOKEN_TTL_SECONDS) => {
                checkLive();

                if (!Number.isInteger(ttl) || ttl < MIN_TOKEN_TTL_SECONDS || ttl > MAX_TOKEN_TTL_SECONDS) {
                    throw artifactsError("INVALID_TTL", `ttl must be between ${String(MIN_TOKEN_TTL_SECONDS)} and ${String(MAX_TOKEN_TTL_SECONDS)}`);
                }

                return mintToken(repo, scope, ttl);
            },
            fork: async (name, forkOptions) => {
                checkLive();

                const created = addRepo(name, {
                    defaultBranch: repo.info.defaultBranch,
                    description: forkOptions?.description,
                    readOnly: forkOptions?.readOnly,
                    source: `artifacts:${namespace}/${repo.info.name}`,
                });
                const forked = requireRepo(name);
                const defaultBranchOnly = forkOptions?.defaultBranchOnly ?? true;

                for (const [key, blob] of repo.files) {
                    if (!defaultBranchOnly || key.startsWith(`${repo.info.defaultBranch}:`)) {
                        forked.files.set(key, blob);
                    }
                }

                // Objects are content-addressed, so the fork shares every blob and tree; the
                // one linear history is the default branch's, copied either way.
                for (const [hash, blob] of repo.blobs) {
                    forked.blobs.set(hash, blob);
                }

                for (const [hash, entries] of repo.trees) {
                    forked.trees.set(hash, entries);
                }

                forked.commits.push(...repo.commits);

                return created;
            },
            info: async () => {
                checkLive();

                return { ...repo.info };
            },
            listTokens: async () => {
                checkLive();

                const tokens = [...repo.tokens.values()].map((token) => {
                    return { ...token.info };
                });

                return { tokens, total: tokens.length };
            },
            log: async (logOptions) => {
                checkLive();

                const offset = logOptions?.offset ?? 0;
                const limit = Math.min(logOptions?.limit ?? 50, 1000);
                const ref = logOptions?.ref;
                let start = 0;

                if (ref !== undefined && COMMIT_ID_PATTERN.test(ref)) {
                    start = repo.commits.findIndex((commit) => commit.hash === ref);

                    if (start === -1) {
                        return [];
                    }
                }

                return repo.commits.slice(start + offset, start + offset + limit);
            },
            readBlob: async (hash) => {
                checkLive();

                return repo.blobs.get(hash) ?? null;
            },
            readCommit: async (hash) => {
                checkLive();

                return repo.commits.find((commit) => commit.hash === hash) ?? null;
            },
            readFile: async ({ path, ref }) => {
                checkLive();

                if (ref === "" || path === "") {
                    throw artifactsError("INVALID_INPUT", "ref and path must be non-empty");
                }

                return repo.files.get(`${ref}:${path}`) ?? null;
            },
            readTree: async (hash) => {
                checkLive();

                return repo.trees.get(hash) ?? null;
            },
            revokeToken: async (tokenOrId) => {
                checkLive();

                if (tokenOrId === "") {
                    throw artifactsError("INVALID_INPUT", "tokenOrId must be non-empty");
                }

                const token = [...repo.tokens.values()].find((candidate) => candidate.info.id === tokenOrId || candidate.plaintext === tokenOrId);

                if (token?.info.state !== "active") {
                    return false;
                }

                token.info.state = "revoked";

                return true;
            },
        };
    };

    const binding: ArtifactsBindingLike = {
        create: async (name, createOptions) => {
            checkFailure();

            return addRepo(name, {
                defaultBranch: createOptions?.setDefaultBranch,
                description: createOptions?.description,
                readOnly: createOptions?.readOnly,
            });
        },
        delete: async (name) => {
            checkFailure();

            if (!REPO_NAME_PATTERN.test(name)) {
                throw artifactsError("INVALID_REPO_NAME", `invalid repository name "${name}"`);
            }

            // A repo's tokens go with it: none of them authenticates against a later same-named repo.
            repos.get(name)?.tokens.clear();

            return repos.delete(name);
        },
        get: async (name) => {
            checkFailure();

            return openHandle(requireRepo(name));
        },
        import: async ({ source, target }) => {
            checkFailure();

            if (!source.url.startsWith("https://")) {
                throw artifactsError("INVALID_INPUT", "source url must be https");
            }

            return addRepo(target.name, { description: target.opts?.description, readOnly: target.opts?.readOnly, source: source.url });
        },
        list: async (listOptions) => {
            checkFailure();

            // `list()` omits the remote, as the binding does.
            const all = [...repos.values()].map(({ info: { remote: _remote, ...listed } }): Omit<ArtifactsRepoInfo, "remote"> => listed);
            const cursor = listOptions?.cursor ?? "0";

            // The fake's cursor is a decimal offset; anything else is a cursor it never handed out.
            if (!DECIMAL_CURSOR_PATTERN.test(cursor)) {
                throw artifactsError("INVALID_INPUT", "invalid cursor");
            }

            const start = Number(cursor);

            const limit = listOptions?.limit ?? 50;
            const page = all.slice(start, start + limit);
            const next = start + limit;

            return next < all.length ? { cursor: String(next), repos: page, total: all.length } : { repos: page, total: all.length };
        },
    };

    return {
        binding,
        failNext: (code) => {
            pendingFailure = code;
        },
        handles,
        putBlob: (repo, hash, content) => {
            const blob = toBlob(content);

            requireRepo(repo).blobs.set(hash, blob);

            return blob;
        },
        putCommit: (repo, commit) => {
            const target = requireRepo(repo);

            target.commits.unshift(commit);
            target.info.lastPushAt = new Date().toISOString();
        },
        putFile: (repo, { content, path, ref, type }) => {
            const blob = toBlob(content, type ?? "text/plain;charset=utf-8");

            requireRepo(repo).files.set(`${ref}:${path}`, blob);

            return blob;
        },
        putTree: (repo, hash, entries) => {
            requireRepo(repo).trees.set(hash, entries);
        },
        repoNames: () => [...repos.keys()],
    };
};

export type { ArtifactsFake };
export { createArtifactsFake };
