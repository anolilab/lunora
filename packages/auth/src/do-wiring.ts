/**
 * The worker half of DO-backed auth: what `authHandler` and `resolveIdentity` become
 * when the auth tables live inside a Durable Object.
 *
 * ## Why this is a package function and not codegen output
 *
 * It used to be emitted inline by `@lunora/codegen` as a template string. Logic in a
 * template literal cannot be unit-tested — it is only ever typechecked after
 * generation, so a wrong header name or a mis-built URL compiles cleanly and fails in
 * production. Here it is ordinary code with ordinary tests, and codegen emits a call.
 * @experimental
 */
/* eslint-disable unicorn/no-null -- `resolveIdentity` is a runtime contract that returns `null` for an anonymous request; `undefined` would be a different signal */
import type { AuthAuditEntry, AuthAuditReader } from "./audit";
import { INTERNAL_SECRET_HEADER, READ_AUDIT_PATH, RESOLVE_SESSION_PATH } from "./auth-do";
import { DEFAULT_AUTH_BASE_PATH, isAuthRoutePath } from "./handler";

/** The slice of a Durable Object namespace this needs — structural, so tests need no runtime. */
export interface AuthNamespaceLike {
    get: (id: unknown) => { fetch: (request: Request) => Promise<Response> };
    idFromName: (name: string) => unknown;
}

/** What {@link createDoAuthWiring} needs, already resolved against `env`. */
export interface DoAuthWiringOptions {
    /** Base path the auth routes are served under. Defaults to `/api/auth`. */
    basePath?: string;

    /**
     * Shared secret presented on the object's internal session route. `undefined`
     * means identity resolution fails closed — see {@link DoAuthWiring.resolveIdentity}.
     */
    internalSecret: string | undefined;

    /** The bound namespace, or `undefined` when the binding is absent from `env`. */
    namespace: AuthNamespaceLike | undefined;

    /**
     * Name of the object instance holding the auth tables. Defaults to `"auth"`.
     *
     * One object owns the whole auth schema, so this exists to let an app pick the
     * name (or run separate objects per deployment/tenant) rather than being pinned to
     * a hardcoded one.
     */
    objectName?: string;
}

/** The worker options DO-backed auth replaces. */
export interface DoAuthWiring {
    /**
     * Reads the audit log out of the object, so the studio's audit feed works in DO
     * mode. Answers an empty page rather than throwing when the object is unreachable
     * or no secret is configured — an unavailable feed should read as empty, not 500
     * the studio.
     */
    auditReader: AuthAuditReader;

    /** Forwards `/api/auth/*` to the object; `undefined` for anything else. */
    authHandler: (request: Request) => Promise<Response | undefined>;

    /**
     * Resolves a request's identity by asking the object. `null` when anonymous,
     * unreachable, or ungated.
     *
     * `expiresAtMs` (epoch ms) is the session's expiry, which the runtime forwards as
     * the socket's credential expiry so the DO can drop a subscriber whose session has
     * lapsed; `role` is better-auth's `admin()` column, which RLS role grants read;
     * `email` and `name` are the profile claims `ctx.auth.getIdentity()` is documented
     * to carry. Each is absent when the session does not carry it.
     */
    resolveIdentity: (request: Request) => Promise<null | { email?: string; expiresAtMs?: number; name?: string; role?: string; userId: string }>;
}

/**
 * Build the worker-side wiring for an auth Durable Object.
 *
 * Every failure path answers "not authenticated" rather than throwing: this runs on
 * the request path for every request that touches `ctx.auth`, and a throw there would
 * turn a misconfiguration into a 500 on traffic that has nothing to do with auth.
 * @param options The resolved namespace, secret, and names.
 * @returns The `authHandler` / `resolveIdentity` pair.
 * @experimental
 */
export const createDoAuthWiring = (options: DoAuthWiringOptions): DoAuthWiring => {
    const { basePath = DEFAULT_AUTH_BASE_PATH, internalSecret, namespace, objectName = "auth" } = options;

    /** The object's stub, or `undefined` when the binding is missing. */
    const stub = (): undefined | { fetch: (request: Request) => Promise<Response> } => {
        if (!namespace) {
            return undefined;
        }

        return namespace.get(namespace.idFromName(objectName));
    };

    /**
     * POST a JSON body to one of the object's internal routes, with the secret header.
     * `undefined` when the call cannot be made or the object refused it.
     */
    const callInternal = async (path: string, origin: string, body: unknown): Promise<Response | undefined> => {
        if (!internalSecret) {
            return undefined;
        }

        const target = stub();

        if (!target) {
            return undefined;
        }

        const response = await target.fetch(
            new Request(new URL(path, origin), {
                body: JSON.stringify(body),
                headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: internalSecret },
                method: "POST",
            }),
        );

        return response.ok ? response : undefined;
    };

    return {
        auditReader: {
            read: async (readOptions) => {
                // No request in scope here (the studio calls this out of band), so the
                // origin is a placeholder the object never reads — only the path matters.
                const response = await callInternal(READ_AUDIT_PATH, "https://auth-do.invalid", readOptions);

                if (!response) {
                    return [];
                }

                const body: null | { entries?: AuthAuditEntry[] } = await response.json();

                return body?.entries ?? [];
            },
        },
        authHandler: async (request) => {
            // Only auth routes go to the object; everything else falls through to the
            // Lunora worker exactly as it does in D1 mode.
            if (!isAuthRoutePath(new URL(request.url).pathname, basePath)) {
                return undefined;
            }

            return stub()?.fetch(request);
        },
        resolveIdentity: async (request) => {
            // Fail closed on a missing secret. The object would refuse the call anyway;
            // returning `null` here makes that an anonymous request rather than a
            // round-trip that is guaranteed to 401.
            if (!internalSecret) {
                return null;
            }

            const target = stub();

            if (!target) {
                return null;
            }

            // Forward the caller's headers so the session cookie reaches the object,
            // then add the secret that authorises the question.
            const headers = new Headers(request.headers);

            headers.set(INTERNAL_SECRET_HEADER, internalSecret);

            const response = await target.fetch(new Request(new URL(RESOLVE_SESSION_PATH, request.url), { headers }));

            if (!response.ok) {
                return null;
            }

            // `Response.json()` resolves to `unknown`, so narrow once here.
            const body: null | { email?: string; expiresAtMs?: number; name?: string; role?: string; userId?: string } = await response.json();

            if (!body?.userId) {
                return null;
            }

            // `expiresAtMs` becomes the socket's credential expiry
            // (`x-lunora-identity-exp`) so the DO drops a subscriber whose session has
            // lapsed; `role` is what RLS role grants are read from; `email`/`name` are
            // the claims `ctx.auth.getIdentity()` is documented to carry. Each is
            // dropped when absent rather than forwarded as `undefined`, so the claims
            // header stays minimal for a session that carries none of them.
            return {
                ...(typeof body.email === "string" && body.email.length > 0 ? { email: body.email } : {}),
                ...(typeof body.expiresAtMs === "number" && Number.isFinite(body.expiresAtMs) ? { expiresAtMs: body.expiresAtMs } : {}),
                ...(typeof body.name === "string" && body.name.length > 0 ? { name: body.name } : {}),
                ...(typeof body.role === "string" && body.role.length > 0 ? { role: body.role } : {}),
                userId: body.userId,
            };
        },
    };
};
