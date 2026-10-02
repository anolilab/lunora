/**
 * The action-only Artifacts client over the Cloudflare Artifacts binding.
 *
 * Every call is remote, billed network I/O, so the generated ctx wires this onto
 * **ActionCtx only** (the `ctx.images` precedent). The wrapper adds three things
 * the raw binding lacks: an `ArtifactsError` → `LunoraError` mapping, a
 * `withRepo` that owns the repo handle's disposal, and `authenticatedRemote`.
 * Everything else passes straight through — in particular `readFile` /
 * `readBlob` hand the binding's `Blob` back untouched, never buffered.
 */
import type { LunoraErrorCode } from "@lunora/errors";
import { LunoraError } from "@lunora/errors";

import { authenticatedRemote } from "./remote";
import type {
    ArtifactsBindingLike,
    ArtifactsClient,
    ArtifactsErrorCode,
    ArtifactsErrorData,
    ArtifactsRepoClient,
    ArtifactsRepoLike,
    LunoraArtifactsOptions,
} from "./types";

/**
 * How each binding error code surfaces. A conflict with a repo that exists or
 * is still being created/imported/forked is `CONFLICT` (retriable later); a
 * malformed argument is `BAD_REQUEST`; a remote that wants credentials is
 * `FORBIDDEN`; service-side and upstream failures are `INTERNAL`.
 */
const ERROR_CODE_MAP: Readonly<Record<ArtifactsErrorCode, LunoraErrorCode>> = {
    ALREADY_EXISTS: "CONFLICT",
    CREATE_IN_PROGRESS: "CONFLICT",
    FORK_IN_PROGRESS: "CONFLICT",
    IMPORT_IN_PROGRESS: "CONFLICT",
    INTERNAL_ERROR: "INTERNAL",
    INVALID_INPUT: "BAD_REQUEST",
    INVALID_REPO_NAME: "BAD_REQUEST",
    INVALID_TTL: "BAD_REQUEST",
    INVALID_URL: "BAD_REQUEST",
    MEMORY_LIMIT: "INTERNAL",
    NOT_FOUND: "NOT_FOUND",
    REMOTE_AUTH_REQUIRED: "FORBIDDEN",
    UPSTREAM_UNAVAILABLE: "INTERNAL",
};

/**
 * Recognise an `ArtifactsError` and pick the `LunoraError` code it maps to.
 * Matched structurally, not by class: the error crosses an RPC boundary, so
 * there is no constructor to `instanceof` against. A known `code` is enough; an
 * unknown code counts only when the error also names itself `ArtifactsError` (a
 * code the service added after this table) and maps to `INTERNAL`.
 */
const asArtifactsError = (error: unknown): { data: ArtifactsErrorData; lunoraCode: LunoraErrorCode } | undefined => {
    if (typeof error !== "object" || error === null) {
        return undefined;
    }

    const { code, name, numericCode } = error as { code?: unknown; name?: unknown; numericCode?: unknown };

    if (typeof code !== "string") {
        return undefined;
    }

    const lunoraCode: LunoraErrorCode | undefined = Object.hasOwn(ERROR_CODE_MAP, code) ? ERROR_CODE_MAP[code as ArtifactsErrorCode] : undefined;

    if (lunoraCode === undefined && name !== "ArtifactsError") {
        return undefined;
    }

    return { data: typeof numericCode === "number" ? { code, numericCode } : { code }, lunoraCode: lunoraCode ?? "INTERNAL" };
};

/**
 * Rethrow an `ArtifactsError` as a `LunoraError`, keeping the binding's codes in
 * `data`. The binding's own message is NOT copied into ours — it stays reachable
 * as `cause` for server-side debugging, but nothing the service echoes (a repo
 * name, a token) is put on the wire by us. Anything else is rethrown untouched.
 */
const mapArtifactsError = (operation: string, error: unknown): unknown => {
    const artifactsError = asArtifactsError(error);

    if (artifactsError === undefined) {
        return error;
    }

    const { data, lunoraCode } = artifactsError;

    return new LunoraError(lunoraCode, `@lunora/bindings/artifacts: ${operation} failed (${data.code})`, { cause: error, data });
};

/** Run one binding call under the error mapping. */
const call = async <T>(operation: string, run: () => Promise<T>): Promise<T> => {
    try {
        return await run();
    } catch (error: unknown) {
        throw mapArtifactsError(operation, error);
    }
};

/** Release a repo handle. Tolerates a runtime or double without `Symbol.dispose`. */
const disposeRepo = (repo: ArtifactsRepoLike): void => {
    if (typeof Symbol.dispose !== "symbol") {
        return;
    }

    repo[Symbol.dispose]?.();
};

const wrapRepo = (repo: ArtifactsRepoLike): ArtifactsRepoClient => {
    return {
        createToken: async (scope, ttl) => call("createToken", async () => repo.createToken(scope, ttl)),
        fork: async (name, options) => call("fork", async () => repo.fork(name, options)),
        info: async () => call("info", async () => repo.info()),
        listTokens: async () => call("listTokens", async () => repo.listTokens()),
        log: async (options) => call("log", async () => repo.log(options)),
        readBlob: async (hash) => call("readBlob", async () => repo.readBlob(hash)),
        readCommit: async (hash) => call("readCommit", async () => repo.readCommit(hash)),
        readFile: async (args) => call("readFile", async () => repo.readFile(args)),
        readTree: async (hash) => call("readTree", async () => repo.readTree(hash)),
        revokeToken: async (tokenOrId) => call("revokeToken", async () => repo.revokeToken(tokenOrId)),
    };
};

const withRepoOver =
    (binding: ArtifactsBindingLike): ArtifactsClient["withRepo"] =>
    async <T>(name: string, callback: (repo: ArtifactsRepoClient) => Promise<T> | T): Promise<T> => {
        const repo = await call("get", async () => binding.get(name));

        try {
            return await callback(wrapRepo(repo));
        } finally {
            disposeRepo(repo);
        }
    };

/**
 * Build the action-only {@link ArtifactsClient} over an Artifacts binding.
 *
 * ```ts
 * const artifacts = createArtifacts({ binding: env.ARTIFACTS });
 * const readme = await artifacts.withRepo("docs", (repo) => repo.readFile({ ref: "main", path: "README.md" }));
 * ```
 */
// eslint-disable-next-line import/prefer-default-export -- named export: the subpath barrel re-exports by name, per the repo's no-default-mixing convention
export const createArtifacts = (options: LunoraArtifactsOptions): ArtifactsClient => {
    const { binding } = options;
    const withRepo = withRepoOver(binding);

    return {
        authenticatedRemote,
        create: async (name, createOptions) => call("create", async () => binding.create(name, createOptions)),
        delete: async (name) => call("delete", async () => binding.delete(name)),
        import: async (params) => call("import", async () => binding.import(params)),
        info: async (name) => withRepo(name, async (repo) => repo.info()),
        list: async (listOptions) => call("list", async () => binding.list(listOptions)),
        withRepo,
    };
};
