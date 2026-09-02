/**
 * Per-package secret-requirements registry for `.dev.vars` scaffolding.
 *
 * Each entry maps a `@lunora/*` package name → the secrets it requires at
 * runtime, expressed as `{ key, description, docsUrl }` records. The scaffolder
 * in {@link ./scaffold-dev-variables} reads this registry to emit package-aware
 * `.dev.vars.example` entries (placeholders + inline doc-pointer comments).
 *
 * ## Adding a new add-on
 *
 * When a new `@lunora/*` package requires runtime secrets, add one entry to
 * {@link PACKAGE_SECRETS_REGISTRY} keyed by its exact npm package name. Each
 * `SecretEntry` in the array needs:
 *
 * - `key`         — the env-var name the package reads from `env` (e.g. `RESEND_API_KEY`).
 * - `description` — one line describing the secret and how to obtain it.
 * - `docsUrl`     — a stable URL to the package/provider docs.
 *
 * The registry lives in `@lunora/config` so that add-ons themselves never need
 * to depend on it (no circular coupling). Add-ons document their secrets in
 * their own READMEs; the registry duplicates that knowledge in a machine-readable
 * form that the scaffolder can consume.
 *
 * **Never write a real secret value** in this file — `placeholderValue` entries
 * are the only allowed values (they must pass `isPlaceholderValue` from
 * scaffold-dev-variables).
 */

import { isSecretKeyName } from "../../../shared/secret-key";

/** A single secret variable required by a package. */
interface SecretEntry {
    /** One sentence describing what this secret is and how to obtain it. */
    description: string;
    /** URL to the package or provider docs for this secret. */
    docsUrl: string;
    /** The env-var key as it appears in `.dev.vars`, e.g. `AUTH_SECRET`. */
    key: string;

    /**
     * The placeholder value written into `.dev.vars.example`.
     * Must pass `isPlaceholderValue` from scaffold-dev-variables so the
     * scaffolder regenerates it when generating `.dev.vars`. Use angle-bracket
     * conventions or a recognised marker like `replace-with-openssl-rand-hex-32`.
     * Non-secret env-vars (e.g. `AUTH_URL`) may carry a real default value.
     */
    placeholderValue: string;
}

/**
 * Secrets every Lunora project needs regardless of which capability packages are
 * installed — scaffolded into `.dev.vars` always. `LUNORA_ADMIN_TOKEN` is the
 * bearer the local Studio uses to call the worker's admin endpoints (the data
 * browser, schema edits) in dev; the worker reads the SAME `.dev.vars` value via
 * its admin gate, so both agree and the Studio authenticates without a prompt.
 * Without it, every `/_lunora/admin/*` call is `ADMIN_FORBIDDEN` (403).
 */
const CORE_SECRETS: ReadonlyArray<SecretEntry> = [
    {
        description:
            "Bearer token the local Lunora Studio uses to call the worker's admin endpoints (data browser, schema edits) in dev. Generate with: openssl rand -hex 32",
        docsUrl: "https://lunora.sh/docs/packages/studio",
        key: "LUNORA_ADMIN_TOKEN",
        placeholderValue: "replace-with-openssl-rand-hex-32",
    },
];

/**
 * Secret keys Lunora mints locally that no PACKAGE declares, so
 * {@link MINTABLE_SECRET_KEYS} cannot derive them from the map below: they
 * arrive with a copy-in registry item (`lunora registry add storage`) or under a
 * dependency's own env-var name. Keep this list next to the map — a key Lunora
 * scaffolds but never lists here is one nothing will ever fill in.
 */
const EXTRA_MINTABLE_SECRET_KEYS: ReadonlyArray<string> = [
    // better-auth reads its signing secret under its own name in projects that
    // configure it directly rather than through `AUTH_SECRET`.
    "BETTER_AUTH_SECRET",
    // `registry/storage` — the HMAC secret for signed R2 URLs.
    "STORAGE_SIGNING_SECRET",
];

/**
 * The canonical registry of per-package secret requirements.
 *
 * Keys are exact npm package names (e.g. `"@lunora/auth"`). Values are
 * non-empty arrays of {@link SecretEntry} — one entry per required secret key.
 *
 * The scaffolder in `scaffold-dev-variables.ts` calls
 * {@link secretsForPackages} to resolve the applicable entries from this map
 * given the set of detected capability package names.
 */
const PACKAGE_SECRETS_REGISTRY: Readonly<Record<string, ReadonlyArray<SecretEntry>>> = {
    "@lunora/auth": [
        {
            description: "32-byte random secret used to sign sessions and tokens. Generate with: openssl rand -hex 32",
            docsUrl: "https://lunora.sh/docs/packages/auth#secrets",
            key: "AUTH_SECRET",
            placeholderValue: "replace-with-openssl-rand-hex-32",
        },
        {
            description:
                "Public base URL of your worker (used by better-auth for redirects and cookie domain). For local dev this is typically http://localhost:8787",
            docsUrl: "https://lunora.sh/docs/packages/auth#secrets",
            key: "AUTH_URL",
            placeholderValue: "http://localhost:8787",
        },
    ],
    "@lunora/mail": [
        {
            description: "Resend API key for sending transactional email via @lunora/mail. Obtain at https://resend.com/api-keys",
            docsUrl: "https://lunora.sh/docs/packages/mail#secrets",
            key: "RESEND_API_KEY",
            placeholderValue: "<your-resend-api-key>",
        },
    ],
    "@lunora/notify": [
        {
            description:
                "Public VAPID key (base64url) for Web Push. Generate a keypair once with: npx web-push generate-vapid-keys — the public key is also shipped to the browser to subscribe.",
            docsUrl: "https://lunora.sh/docs/packages/notify#web-push",
            key: "VAPID_PUBLIC_KEY",
            placeholderValue: "<your-vapid-public-key>",
        },
        {
            description: "Private VAPID key (base64url) for Web Push — the application-server signing key. Generate with: npx web-push generate-vapid-keys",
            docsUrl: "https://lunora.sh/docs/packages/notify#web-push",
            key: "VAPID_PRIVATE_KEY",
            placeholderValue: "<your-vapid-private-key>",
        },
        {
            description: "VAPID `sub` contact — a mailto: or https: URL identifying the application server (e.g. mailto:you@example.com).",
            docsUrl: "https://lunora.sh/docs/packages/notify#web-push",
            key: "VAPID_SUBJECT",
            placeholderValue: "mailto:you@example.com",
        },
        {
            description: "Firebase project id for FCM (HTTP v1) push. Found in the Firebase console project settings.",
            docsUrl: "https://lunora.sh/docs/packages/notify#fcm",
            key: "FCM_PROJECT_ID",
            placeholderValue: "<your-firebase-project-id>",
        },
        {
            description:
                "OAuth2 access token for FCM (HTTP v1). Convenient for dev but expires — in production supply a getAccessToken() in defineNotify instead. Obtain via the Google Cloud SDK / a service account.",
            docsUrl: "https://lunora.sh/docs/packages/notify#fcm",
            key: "FCM_ACCESS_TOKEN",
            placeholderValue: "<your-fcm-access-token>",
        },
    ],
    "@lunora/payment": [
        {
            description: "Stripe secret key (sk_test_…). Required when using the Stripe adapter. Obtain at https://dashboard.stripe.com/apikeys",
            docsUrl: "https://lunora.sh/docs/packages/payment#stripe",
            key: "STRIPE_SECRET_KEY",
            placeholderValue: "<your-stripe-secret-key>",
        },
        {
            description: "Stripe webhook signing secret (whsec_…) for verifying event payloads. Obtain at https://dashboard.stripe.com/webhooks",
            docsUrl: "https://lunora.sh/docs/packages/payment#stripe",
            key: "STRIPE_WEBHOOK_SECRET",
            placeholderValue: "<your-stripe-webhook-secret>",
        },
        {
            description: "Polar access token for the Polar payment adapter. Obtain at https://polar.sh/settings/tokens",
            docsUrl: "https://lunora.sh/docs/packages/payment#polar",
            key: "POLAR_ACCESS_TOKEN",
            placeholderValue: "<your-polar-access-token>",
        },
        {
            description: "Polar webhook secret for verifying event payloads from Polar. Obtain at https://polar.sh/settings/webhooks",
            docsUrl: "https://lunora.sh/docs/packages/payment#polar",
            key: "POLAR_WEBHOOK_SECRET",
            placeholderValue: "<your-polar-webhook-secret>",
        },
        {
            description: "Autumn secret key (am_sk_…) for the Autumn payment adapter. Obtain at https://app.useautumn.com/dev",
            docsUrl: "https://lunora.sh/docs/packages/payment#autumn",
            key: "AUTUMN_SECRET_KEY",
            placeholderValue: "<your-autumn-secret-key>",
        },
        {
            description: "Autumn webhook signing secret for verifying Standard Webhooks event payloads. Obtain from your Autumn dashboard webhook settings.",
            docsUrl: "https://lunora.sh/docs/packages/payment#autumn",
            key: "AUTUMN_WEBHOOK_SECRET",
            placeholderValue: "<your-autumn-webhook-secret>",
        },
        {
            description: "Dodo Payments API key (bearer token) for the Dodo Payments adapter. Obtain at https://app.dodopayments.com/developer/api-keys",
            docsUrl: "https://lunora.sh/docs/packages/payment#dodo-payments",
            key: "DODO_PAYMENTS_API_KEY",
            placeholderValue: "<your-dodo-payments-api-key>",
        },
        {
            description:
                "Dodo Payments webhook signing secret (whsec_…) for verifying event payloads. Obtain at https://app.dodopayments.com/developer/webhooks",
            docsUrl: "https://lunora.sh/docs/packages/payment#dodo-payments",
            key: "DODO_PAYMENTS_WEBHOOK_KEY",
            placeholderValue: "<your-dodo-payments-webhook-secret>",
        },
        {
            description: "Creem API key for the Creem payment adapter. Obtain at https://www.creem.io/dashboard/developers",
            docsUrl: "https://lunora.sh/docs/packages/payment#creem",
            key: "CREEM_API_KEY",
            placeholderValue: "<your-creem-api-key>",
        },
        {
            description: "Creem webhook signing secret for verifying the creem-signature header. Obtain from your Creem dashboard webhook settings.",
            docsUrl: "https://lunora.sh/docs/packages/payment#creem",
            key: "CREEM_WEBHOOK_SECRET",
            placeholderValue: "<your-creem-webhook-secret>",
        },
    ],
};

/**
 * Collect all secret entries required by the given set of package names. The
 * order follows the order of `packageNames` (stable, predictable output), and
 * within each package the entries are returned in registry declaration order.
 *
 * Only packages present in {@link PACKAGE_SECRETS_REGISTRY} contribute entries;
 * unknown package names are silently ignored — this makes the call site resilient
 * to future capability flags whose packages have no secrets.
 */

/**
 * Every secret key Lunora can mint a value for locally (a random 32-byte hex,
 * like `openssl rand -hex 32`) — the registry entries whose placeholder is that
 * marker rather than an angle-bracket `<your-…>` one (which means the value comes
 * from a provider's dashboard), plus {@link EXTRA_MINTABLE_SECRET_KEYS}.
 *
 * This set, not a key's NAME, is what makes a value safe to generate. A
 * secret-LOOKING key nothing here declares (`OPENAI_API_KEY`, a project's own
 * `*_CLIENT_SECRET`) is provider-issued as far as Lunora knows: minting for it
 * writes a value the provider rejects at runtime and hides the gap from
 * `lunora env doctor`, whose job is to report it as unfilled.
 */
const MINTABLE_SECRET_KEYS: ReadonlySet<string> = new Set([
    ...EXTRA_MINTABLE_SECRET_KEYS,
    ...[...CORE_SECRETS, ...Object.values(PACKAGE_SECRETS_REGISTRY).flat()]
        .filter((entry) => isSecretKeyName(entry.key) && !entry.placeholderValue.startsWith("<"))
        .map((entry) => entry.key),
]);

const secretsForPackages = (packageNames: ReadonlyArray<string>): SecretEntry[] => {
    const result: SecretEntry[] = [];

    for (const name of packageNames) {
        const entries = PACKAGE_SECRETS_REGISTRY[name];

        if (entries !== undefined) {
            result.push(...entries);
        }
    }

    return result;
};

export type { SecretEntry };
export { CORE_SECRETS, MINTABLE_SECRET_KEYS, PACKAGE_SECRETS_REGISTRY, secretsForPackages };
