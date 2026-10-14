/**
 * `vis generate lunora-auth-do` — scaffold the auth Durable Object in
 * lunora/auth-do.ts.
 *
 * The DO-backed auth mode needs three things wired together, and getting any one of
 * them wrong fails at a different time: a `LunoraAuthDO` subclass, that class exported
 * from the worker entry (which is what makes the config layer provision the
 * `durable_objects` binding and the `new_sqlite_classes` migration), and
 * `.auth({ namespace, internalSecret })` on the app builder. This writes the class and
 * tells you the other two.
 *
 * Why this mode exists at all: `@better-auth/scim` refuses to serve unless its adapter
 * exposes native transactions, and D1 has none. A Durable Object's storage does.
 *
 * Like `lunora-flags`, this is a singleton — one object owns the whole auth schema — so
 * it REFUSES if the file already exists rather than clobbering a configured instance.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { createTemplate } from "@visulima/vis/generate";

const freshAuthDo = (className: string): string => `import { LunoraAuthDO } from "@lunora/auth";
import { admin, scim } from "@lunora/auth/plugins";

/**
 * better-auth running inside this object, on the object's own SQLite.
 *
 * The base class owns everything structural: it builds the instance lazily, creates and
 * reconciles the auth schema (better-auth's migrator is kysely-only and cannot target DO
 * storage), serves \`/api/auth/*\`, and answers the internal routes the worker uses to
 * resolve identity and read the audit log.
 */
export class ${className} extends LunoraAuthDO {
    public constructor(state: DurableObjectState, env: Env) {
        super(
            state,
            () => ({
                secret: env.AUTH_SECRET,
                // Sessions read through a round-trip to this object. \`cookieCache\` serves
                // most of them from the signed cookie instead, at the cost of a staleness
                // window on revocation — drop it if you need instant revocation.
                session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
                plugins: [
                    scim({
                        connections: [{ id: "okta-acme", credentials: [{ type: "bearer", id: "primary", token: env.SCIM_TOKEN }] }],
                    }),
                    admin(),
                ],
            }),
            // The binding is reachable from any worker bound to it, so this secret — not
            // the binding — is the authorization boundary on the internal routes.
            { internalSecret: env.AUTH_DO_SECRET },
        );
    }
}
`;

export default createTemplate({
    about: {
        description: "Scaffold the auth Durable Object in lunora/auth-do.ts for DO-backed auth (what @better-auth/scim requires)",
        name: "lunora-auth-do",
    },
    options: {
        name: {
            prompt: "Class name for the auth Durable Object",
            required: false,
            type: "string",
        },
    },
    produce: ({ builtins, options }) => {
        const className = typeof options.name === "string" && options.name.trim() !== "" ? options.name.trim() : "AuthDO";
        const authDoPath = join(builtins.dest_dir, "lunora", "auth-do.ts");

        if (existsSync(authDoPath)) {
            throw new Error(
                `lunora/auth-do.ts already exists at ${authDoPath} — one object owns the whole auth schema. Edit it directly to change the plugin list, or delete it first to re-scaffold.`,
            );
        }

        return {
            files: { lunora: { "auth-do.ts": freshAuthDo(className) } },
            suggestions: [
                `Created lunora/auth-do.ts with the ${className} class.`,
                `Re-export it from your worker entry (\`export { ${className} } from "../lunora/auth-do";\`) — that is what makes the config layer add the durable_objects binding and the new_sqlite_classes migration.`,
                `Point the builder at it: \`.auth({ namespace: (env) => env.AUTH_DO, internalSecret: (env) => env.AUTH_DO_SECRET, options: (env) => ({ ... }) })\`. Pass \`d1\` OR \`namespace\`, never both.`,
                "Set AUTH_SECRET, AUTH_DO_SECRET and SCIM_TOKEN in .dev.vars (and as deployed secrets).",
                "Note: the studio's auth admin pages are D1-only — they read the auth tables directly from the worker, which DO storage does not allow. The audit feed does work.",
            ],
        };
    },
});
