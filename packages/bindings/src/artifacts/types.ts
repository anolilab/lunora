/**
 * Structural projections of the Cloudflare **Artifacts** binding (`env.ARTIFACTS`)
 * — a versioned file system that speaks Git. Namespaces hold repos; the binding
 * creates, imports, forks, lists and deletes them, mints repo-scoped Git tokens,
 * and READS commits, trees, blobs and files. It has no write method: every write
 * is a `git push` over HTTPS with one of those tokens.
 *
 * Declared structurally (the `ImagesBindingLike` pattern) rather than leaning on
 * the global `Artifacts` type, because the pinned `@cloudflare/workers-types`
 * lags the runtime: it lacks `info()`, `log()`, `readCommit()`, `readTree()`,
 * `readBlob()` and `readFile()`, and it models `ArtifactsRepo` as carrying its
 * metadata as properties, which the deployed binding does not do (call
 * `info()`). The shapes here follow the Workers-binding docs and
 * `@cloudflare/workers-types@5.20261002.1`, the first release that matches them.
 *
 * TODO(workers-types): once the catalog pin includes the read methods, add a
 * type test asserting the global `Artifacts` is assignable to
 * {@link ArtifactsBindingLike}.
 */

/** A repo-scoped Git token's scope: `read` covers clone/fetch/pull, `write` adds push. */
export type ArtifactsTokenScope = "read" | "write";

/** Current metadata for one repository, from `repo.info()`. */
export interface ArtifactsRepoInfo {
    /** ISO 8601 creation timestamp. */
    createdAt: string;
    /** Default branch name, e.g. `main`. */
    defaultBranch: string;
    /** Repository description, or `null` when unset. */
    description: string | null;
    /** Unique repository id. */
    id: string;
    /** ISO 8601 timestamp of the last push, or `null` when never pushed. */
    lastPushAt: string | null;
    /** Repository name. */
    name: string;
    /** Whether the repository is read-only. */
    readOnly: boolean;
    /** The HTTPS Git remote URL. */
    remote: string;
    /** Fork source (`github:owner/repo`, `artifacts:namespace/repo`), or `null` when not a fork. */
    source: string | null;
    /** ISO 8601 last-updated timestamp. */
    updatedAt: string;
}

/**
 * The result of `create()`, `import()` and `fork()`: the new repo plus an
 * initial Git token. `token` is a secret — never log it or return it to a client
 * that should not push.
 */
export interface ArtifactsCreateRepoResult {
    /** Default branch name. */
    defaultBranch: string;
    /** Repository description, or `null` when unset. */
    description: string | null;
    /** Unique repository id. */
    id: string;
    /** Repository name. */
    name: string;
    /** The HTTPS Git remote URL. */
    remote: string;
    /** Plaintext initial access token, returned only at creation time. */
    token: string;
}

/** One page of `list()`. */
export interface ArtifactsRepoListResult {
    /** Cursor for the next page; absent on the last page. */
    cursor?: string;
    /** The repos on this page (without `remote`). */
    repos: Omit<ArtifactsRepoInfo, "remote">[];
    /** Total number of repos in the namespace. */
    total: number;
}

/** A freshly minted Git token. `plaintext` is a secret. */
export interface ArtifactsCreateTokenResult {
    /** ISO 8601 expiry timestamp. */
    expiresAt: string;
    /** Unique token id — pass it to `revokeToken` instead of the plaintext where you can. */
    id: string;
    /** The Git token string, returned only at creation time. */
    plaintext: string;
    /** The token's scope. */
    scope: ArtifactsTokenScope;
}

/** Token metadata (never the plaintext). */
export interface ArtifactsTokenInfo {
    /** ISO 8601 creation timestamp. */
    createdAt: string;
    /** ISO 8601 expiry timestamp. */
    expiresAt: string;
    /** Unique token id. */
    id: string;
    /** The token's scope. */
    scope: ArtifactsTokenScope;
    /** Whether the token can still be used. */
    state: "active" | "expired" | "revoked";
}

/** The tokens minted for one repo. */
export interface ArtifactsTokenListResult {
    /** The tokens. */
    tokens: ArtifactsTokenInfo[];
    /** Total number of tokens for the repo. */
    total: number;
}

/** A Git tree entry's kind, derived from its mode. */
export type ArtifactsTreeEntryType = "blob" | "exec" | "gitlink" | "symlink" | "tree";

/** An immediate child of a Git tree, from `readTree()`. */
export interface ArtifactsTreeEntry {
    /** Lowercase, 40-character SHA-1 object id. */
    hash: string;
    /** Canonical Git mode, such as `100644` for a file or `40000` for a tree. */
    mode: string;
    /** Name relative to the tree being read. */
    name: string;
    /** Kind derived from `mode`. */
    type: ArtifactsTreeEntryType;
}

/** A Git identity on a commit. */
export interface ArtifactsCommitIdentity {
    email: string;
    name: string;
}

/** Decoded commit metadata, from `readCommit()` and `log()`. */
export interface ArtifactsCommitMetadata {
    /** The commit's author. */
    author: ArtifactsCommitIdentity;
    /** Author timestamp in Unix seconds. */
    authoredAt: number;
    /** Committer timestamp in Unix seconds. */
    committedAt: number;
    /** The commit's committer. */
    committer: ArtifactsCommitIdentity;
    /** Lowercase, 40-character SHA-1 commit id. */
    hash: string;
    /** Commit message with one trailing newline removed. */
    message: string;
    /** Parent commit ids in Git order; empty for a root commit. */
    parents: string[];
    /** SHA-1 id of the commit's root tree. */
    treeHash: string;
}

/** Options for `create()`. */
export interface ArtifactsCreateOptions {
    description?: string;
    readOnly?: boolean;
    /** The default branch name (the binding's `setDefaultBranch`). */
    setDefaultBranch?: string;
}

/** Options for `repo.fork()`. */
export interface ArtifactsForkOptions {
    /** Copy only the default branch. The binding defaults this to `true`. */
    defaultBranchOnly?: boolean;
    description?: string;
    readOnly?: boolean;
}

/** Parameters for `import()`: an external HTTPS Git remote and the repo it lands in. */
export interface ArtifactsImportParams {
    source: {
        /** Branch to import; defaults to the remote's default branch. */
        branch?: string;
        /** Shallow-clone depth. */
        depth?: number;
        /** HTTPS URL of the source repository. */
        url: string;
    };
    target: {
        name: string;
        opts?: { description?: string; readOnly?: boolean };
    };
}

/** Options for `list()`. */
export interface ArtifactsListOptions {
    cursor?: string;
    /** Page size, 1–200 (the binding defaults to 50). */
    limit?: number;
}

/** Options for `repo.log()`. */
export interface ArtifactsLogOptions {
    /** Page size; the binding defaults to 50 and caps at 1000. */
    limit?: number;
    offset?: number;
    /** Branch, tag or commit id; defaults to `HEAD`. */
    ref?: string;
}

/** Arguments for `repo.readFile()`. */
export interface ArtifactsReadFileArgs {
    /** Non-empty repository-relative path. */
    path: string;
    /** Branch, tag or commit id. */
    ref: string;
}

/**
 * The repo capability `binding.get(name)` returns: an RPC stub that has to be
 * disposed before the request ends. `Symbol.dispose` is optional here only so a
 * plain-object test double satisfies the shape; the real handle always has it.
 */
export interface ArtifactsRepoLike {
    [Symbol.dispose]?: () => void;

    /**
     * Mint a repo-scoped Git token. `ttl` is in seconds (60 to one year; the
     * binding defaults to 86,400). Keep write tokens short-lived and revoke them
     * when the session that needed them ends.
     */
    createToken: (scope?: ArtifactsTokenScope, ttl?: number) => Promise<ArtifactsCreateTokenResult>;
    /** Fork this repo into a new repo in the same namespace. */
    fork: (name: string, options?: ArtifactsForkOptions) => Promise<ArtifactsCreateRepoResult>;
    /** Fresh repository metadata. */
    info: () => Promise<ArtifactsRepoInfo>;
    /** Token metadata for this repo (never plaintext). */
    listTokens: () => Promise<ArtifactsTokenListResult>;
    /** First-parent history, newest first. An unresolvable ref yields `[]`. */
    log: (options?: ArtifactsLogOptions) => Promise<ArtifactsCommitMetadata[]>;
    /** A blob's raw bytes as an untyped `Blob` (returned unbuffered), or `null` when missing. */
    readBlob: (hash: string) => Promise<Blob | null>;
    /** One decoded commit, or `null` when missing. */
    readCommit: (hash: string) => Promise<ArtifactsCommitMetadata | null>;
    /** A file at a ref as a MIME-typed `Blob` (returned unbuffered), or `null` when the path is missing or a directory. */
    readFile: (args: ArtifactsReadFileArgs) => Promise<Blob | null>;
    /** A tree's immediate children, or `null` when missing. */
    readTree: (hash: string) => Promise<ArtifactsTreeEntry[] | null>;
    /** Revoke a token by id (preferred) or plaintext. `false` when it was not found. */
    revokeToken: (tokenOrId: string) => Promise<boolean>;
}

/** The namespace-level `env.ARTIFACTS` binding. */
export interface ArtifactsBindingLike {
    /** Create a repo. The first `create` against a missing namespace creates that namespace, unrestricted. */
    create: (name: string, options?: ArtifactsCreateOptions) => Promise<ArtifactsCreateRepoResult>;
    /** Delete a repo and its tokens. `false` when it did not exist. */
    delete: (name: string) => Promise<boolean>;
    /** Open a repo handle. It must be disposed of before the request ends — prefer `ArtifactsClient.withRepo`. */
    get: (name: string) => Promise<ArtifactsRepoLike>;
    /** Import a repo from an external HTTPS Git remote. */
    import: (params: ArtifactsImportParams) => Promise<ArtifactsCreateRepoResult>;
    /** One page of the namespace's repos. */
    list: (options?: ArtifactsListOptions) => Promise<ArtifactsRepoListResult>;
}

/** The `code` an `ArtifactsError` carries. */
export type ArtifactsErrorCode =
    | "ALREADY_EXISTS"
    | "CREATE_IN_PROGRESS"
    | "FORK_IN_PROGRESS"
    | "IMPORT_IN_PROGRESS"
    | "INTERNAL_ERROR"
    | "INVALID_INPUT"
    | "INVALID_REPO_NAME"
    | "INVALID_TTL"
    | "INVALID_URL"
    | "MEMORY_LIMIT"
    | "NOT_FOUND"
    | "REMOTE_AUTH_REQUIRED"
    | "UPSTREAM_UNAVAILABLE";

/** The `data` a mapped `LunoraError` carries: the binding's own codes, never its message. */
export interface ArtifactsErrorData {
    /** The binding's string code. */
    code: string;
    /** The binding's numeric code (matches the REST API's `errors[].code`), when it sent one. */
    numericCode?: number;
}

/** The repo operations, wrapped with the Lunora error mapping. Handed to {@link ArtifactsClient.withRepo}'s callback. */
export type ArtifactsRepoClient = Omit<ArtifactsRepoLike, typeof Symbol.dispose>;

/**
 * The action-only `ctx.artifacts` client: the binding's namespace operations,
 * with the raw `get` replaced by the disposing `withRepo`, plus two helpers.
 * Every call is a billed, remote operation, and every `ArtifactsError` is
 * rethrown as a `LunoraError` (see `createArtifacts`). It cannot write files —
 * push with a Git client using a token from `ArtifactsRepoClient.createToken`
 * and `authenticatedRemote`.
 */
export type ArtifactsClient = {
    /**
     * Build the `https://x:<token>@host/…` remote a Git client pushes to. Pure: no
     * I/O. With a write token the result is a push credential — never return it
     * from a public function, log it, or put it in a command argument.
     */
    authenticatedRemote: (remote: string, token: string) => string;
    /** Fresh metadata for one repo — shorthand for `withRepo(name, (repo) => repo.info())`. */
    info: (name: string) => Promise<ArtifactsRepoInfo>;

    /**
     * Open a repo handle, run `callback` with it, and dispose of the handle whether
     * `callback` returns or throws, so it cannot outlive the request. Use the
     * handle only inside `callback`.
     */
    withRepo: <T>(name: string, callback: (repo: ArtifactsRepoClient) => Promise<T> | T) => Promise<T>;
} & Omit<ArtifactsBindingLike, "get">;

/** Options for `createArtifacts`. */
export interface LunoraArtifactsOptions {
    /** The `env.ARTIFACTS` binding (wrangler `artifacts[]`). */
    binding: ArtifactsBindingLike;
}

/**
 * Envelope fields shared by every Artifacts Queues event (`eventSchemaVersion: 1`).
 * @experimental
 */
export interface ArtifactsEventMetadata {
    accountId: string;
    eventSchemaVersion: 1;
    eventSubscriptionId: string;
    eventTimestamp: string;
}

/** The repo-state payload the account-level lifecycle events carry. */
export interface ArtifactsRepoEventState {
    createdAt: string;
    defaultBranch: string;
    description: string | null;
    lastPushAt: string | null;
    readOnly: boolean;
    repoId: string;
    updatedAt: string;
}

/**
 * Envelope of an account-level event (source `artifacts`). For a fork, `source`
 * names the repo forked FROM; the payload names the new one.
 * @experimental
 */
export interface ArtifactsLifecycleEnvelope {
    metadata: ArtifactsEventMetadata;
    source: { namespace: string; repoName: string; type: "artifacts" };
}

/**
 * Envelope of a repo-level event (source `artifacts.repo`, subscribed per
 * namespace + repo).
 * @experimental
 */
export interface ArtifactsActivityEnvelope {
    metadata: ArtifactsEventMetadata;
    source: { namespace: string; repoName: string; type: "artifacts.repo" };
}

/** One commit in a `cf.artifacts.repo.pushed` payload. */
export interface ArtifactsPushedCommit {
    author: ArtifactsCommitIdentity;
    committer: ArtifactsCommitIdentity;
    id: string;
    message: string;
    messageTruncated: boolean;
    parents: string[];
    timestamp: string;
}

/**
 * An account-level repo lifecycle event: `created`, `deleted`, `forked` or
 * `imported`. Narrow on `type`.
 * @experimental
 */
export type ArtifactsRepoLifecycleEvent =
    | (ArtifactsLifecycleEnvelope & { payload: ArtifactsRepoEventState & { branch: string; sourceUrl: string }; type: "cf.artifacts.repo.imported" })
    | (ArtifactsLifecycleEnvelope & { payload: ArtifactsRepoEventState & { namespace: string; repoName: string }; type: "cf.artifacts.repo.forked" })
    | (ArtifactsLifecycleEnvelope & { payload: ArtifactsRepoEventState; type: "cf.artifacts.repo.created" })
    | (ArtifactsLifecycleEnvelope & { payload: ArtifactsRepoEventState; type: "cf.artifacts.repo.deleted" });

/**
 * A repo-level activity event: `pushed`, `cloned`, `fetched`,
 * `token.created` or `token.revoked`. Narrow on `type`. Token events carry the
 * token id, never the plaintext.
 * @experimental
 */
export type ArtifactsRepoActivityEvent =
    | (ArtifactsActivityEnvelope & {
          payload: {
              after: string;
              before: string;
              commits: ArtifactsPushedCommit[];
              commitsTruncated: boolean;
              ref: string;
              totalCommitsCount: number;
          };
          type: "cf.artifacts.repo.pushed";
      })
    | (ArtifactsActivityEnvelope & { payload: { expiresAt: string; scope: ArtifactsTokenScope; tokenId: string }; type: "cf.artifacts.repo.token.created" })
    | (ArtifactsActivityEnvelope & { payload: { tokenId: string }; type: "cf.artifacts.repo.token.revoked" })
    | (ArtifactsActivityEnvelope & { payload: Record<string, never>; type: "cf.artifacts.repo.cloned" })
    | (ArtifactsActivityEnvelope & { payload: Record<string, never>; type: "cf.artifacts.repo.fetched" });

/**
 * Any Artifacts event a Queue subscription delivers — type a `defineQueue`
 * consumer's messages with it and narrow on `type`.
 * @experimental
 */
export type ArtifactsEvent = ArtifactsRepoActivityEvent | ArtifactsRepoLifecycleEvent;
