<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="auth" />

</a>

<h3 align="center">Auth for Lunora — a thin better-auth wrapper: email/password, OAuth, plugins, D1-backed</h3>

<!-- END_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<br />

<div align="center">

[![typescript-image][typescript-badge]][typescript-url]
[![FSL-1.1-Apache-2.0 licence][license-badge]][license]
[![npm version][npm-version-badge]][npm-version]
[![npm downloads][npm-downloads-badge]][npm-downloads]
[![PRs Welcome][prs-welcome-badge]][prs-welcome]

</div>

---

<div align="center">
    <p>
        <sup>
            Daniel Bannert's open source work is supported by the community on <a href="https://github.com/sponsors/prisis">GitHub Sponsors</a>
        </sup>
    </p>
</div>

---

Authentication for Lunora, built as a thin wrapper around [better-auth](https://better-auth.com). `createAuth` is `betterAuth` with a few Cloudflare-friendly defaults; the package backs the user/session store on D1, re-exports the better-auth plugins under `@lunora/auth/plugins`, and adds a `ctx.authApi` middleware plus standalone Turnstile helpers. It runs on your own Cloudflare account — there is no external auth service.

Part of the [Lunora](https://github.com/anolilab/lunora) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @lunora/auth
```

```sh
yarn add @lunora/auth
```

```sh
pnpm add @lunora/auth
```

## Usage

```ts
import { createAuth, ensureMigrated, handleAuthRequest, lunoraD1Adapter } from "@lunora/auth";

const auth = createAuth({
    secret: env.AUTH_SECRET,
    // Prefer lunoraD1Adapter over passing raw env.DB — the raw binding makes
    // better-auth resolve its Kysely adapter via a dynamic import that hangs
    // under @cloudflare/vite-plugin's dev runner.
    database: lunoraD1Adapter(env.DB),
    emailAndPassword: { enabled: true },
});

// In your Worker's fetch handler, route /api/auth/* to better-auth and fall
// through to the Lunora worker for everything else:
export default {
    async fetch(request, env, ctx) {
        // Idempotent schema sync; dev/small deploys. Takes the RAW binding —
        // better-auth migrates only through its Kysely adapter and throws on
        // `lunoraD1Adapter`, so the migration instance is a separate one.
        await ensureMigrated(createAuth({ secret: env.AUTH_SECRET, database: env.DB, emailAndPassword: { enabled: true } }));

        const authResponse = await handleAuthRequest(auth, request);
        if (authResponse) return authResponse;

        // … hand off to your Lunora worker
    },
};
```

The runtime resolves the inbound session and stamps `ctx.auth` on every `query` / `mutation` / `action`: `ctx.auth.userId` is the signed-in user's id (or `null` when anonymous), and `ctx.auth.getIdentity()` resolves the decoded claims.

### Plugins & CAPTCHA

better-auth's plugin factories are re-exported from `@lunora/auth/plugins` (so you don't need better-auth's deep import paths): `admin`, `anonymous`, `bearer`, `captcha`, `createAccessControl`, `createMcpProtectedRequestHandler`, `customSession`, `deviceAuthorization`, `emailOTP`, `genericOAuth`, `haveIBeenPwned`, `jwt`, `lastLoginMethod`, `magicLink`, `mcp`, `multiSession`, `oAuthProxy`, `oauthDeviceAuthorization`, `oauthProvider`, `oneTap`, `oneTimeToken`, `organization`, `passkey`, `phoneNumber`, `requireMcpAuth`, `scim`, `siwe`, `twoFactor`, and `username`. Enterprise SSO ships separately as `sso` from `@lunora/auth/plugins/enterprise` (an optional peer — see the docs).

For Cloudflare Turnstile on the **auth flow**, use the `captcha` plugin (`captcha({ provider: "cloudflare-turnstile", secretKey: env.TURNSTILE_SECRET_KEY })`); it reads the token from the `x-captcha-response` header. For **non-auth** procedures, the package root also exports standalone helpers — `verifyTurnstile` (pure `siteverify`) and `verifyTurnstileMiddleware` (a `.use()` middleware that takes the token from the function args).

### Disposable / free-email gating

Reject throwaway/disposable signups (and branch on free-vs-business email) by reusing the visulima email lists — pure-data and **edge-safe on the default path** (no DNS). Wire it into better-auth's native signup with `withEmailGate` (or `emailGateDatabaseHooks`):

```ts
import { createAuth, withEmailGate, lunoraD1Adapter } from "@lunora/auth";

const auth = createAuth(
    withEmailGate(
        { secret: env.AUTH_SECRET, database: lunoraD1Adapter(env.DB), emailAndPassword: { enabled: true } },
        {
            blockDisposable: true, // default — reject disposable domains with `EMAIL_DOMAIN_BLOCKED`
            allowDomains: ["your-company.com"], // never blocked; always classified `business`
            denyDomains: [], // extra domains to treat as disposable
            // mx: true,       // OPT-IN deliverability check — needs DNS (node:dns), so keep it OFF on the edge path
            onClassify: (c, user) => console.log(`signup ${user.email as string}: ${c.emailClass}`),
        },
    ),
);
```

A blocked signup fails with the coded error `EMAIL_DOMAIN_BLOCKED` (HTTP 400); a business/free email passes and its `emailClass` (`disposable | free | business`) is surfaced via `onClassify`. Everything is config-gated and defaults sensibly.

- **Programmatic / non-auth use:** `classifyEmail(email, config)` (sync, pure-data) and `assertEmailAllowed(email, config)` (async; throws the coded error) come from `@lunora/auth/email-guard`, plus `emailGateMiddleware({ email: (ctx) => ctx.args.email })` for a `.use()` gate on your own signup mutations.
- **Edge-safety:** on workerd, `await loadEmailDomainLists()` once at worker init (the gate helpers do this for you). The optional `mx: true` deliverability check is loaded via a dynamic import so `node:dns` never enters the default bundle — enable it only with `nodejs_compat` (or a DNS-over-HTTPS shim).

### Invite-only sign-up

Close self-serve registration: `inviteOnly()` creates an account only for an address an administrator invited. It hooks `user.create.before`, so it gates every path that mints a user — password sign-up, an OAuth callback creating a new account, magic link, `admin.createUser`, and Lunora's own `AuthAdmin.createUser` — and declares the `signUpInvitation` table it reads, so migrations pick it up on their own.

```ts
import { createAuth, createSignUpInvitation } from "@lunora/auth";
import { inviteOnly } from "@lunora/auth/plugins";

const auth = createAuth({
    secret: env.AUTH_SECRET,
    database: lunoraD1Adapter(env.DB),
    emailAndPassword: { enabled: true, requireEmailVerification: true },
    plugins: [inviteOnly()],
});

// …from your own admin-authorized code:
const invite = await createSignUpInvitation(auth, { email: "ada@example.com" });
const link = `https://app.example/sign-up?email=${encodeURIComponent(invite.email)}&invite=${invite.token}`;
```

An uninvited signup fails with the coded error `SIGN_UP_INVITE_REQUIRED` (HTTP **400** — a 403 from a create hook is swallowed by better-auth's sign-up route and answered with a fabricated success). Leave `emailAndPassword.disableSignUp` **off** — the invitee still uses the ordinary sign-up form, which `@lunora/auth-ui` prefills from `?email=`. `listSignUpInvitations` and `revokeSignUpInvitation` complete the set; all three are trusted server-side calls with no authorization of their own, so gate them like any other admin action.

- **An invitation carries a secret token** — 256 CSPRNG bits, returned in the clear exactly once and stored only as a SHA-256. It is checked on `/sign-up/email` and nowhere else, because every other account-minting path (OAuth callback, magic link, email OTP) has already proved the person controls the address. So there are two layers: the database gate requires an unspent invitation whatever created the row, and the route hook additionally requires the token. Missing token, wrong token, expired invitation and never-invited address all answer with one message, so the form is not a directory oracle.
- **The link is a bearer credential.** Whoever holds it takes the seat — send it to the invitee, not a shared inbox, and reissue rather than resend if unsure. `requireEmailVerification` still matters: the user row is written before the verification mail goes out, so verification is what keeps a spent invitation from becoming a usable session. The plugin warns on startup when password sign-up runs without it.
- **Plugins that synthesize an address are refused, not admitted.** `anonymous` (`temp-<id>@…`), `siwe` (`<wallet>@<domain>`), and `phoneNumber`'s sign-up-on-verification all create users with a generated email that matches no invitation, so those flows are rejected — but only once a user exists. Under `allowFirstUser: true` the bootstrap runs before the address is compared, so the first anonymous session or wallet sign-in is what claims it. Don't combine them with this.
- **Nobody signs up before the first invitation exists, including you.** Seed it with `createSignUpInvitation` at worker init or from a one-off internal mutation. `inviteOnly({ allowFirstUser: true })` instead admits the first account uninvited — convenient, but the "is the user table empty" check is racy and open to whoever finds the URL first.
- **The studio's Users page grows a Sign-up invitations section** when the plugin is installed — invite, see pending/accepted/expired, revoke. The same three ops are on `AuthAdmin` and the client (`listAuthSignUpInvitations`, `createAuthSignUpInvitation`, `revokeAuthSignUpInvitation`), with `useSignUpInvitations()` in `@lunora/react`. Nothing prunes the table; `pruneSignUpInvitations(auth)` deletes the invitations that expired unused and returns the count.
- **Revocation is not retroactive, and not atomic against a sign-up in flight.** better-auth does not wrap the `before` hook and the user insert in one transaction, and the adapter contract offers no conditional consume, so a revoke landing between the two lets that one account through. `AuthAdmin.removeUser` is how you undo one that already happened.

### Security / audit trail

Record authentication & security events (sign-in, sign-up, password change, MFA enable/disable, token refresh, session revoke, …) to a durable, queryable audit trail. Install the better-auth `hooks.after` recorder with `authAuditHook` (or compose via `withAuthAudit`), backed by the same D1 database as the auth tables:

```ts
import { authAuditHook, createAuth, d1Executor, lunoraD1Adapter, readAuthAuditLog } from "@lunora/auth";

const executor = d1Executor(env.DB);

const auth = createAuth({
    secret: env.AUTH_SECRET,
    database: lunoraD1Adapter(env.DB),
    hooks: {
        after: authAuditHook({
            executor,
            // retention is CONFIGURABLE and NOT capped — omit it for an unbounded, compliance-grade trail
            retention: 100_000,
            // optional export tap for SIEM forwarding (receives each redacted entry)
            onRecord: (entry) => forwardToSiem(entry),
        }),
    },
});

// Query the trail (RLS/admin-gate this in your own read):
const recent = await readAuthAuditLog(executor, { event: "sign-in", limit: 100 });
```

The built-in hook records only the request path in `detail`; it is free-form for entries you append yourself. Either way the payload is scrubbed with `@visulima/redact` before it is persisted, so a token/password that leaks into one never reaches the durable table. Retention defaults to unbounded (set `retention` to bound it). The store lives in the reserved `__lunora_auth_audit__` table (auto-hidden from the data browser).

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://lunora.sh/docs/packages/auth)**.

## Related

- [`@lunora/server`](https://www.npmjs.com/package/@lunora/server) — define the queries and mutations that read `ctx.auth`.
- [`@lunora/studio`](https://www.npmjs.com/package/@lunora/studio) — admin user dashboard, wired with `createAuthAdmin(auth)`.
- [`@lunora/mail`](https://www.npmjs.com/package/@lunora/mail) — send better-auth's verification / reset / magic-link emails.

## Supported Node.js Versions

Libraries in this ecosystem make the best effort to track [Node.js' release schedule](https://github.com/nodejs/release#release-schedule).
Here's [a post on why we think this is important](https://medium.com/the-node-js-collection/maintainers-should-consider-following-node-js-release-schedule-ab08ed4de71a).

## Contributing

If you would like to help take a look at the [list of issues](https://github.com/anolilab/lunora/issues) and check our [Contributing](https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md) guidelines.

> **Note:** please note that this project is released with a Contributor Code of Conduct. By participating in this project you agree to abide by its terms.

## Credits

- [Daniel Bannert](https://github.com/prisis)
- [All Contributors](https://github.com/anolilab/lunora/graphs/contributors)

## Made with ❤️ at Anolilab

This is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Anolilab](https://www.anolilab.com/open-source) is a Development and AI Studio. Contact us at [hello@anolilab.com](mailto:hello@anolilab.com) if you need any help with these technologies or just want to say hi!

## License

The Lunora auth package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/lunora/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@lunora/auth?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@lunora/auth
[npm-downloads-badge]: https://img.shields.io/npm/dm/@lunora/auth?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@lunora/auth
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
