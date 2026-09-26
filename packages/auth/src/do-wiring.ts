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
import { LunoraError } from "@lunora/errors";

import type { AuthAuditEntry, AuthAuditReader } from "./audit";
import { INTERNAL_SECRET_HEADER, READ_AUDIT_PATH, RESOLVE_SESSION_PATH } from "./auth-do";
import { DEFAULT_AUTH_BASE_PATH, isAuthRoutePath } from "./handler";
import type { AuthJurisdictionMove } from "./jurisdiction-move";
import { createAuthJurisdictionMove, MOVE_PATH } from "./jurisdiction-move";

/** The slice of a Durable Object namespace this needs — structural, so tests need no runtime. */
/* eslint-disable @typescript-eslint/method-signature-style, @typescript-eslint/no-invalid-void-type -- bivariant params (a real `DurableObjectNamespace.get` takes a `DurableObjectId`, not `unknown`), and `this: void` is the `allowAsThisParameter` case the repo config does not enable */
export interface AuthNamespaceLike {
    get(this: void, id: unknown): { fetch: (request: Request) => Promise<Response> };
    idFromName(this: void, name: string): unknown;
    /** Jurisdiction-restricted subnamespace. Optional only so older binding types still fit; {@link createDoAuthWiring} fails closed without it when a jurisdiction is set. */
    jurisdiction?(this: void, jurisdiction: AuthJurisdiction): AuthNamespaceLike;
}
/* eslint-enable @typescript-eslint/method-signature-style, @typescript-eslint/no-invalid-void-type */

/**
 * Cloudflare Durable Object data-residency jurisdiction. Widening union —
 * Cloudflare adds values over time.
 */
export type AuthJurisdiction = "eu" | "fedramp" | "us";

/** What {@link createDoAuthWiring} needs, already resolved against `env`. */
export interface DoAuthWiringOptions {
    /**
     * Shared secret presented on the object's internal session route. `undefined`
     * means identity resolution fails closed — see {@link DoAuthWiring.resolveIdentity}.
     */
    internalSecret: string | undefined;

    /**
     * Pin the auth object to a data-residency jurisdiction — pass the worker's
     * `jurisdiction`. The object holds users, sessions, and credentials, so it must
     * live where the rest of the app's data does. The same name maps to a different
     * object per jurisdiction, so toggling this on an existing deployment starts a
     * fresh, empty auth object.
     */
    jurisdiction?: AuthJurisdiction;

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

    /**
     * Forwards `/api/auth/*` to the object; `undefined` for anything else.
     *
     * The base path is fixed. It was configurable on both halves of DO-backed auth
     * and settable on neither: codegen's `AuthDeclaration` has no field for it, so
     * the emitted `createDoAuthWiring(...)` never passed one and an `AuthDO`
     * subclass that set its own served nothing.
     */
    authHandler: (request: Request) => Promise<Response | undefined>;

    /**
     * Copy the auth tables from the un-pinned object into the pinned one, and later
     * purge the un-pinned copy. Present only when a `jurisdiction` is set. Backs the
     * worker's `copyAuthToJurisdiction` and `purgeUnpinnedAuth` admin ops.
     */
    jurisdictionMove?: AuthJurisdictionMove;

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
 * The exception is a `jurisdiction` the namespace cannot express, which throws here.
 * @param options The resolved namespace, secret, and names.
 * @returns The `authHandler` / `resolveIdentity` pair.
 * @experimental
 */
export const createDoAuthWiring = (options: DoAuthWiringOptions): DoAuthWiring => {
    const { internalSecret, jurisdiction, objectName = "auth" } = options;
    const unpinned = options.namespace;
    let { namespace } = options;

    // The one throw here, and deliberately at construction: a residency pin that
    // cannot be honoured is a deployment bug. Degrading to "not authenticated"
    // would hide it, and falling back to the unrestricted namespace would put the
    // auth tables outside the jurisdiction the app declared.
    if (namespace && jurisdiction !== undefined) {
        if (typeof namespace.jurisdiction !== "function") {
            throw new TypeError(
                `@lunora/auth: Durable Object namespace does not support jurisdiction("${jurisdiction}") — update @cloudflare/workers-types or remove the jurisdiction option`,
            );
        }

        namespace = namespace.jurisdiction(jurisdiction);
    }

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

    // Only a pinned object has an un-pinned twin to copy from.
    const pinned = namespace;
    const jurisdictionMove =
        unpinned && pinned && jurisdiction !== undefined
            ? createAuthJurisdictionMove(async (side, body) => {
                  if (!internalSecret) {
                      throw new LunoraError(
                          "AUTH_MOVE_NOT_CONFIGURED",
                          "copying the auth object needs its internal secret; set the auth object's `internalSecret`",
                      );
                  }

                  const from = side === "source" ? unpinned : pinned;

                  return from.get(from.idFromName(objectName)).fetch(
                      new Request(new URL(MOVE_PATH, "https://auth-do.invalid"), {
                          body: JSON.stringify(body),
                          headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: internalSecret },
                          method: "POST",
                      }),
                  );
              })
            : undefined;

    return {
        ...(jurisdictionMove === undefined ? {} : { jurisdictionMove }),
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
            if (!isAuthRoutePath(new URL(request.url).pathname, DEFAULT_AUTH_BASE_PATH)) {
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
