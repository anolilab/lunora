/**
 * Auth instance + request handler — added by `lunora registry add auth`.
 *
 * This file is YOURS: it's copied into your project so you own and edit it.
 * `@lunora/auth` is a thin wrapper over better-auth — `createAuth(options)` is
 * `betterAuth(options)` with a clearer error when `secret` is missing, and it
 * passes every better-auth option (`socialProviders`, `plugins`, `session`, …)
 * straight through. See https://www.better-auth.com/docs for the full surface.
 *
 * What this exports:
 *   - `authOptions(env)` — the better-auth options: email/password with
 *     verification, and the `organization()` + `admin()` plugins the kit's
 *     tenancy runs on. `lunora/server.ts` hands it to `.auth({ d1, options })`,
 *     which builds the request instance over `lunoraD1Adapter`, builds the
 *     migration instance over raw D1 from THE SAME options (so the plugin tables
 *     and columns are migrated too), and serves `/api/auth/*`.
 *   - `getAuth(env)` — a memoized instance over the same options, for the two
 *     reads `.auth()` does not expose: the session + member lookup in
 *     `resolveIdentity`, and the member count the organization hooks project.
 */
import type { LunoraAuth, LunoraAuthOptions } from "@lunora/auth";
import { createAuth, lunoraD1Adapter } from "@lunora/auth";
import { admin, organization, uiConfig } from "@lunora/auth/plugins";
import { createMailerFromEnv } from "@lunora/mail";
import type { ShardNamespaceLike } from "lunorash/runtime";
import { createShardClient } from "lunorash/runtime";

import { internal } from "../_generated/api.js";

/**
 * Env-name values that mark a development deployment, and the vars they live in.
 * `lunora dev` sets `WORKER_ENV=development`; a real deploy that sets none of
 * these stays production (fail closed). Used to gate dev-only behaviour below —
 * console-logging auth links.
 */
const DEV_ENVIRONMENT_PATTERN = /^(?:dev(?:elopment)?|local(?:host)?|test)$/iu;
const ENVIRONMENT_VARS = ["CF_ENV", "ENVIRONMENT", "NODE_ENV", "WORKER_ENV"] as const;

/**
 * Whether the Worker is running in development. Defaults to FALSE so a real
 * deploy that sets none of {@link ENVIRONMENT_VARS} is treated as production —
 * dev-only conveniences (logging links) never leak there.
 */
const isDevEnvironment = (env: Record<string, unknown>): boolean =>
    ENVIRONMENT_VARS.some((key) => typeof env[key] === "string" && DEV_ENVIRONMENT_PATTERN.test(env[key] as string));

/**
 * The Worker env bindings this module needs. Lunora generates a richer `Env`
 * for your project; this is the minimal slice `buildAuth` reads. `DB` is your
 * D1 binding (declared in `wrangler.jsonc`); better-auth accepts a D1Database
 * directly as its `database`.
 */
export interface AuthEnv {
    /** better-auth encryption secret (min 32 chars). Set as a secret. */
    BETTER_AUTH_SECRET: string;
    /** Public base URL of your app, e.g. "http://localhost:8787". */
    BETTER_AUTH_URL?: string;
    /** Cloudflare D1 binding better-auth persists users/sessions into. */
    DB: unknown;
    /** The shard namespace — the organization hooks write the admin projection through it. */
    SHARD: ShardNamespaceLike;
}

/**
 * Send a transactional auth email (verification link, password reset) through
 * `@lunora/mail`. In a dev environment this is captured into the studio's Mail
 * inbox; in production it delivers via the `SEND_EMAIL` binding (or
 * `RESEND_API_KEY`). `createMailerFromEnv` owns the capture-vs-deliver decision,
 * so auth mail behaves exactly like `api.mail.sendEmail`.
 *
 * If mail isn't set up yet (`MAIL_FROM` unset — you haven't run `lunora add
 * email`), the link is logged to the console **in development only** so sign-up
 * / reset still work before you wire mail. In production this fails closed: auth
 * links are bearer credentials, so we throw rather than write them to Worker
 * logs where anyone with log access could use them to take over the account.
 * Cast through the full `env` since the mailer reads bindings (`SHARD`,
 * `SEND_EMAIL`) and vars (`MAIL_FROM`) outside {@link AuthEnv}'s slice.
 *
 * `html` is optional so the `auth-emails` registry item's recipe compiles as
 * documented: `renderEmail(<ResetPasswordEmail … />)` returns `{ html, text }`
 * and both are passed straight through to `@lunora/mail`.
 */
const sendAuthEmail = async (env: AuthEnv, message: { html?: string; subject: string; text: string; to: string }): Promise<void> => {
    const fullEnv = env as unknown as Record<string, unknown>;

    if (typeof fullEnv["MAIL_FROM"] !== "string") {
        if (!isDevEnvironment(fullEnv)) {
            // Production with no mailer configured — never log the link (it's a
            // bearer credential). Fail loudly so the deploy gets mail wired up.
            throw new Error(
                "auth: mail is not configured (`MAIL_FROM` unset) — run `lunora add email` before deploying. Refusing to log auth links in production.",
            );
        }

        // Dev only — surface the link so the flow still works. Run `lunora add email`.
        // eslint-disable-next-line no-console -- dev fallback: surface the auth link when no mailer is set up
        console.log(`[auth] email → ${message.to}: ${message.subject}\n${message.text}`);

        return;
    }

    const cloudflareSend = async (from: string, to: string, raw: string): Promise<void> => {
        const { EmailMessage } = await import("cloudflare:email");
        const binding = fullEnv["SEND_EMAIL"] as { send: (m: InstanceType<typeof EmailMessage>) => Promise<void> } | undefined;

        if (binding === undefined) {
            throw new Error("auth: no SEND_EMAIL binding to deliver mail — run `lunora add email` or set RESEND_API_KEY.");
        }

        await binding.send(new EmailMessage(from, to, raw));
    };

    // Only hand over `cloudflareSend` when the binding exists: `createMailerFromEnv`
    // prefers it over `RESEND_API_KEY` whenever it is supplied, so passing it
    // unconditionally would make a Resend-only deployment (no `SEND_EMAIL`
    // binding) throw inside `cloudflareSend` instead of falling back to Resend.
    await createMailerFromEnv(fullEnv, fullEnv["SEND_EMAIL"] === undefined ? {} : { cloudflareSend }).send(message);
};

/**
 * Per-isolate memoized instance for {@link getAuth}. Cloudflare reuses the same
 * `env` bindings across invocations within an isolate, so building once avoids
 * reconstructing better-auth (and its adapter) on every request.
 */
let cached: LunoraAuth | undefined;

/**
 * Get (or lazily build) this isolate's instance over {@link authOptions}.
 *
 * ponytail: this is a second instance beside the one `.auth()` builds for
 * `/api/auth/*` — same options, same D1, so the only cost is one construction
 * per isolate. Drop it if `.auth()` ever hands its instance to `.extend()`.
 */
export const getAuth = (env: AuthEnv): LunoraAuth => {
    cached ??= createAuth({ ...authOptions(env), database: lunoraD1Adapter(env.DB as never) });

    return cached;
};

/** The organisation fields every hook carries. */
interface OrganizationRecord {
    id: string;
    name: string;
    slug: string;
}

/**
 * Project one organisation into `saas_organizations` — the `.global()` table the
 * admin screen reads and the billing page takes its seat count from.
 *
 * Through `createShardClient`, the supported way for Worker code (this runs
 * inside better-auth's `/api/auth/*` handler, not a Lunora function) to call an
 * `internal` function. It is a system caller, which is what an internal
 * mutation needs; `saas_organizations` is `.global()`, so the root shard it
 * lands on reaches the same D1 table every other shard does.
 *
 * The member count is re-read rather than kept as a delta, so a missed or
 * repeated hook cannot leave the number permanently off by one. A failure is
 * logged and swallowed: better-auth has already committed the change, so
 * failing the request would tell the user their organisation was not created
 * when it was. The next event for that organisation re-projects the whole row.
 */
const projectOrganization = async (env: AuthEnv, organization: OrganizationRecord, fields: { status?: string } = {}): Promise<void> => {
    try {
        const { adapter } = await getAuth(env).$context;
        const seats = await adapter.count({ model: "member", where: [{ field: "organizationId", value: organization.id }] });

        await createShardClient(env.SHARD, { shardKey: "__root__" }).call(internal.saas.syncOrganization, {
            name: organization.name,
            organizationId: organization.id,
            seats,
            slug: organization.slug,
            ...fields,
        });
    } catch (error) {
        // eslint-disable-next-line no-console -- the admin projection is best-effort; surface the drift in Worker logs
        console.error("[saas] could not project organization", { error, organizationId: organization.id });
    }
};

/**
 * The better-auth options. Edit freely — add `socialProviders`, `plugins` (from
 * `@lunora/auth/plugins`), or a `session` policy (`sessionPresets` from
 * `@lunora/auth`). The `auth-clerk` / `auth-auth0` registry items scaffold
 * provider snippets you merge into the options here.
 *
 * No `database`: `.auth({ d1, options })` in `lunora/server.ts` supplies it —
 * `lunoraD1Adapter` for requests, raw D1 for the migration sweep — and both are
 * built from THESE options, so whatever plugin you add here gets its tables
 * migrated too.
 *
 * Email/password sign-up enables verification + a forgot-password reset; both
 * deliver through {@link sendAuthEmail} (captured into the studio Mail tab in
 * dev). Edit the subjects/bodies — or swap to a React template via
 * `@lunora/mail`'s `renderEmail` — to taste.
 */
export const authOptions = (env: AuthEnv): LunoraAuthOptions => {
    return {
        baseURL: env.BETTER_AUTH_URL,
        emailAndPassword: {
            enabled: true,
            requireEmailVerification: true,
            sendResetPassword: async ({ url, user }) => {
                await sendAuthEmail(env, { subject: "Reset your password", text: `Reset your password:\n${url}`, to: user.email });
            },
        },
        emailVerification: {
            sendVerificationEmail: async ({ url, user }) => {
                await sendAuthEmail(env, { subject: "Verify your email address", text: `Verify your email address:\n${url}`, to: user.email });
            },
        },
        // Publishes which plugins and social providers you enabled at
        // `GET /api/auth/ui-config`, so `lunora add auth-ui`'s screens configure
        // themselves — add a social provider here and its button appears, with
        // no second list to keep in sync client-side. Only facts a sign-in page
        // reveals by existing are exposed; drop the plugin to turn it off.
        plugins: [
            uiConfig(),
            /*
             * The kit's tenancy runs on these two. `organization()` owns the
             * organizations, members and invitations that `saas_organizations`
             * projects, and the `activeOrganizationId` claim every org-scoped
             * function reads comes off the session it manages. `admin()` supplies
             * the platform-wide `user.role` the admin screens check, and the
             * impersonation an admin uses to enter a tenant with that tenant's
             * own authorization applied.
             *
             * Both add fields to the session and user that `createAuth`'s erased
             * `LunoraAuth` return type does not carry — see the narrowing in
             * `resolveIdentity` in `lunora/server.ts`.
             */
            organization({
                // Keep the admin projection in step with the records it mirrors.
                organizationHooks: {
                    afterAcceptInvitation: async ({ organization: record }) => projectOrganization(env, record),
                    afterAddMember: async ({ organization: record }) => projectOrganization(env, record),
                    afterCreateOrganization: async ({ organization: record }) => projectOrganization(env, record),
                    afterDeleteOrganization: async ({ organization: record }) => projectOrganization(env, record, { status: "deleted" }),
                    afterRemoveMember: async ({ organization: record }) => projectOrganization(env, record),
                    afterUpdateOrganization: async ({ organization: record }) => {
                        if (record) {
                            await projectOrganization(env, record);
                        }
                    },
                },
            }),
            admin(),
        ],
        secret: env.BETTER_AUTH_SECRET,
    };
};
