/**
 * `/_lunora/admin/tokens` — create, list and revoke named admin tokens.
 *
 * Root-only: the static admin token or an `adminGate` grant. A named token can
 * use the admin plane but cannot manage tokens, or one leaked token could mint
 * its own replacements and outlive its revocation.
 *
 * The secret is generated and hashed here, at the worker; the store (the
 * default shard) only ever receives the digest, and the create response is the
 * one place the secret appears.
 */
import { digestAdminTokenSecret, generateAdminToken, isValidAdminTokenName } from "../../../shared/admin-token";
import type { AdminRevocations } from "./admin-revocations";
import { LunoraError } from "./errors";

const ADMIN_TOKENS_PATH = "/_lunora/admin/tokens";

const CREATE_ADMIN_TOKEN_OP = "__lunora_admin__:createAdminToken";
const LIST_ADMIN_TOKENS_OP = "__lunora_admin__:listAdminTokens";
const REVOKE_ADMIN_TOKEN_OP = "__lunora_admin__:revokeAdminToken";

interface AdminTokenRouteDeps {
    /** Throw `ADMIN_FORBIDDEN` / `ADMIN_ROOT_REQUIRED` unless the caller holds root admin authority. */
    assertRootAdmin: (request: Request) => void;
    /** Run a token-store op on the default shard under the root token; throws the shard's error. */
    callStore: (functionPath: string, args: Record<string, unknown>) => Promise<unknown>;
    /** Forget this isolate's cached answers for a token name, on revoke and on create. */
    evict: (name: string) => void;

    now?: () => number;
    readJsonBody: (request: Request) => Promise<Record<string, unknown>>;

    /**
     * Where a revocation is recorded outside the token store, so restoring that store cannot revive
     * the token. Absent when the app binds none, in which case no token can be created.
     */
    revocations: AdminRevocations | undefined;
}

/** One named admin token as `GET /_lunora/admin/tokens` lists it. The secret is never listed. */
interface AdminTokenSummary {
    /** Epoch ms. */
    createdAt: number;
    /** Epoch ms after which the token is refused; absent for a token that never expires. */
    expiresAt?: number;
    /** Epoch ms of the last verified use, refreshed at most once a minute. */
    lastUsedAt?: number;
    name: string;

    /**
     * Present and `true` when the token is revoked but its row is still stored, so it still holds the
     * name: revoke it again to clear the row. A revoked token is refused regardless.
     */
    revoked?: boolean;
}

/** The answer to `POST /_lunora/admin/tokens` — the only response that ever carries the secret. */
interface CreatedAdminToken {
    createdAt: number;
    expiresAt?: number;
    name: string;
    /** The bearer, `lnat.<name>.<secret>`. Shown once; store it now. */
    token: string;
}

const NO_STORE = { "cache-control": "no-store" };

const requireName = (name: unknown): string => {
    if (typeof name !== "string" || !isValidAdminTokenName(name)) {
        throw new LunoraError("admin token `name` must match /^[a-z0-9][a-z0-9_-]{0,63}$/", { code: "BAD_REQUEST", status: 400 });
    }

    return name;
};

const buildAdminTokenRoutes = (deps: AdminTokenRouteDeps): Record<string, (request: Request) => Promise<Response>> => {
    const now = deps.now ?? Date.now;

    const create = async (request: Request): Promise<Response> => {
        const body = await deps.readJsonBody(request);
        const name = requireName(body.name);
        const { expiresAt } = body;

        if (expiresAt !== undefined && (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= now())) {
            throw new LunoraError("admin token `expiresAt` must be a future epoch-ms number", { code: "BAD_REQUEST", status: 400 });
        }

        // A token that cannot be reliably revoked must not exist: refuse before minting one.
        if (deps.revocations === undefined) {
            throw new LunoraError(
                'named admin tokens need the ADMIN_REVOCATIONS Durable Object binding; export AdminRevocationDO from the worker entry (`export { AdminRevocationDO } from "./lunora/_generated/adminRevocations.js"`) and bind it',
                { code: "ADMIN_TOKEN_NOT_CONFIGURED", status: 400 },
            );
        }

        const { secret, token } = generateAdminToken(name);
        // The issuance's identity is its createdAt. It must sit past every one already revoked under this
        // name, or a token re-created in the revoked one's millisecond would inherit its revocation.
        const revoked = await deps.revocations.revokedAt(name);
        // A loop, not Math.max(...revoked): the history is never trimmed and a spread of it can overflow the stack.
        let createdAt = now();

        for (const earlier of revoked) {
            createdAt = Math.max(createdAt, earlier + 1);
        }

        const stored = (await deps.callStore(CREATE_ADMIN_TOKEN_OP, { createdAt, digest: await digestAdminTokenSecret(secret), expiresAt, name })) as Record<
            string,
            unknown
        >;

        deps.evict(name);

        return Response.json({ ...stored, token }, { headers: NO_STORE, status: 201 });
    };

    // A token the revocation store holds is refused whatever its row says. It stays listed, flagged, because
    // its row can outlive the revocation (a restore brought it back, or deleting it failed after the
    // revocation was recorded) and still holds the name until a revoke clears it.
    const list = async (): Promise<Response> => {
        const { revocations } = deps;

        // Without the store every named token is refused, so a plain list would show unusable tokens as live.
        if (revocations === undefined) {
            throw new LunoraError(
                "no admin revocation store is bound, so named admin tokens are refused; export AdminRevocationDO and bind ADMIN_REVOCATIONS",
                {
                    code: "ADMIN_TOKEN_NOT_CONFIGURED",
                    status: 400,
                },
            );
        }

        const { tokens } = (await deps.callStore(LIST_ADMIN_TOKENS_OP, {})) as { tokens: AdminTokenSummary[] };
        const checked = await Promise.all(
            tokens.map(async (token): Promise<AdminTokenSummary> => {
                const revoked = await revocations.revokedAt(token.name);

                return revoked.includes(token.createdAt) ? { ...token, revoked: true } : token;
            }),
        );

        return Response.json({ tokens: checked }, { headers: NO_STORE });
    };

    const revoke = async (request: Request): Promise<Response> => {
        const name = requireName(new URL(request.url).searchParams.get("name") ?? undefined);

        if (deps.revocations === undefined) {
            throw new LunoraError("no admin revocation store is bound, so no named admin token can exist", { code: "ADMIN_TOKEN_NOT_CONFIGURED", status: 400 });
        }

        const { tokens } = (await deps.callStore(LIST_ADMIN_TOKENS_OP, {})) as { tokens: AdminTokenSummary[] };
        const issued = tokens.find((token) => token.name === name);

        if (issued === undefined) {
            throw new LunoraError(`no admin token named "${name}"`, { code: "NOT_FOUND", status: 404 });
        }

        try {
            // First, and its failure is the revoke's failure: the system never reports a token
            // revoked that the outside store would still honour once the token table is rewound.
            await deps.revocations.revoke(name, issued.createdAt);
            await deps.callStore(REVOKE_ADMIN_TOKEN_OP, { createdAt: issued.createdAt, name });
        } finally {
            // Once the outside record landed the token is revoked whatever happens next.
            deps.evict(name);
        }

        return Response.json({ revoked: true }, { headers: NO_STORE });
    };

    return {
        [ADMIN_TOKENS_PATH]: async (request) => {
            deps.assertRootAdmin(request);

            if (request.method === "GET") {
                return list();
            }

            if (request.method === "POST") {
                return create(request);
            }

            if (request.method === "DELETE") {
                return revoke(request);
            }

            return new Response(undefined, { headers: { allow: "GET, POST, DELETE" }, status: 405 });
        },
    };
};

export { ADMIN_TOKENS_PATH, buildAdminTokenRoutes };
export type { AdminTokenRouteDeps, AdminTokenSummary, CreatedAdminToken };
