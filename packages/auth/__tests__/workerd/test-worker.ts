/**
 * Test entry-point Worker for the enterprise-auth (SSO / SCIM) workerd suite.
 *
 * The point of this worker is what it *imports*. `@better-auth/scim` is
 * zod-only, but `@better-auth/sso` statically imports `samlify` (which itself
 * `require`s `fs`, `crypto`, and `zlib`) plus `node:crypto`'s `X509Certificate`
 * — so the module graph is pulled into the bundle even when only the OIDC code
 * path is configured. If any of that is unavailable in workerd, this worker
 * fails to boot and the suite says so, which is the whole GO/NO-GO signal.
 */
import { scim } from "@better-auth/scim";
import { sso } from "@better-auth/sso";

const testWorker = {
    fetch(request: Request): Response {
        const url = new URL(request.url);

        // Constructing the plugins (not just importing them) proves the factories
        // run — module-scope side effects in the samlify tree would already have
        // thrown by the time this worker booted.
        if (url.pathname === "/plugins") {
            // 1.7 requires connections up front; the values are irrelevant here — the
            // point is that the factories run inside workerd at all.
            const built = [sso(), scim({ connections: [{ credentials: [{ id: "primary", token: "unused", type: "bearer" }], id: "probe" }] })];

            return Response.json({ ids: built.map((plugin) => plugin.id) });
        }

        return new Response("auth-enterprise-test-worker", { status: 200 });
    },
};

export default testWorker;
