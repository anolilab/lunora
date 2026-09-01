/**
 * Email hardening for signup — disposable/free-email gating with an optional,
 * DNS-backed deliverability check.
 *
 * `@lunora/auth` already runs better-auth's email-verification flow; what it
 * lacked was domain-based gating at registration. This module adds it by reusing
 * the visulima email catalog, which is edge-safe on the default path:
 * `@visulima/disposable-email-domains` (blocklist of throwaway providers) and
 * `@visulima/free-email-domains` (free consumer providers, used to flag/branch
 * B2B signups, never to block by default).
 *
 * Edge-safety (workerd): both list packages default to a `node:fs` loader that
 * is unavailable on workerd. To keep the default path pure-data and edge-safe,
 * this module injects the statically-importable JSON lists via each package's
 * `setDomains` escape hatch — no filesystem, no DNS. The only part that touches
 * DNS is the opt-in MX check ({@link EmailGateConfig.mx}), loaded through a
 * dynamic import so the DNS module never enters the default bundle or hot path.
 * On workerd, `node:dns` needs `nodejs_compat` (or a DNS-over-HTTPS shim); leave
 * `mx` off unless you have it.
 */

import { LunoraError } from "@lunora/errors";
import type { Middleware } from "@lunora/server";
import { isDisposableDomain, setDomains as setDisposableDomains } from "@visulima/disposable-email-domains";
import { extractDomain, isFreeDomain, setDomains as setFreeDomains } from "@visulima/free-email-domains";

/**
 * The resolved trust class of an email address' domain: `disposable` (a
 * throwaway/temporary provider, or a caller `denyDomains` hit), `free` (a free
 * consumer provider like Gmail — deliverable but not B2B), or `business`
 * (anything else — a custom/company domain, or an `allowDomains` hit).
 */
type EmailClass = "business" | "disposable" | "free";

/** Result of {@link classifyEmail} — the resolved class plus the normalized domain. */
interface EmailClassification {
    /** The normalized (lowercased, trimmed) domain, or `undefined` for a structurally invalid address. */
    domain: string | undefined;
    /** The resolved trust class. A structurally invalid address resolves to `business` with `domain: undefined`. */
    emailClass: EmailClass;
}

/** Configuration for {@link classifyEmail} / {@link assertEmailAllowed} / {@link emailGateMiddleware}. */
interface EmailGateConfig {
    /**
     * Domains that are always allowed and always classified `business`, even if
     * they appear on the disposable or free lists. Wildcard/subdomain aware
     * (`example.com` also allows `mail.example.com`). Your own hosted domains go
     * here.
     */
    allowDomains?: ReadonlyArray<string>;

    /**
     * Reject disposable/throwaway signups. Defaults to `true` — the whole point
     * of the gate. Set `false` to classify-only (surface `emailClass` without
     * blocking).
     */
    blockDisposable?: boolean;

    /**
     * Extra domains to treat as disposable (blocked when `blockDisposable`), on
     * top of the built-in list. Wildcard/subdomain aware.
     */
    denyDomains?: ReadonlyArray<string>;

    /**
     * Opt-in MX deliverability verification. Off by default because it needs DNS
     * (`@visulima/email-verifier/checks/mx` → `node:dns`), which is not available
     * on the default workerd path. When `true`, {@link assertEmailAllowed} rejects
     * an address whose domain publishes no MX (or fallback A/AAAA) records with
     * `EMAIL_UNDELIVERABLE`. The check is loaded via a dynamic import, so leaving
     * this off keeps the DNS module out of the bundle entirely.
     */
    mx?: boolean;

    /**
     * Reject structurally invalid addresses up front (via
     * `@visulima/email-verifier/checks/syntax`, pure-data/edge-safe). Defaults to
     * `true`. When `false`, an unparseable address classifies as `business` with
     * `domain: undefined` and is not rejected on syntax alone.
     */
    requireValidSyntax?: boolean;
}

/** Options for {@link emailGateMiddleware}: the base gate config plus how to read the email from `ctx`. */
interface EmailGateMiddlewareOptions<Context> extends EmailGateConfig {
    /**
     * Selector that pulls the signup email off `ctx`. The procedure context
     * carries only the resolved identity, not the raw request body, so the email
     * travels in the function `args` — which the builder surfaces to middleware
     * as `ctx.args` (validated, frozen). Mirrors `verifyTurnstileMiddleware`'s
     * `token` selector:
     *
     * ```ts
     * export const signUp = mutation
     *     .input({ email: v.string() })
     *     .use(emailGateMiddleware({ email: (ctx) => ctx.args.email }))
     *     .mutation(async ({ args, ctx }) => { … });
     * ```
     */
    email: (context: Context) => string | undefined;

    /**
     * Called with the resolved classification once the gate passes, so app policy
     * can branch on `free` vs `business` (e.g. gate a plan behind a business
     * email). Never fires when the gate rejects.
     */
    onClassify?: (classification: EmailClassification, context: Context) => void;
}

// The list packages lazy-load from `node:fs` by default, which is unavailable on
// workerd. Inject the statically-importable JSON lists via each package's
// `setDomains` escape hatch so the classification path is pure-data/edge-safe.
// The JSON is pulled through a dynamic `import()` (its `.d.ts` uses `export =`,
// which the repo's strict module-syntax rule forbids as a static default import)
// and memoized, so the load happens at most once.

/** A dynamically-imported list module (`export = string[]`), surfaced as the namespace's `default` under interop. */
const listFromModule = (module: unknown): ReadonlyArray<string> => {
    const value = (module as { default?: unknown }).default ?? module;

    return Array.isArray(value) ? (value as string[]) : [];
};

let listsPromise: Promise<void> | undefined;

/**
 * Inject the built-in disposable + free domain lists into the lookup packages,
 * once. Call this at worker init on workerd (where the packages' `node:fs`
 * loader is unavailable) so {@link classifyEmail} has data to match against;
 * {@link assertEmailAllowed} / {@link emailGateMiddleware} await it for you, so
 * the gating path is always edge-safe. Idempotent — repeat calls share one load.
 */
const loadEmailDomainLists = async (): Promise<void> => {
    if (listsPromise) {
        return listsPromise;
    }

    const run = (async (): Promise<void> => {
        const [disposable, free] = await Promise.all([
            import("@visulima/disposable-email-domains/domains"),
            // `with { type: "json" }` is load-bearing: this specifier resolves to a raw
            // `dist/domains.json`, and native ESM rejects a JSON module imported without
            // the attribute (`ERR_IMPORT_ATTRIBUTE_MISSING`). Vite and wrangler's esbuild
            // inline the JSON, so the bundled paths never notice — only the published
            // `dist/email-guard.mjs` hits it, where it turns every signup into a 500.
            import("@visulima/free-email-domains/domains", { with: { type: "json" } }),
        ]);

        setDisposableDomains(listFromModule(disposable));
        setFreeDomains(listFromModule(free));
    })();

    // Recorded synchronously so concurrent callers single-flight onto this run, and
    // evicted on rejection so a transient failure doesn't brick the gate for the
    // isolate's life — a memoised rejection would make `emailGateMiddleware` answer
    // 500 forever. Mirrors `audit.ts`'s `ensured` and `migrate.ts`'s `migrating`.
    listsPromise = run;
    run.catch(() => {
        listsPromise = undefined;
    });

    return run;
};

/**
 * Fold a domain to its IDNA/punycode (`xn--…`) ASCII form so it can be compared
 * against the blocklists, which are ASCII-only: they carry ~300 `xn--` entries
 * and NO Unicode ones, so an internationalized disposable domain submitted in its
 * Unicode form (`почта.рф`) would otherwise miss its own blocklist entry and be
 * classified `business`. The WHATWG `URL` parser applies ToASCII for us — no
 * `node:punycode`, so this stays edge-safe. Falls back to the lowercased input
 * when the domain doesn't parse as a host (the lookup then simply misses, as
 * before).
 */
const toAsciiDomain = (domain: string): string => {
    try {
        return new URL(`https://${domain}`).hostname;
    } catch {
        return domain.toLowerCase();
    }
};

/** Convert a list to a `Set`, or `undefined` when empty/absent (so the lookup helpers skip the arg). */
const toDomainSet = (domains: ReadonlyArray<string> | undefined): Set<string> | undefined =>
    domains && domains.length > 0 ? new Set(domains.map((domain) => toAsciiDomain(domain))) : undefined;

/**
 * Classify an email address' domain as `disposable` / `free` / `business`,
 * pure-data and edge-safe (no DNS, no filesystem). A structurally invalid
 * address resolves to `{ domain: undefined, emailClass: "business" }` — use
 * {@link assertEmailAllowed} (which can reject on syntax) for the gating path.
 * `allowDomains` wins over both lists; `denyDomains` adds to the disposable list.
 *
 * The lookup relies on the built-in domain lists being loaded. On Node they
 * auto-load from disk; on workerd, `await loadEmailDomainLists()` first (or use
 * {@link assertEmailAllowed} / {@link emailGateMiddleware}, which await it).
 *
 * The returned/compared domain is IDNA-normalized (see {@link toAsciiDomain}) so
 * a Unicode-form internationalized domain matches its `xn--` blocklist entry.
 */
const classifyEmail = (email: string, config: EmailGateConfig = {}): EmailClassification => {
    const extracted = extractDomain(email);

    if (extracted === undefined) {
        return { domain: undefined, emailClass: "business" };
    }

    const domain = toAsciiDomain(extracted);

    const allowDomains = toDomainSet(config.allowDomains);

    if (isDisposableDomain(domain, { allowDomains, customDomains: toDomainSet(config.denyDomains) })) {
        return { domain, emailClass: "disposable" };
    }

    if (isFreeDomain(domain, { allowDomains })) {
        return { domain, emailClass: "free" };
    }

    return { domain, emailClass: "business" };
};

/**
 * Lazily load the DNS-backed MX check. Kept behind a dynamic import so the
 * `node:dns`-touching module never enters the default (edge) bundle — only a
 * caller that opts into `mx: true` pulls it in.
 */
const verifyMx = async (domain: string): Promise<boolean> => {
    const { checkMxRecords } = await import("@visulima/email-verifier/checks/mx");
    const result = await checkMxRecords(domain);

    return result.valid;
};

/**
 * Classify `email` and enforce the gate, throwing a coded {@link LunoraError}
 * when it fails: `VALIDATION_ERROR` (structurally invalid, only when
 * `requireValidSyntax`, the default), `EMAIL_DOMAIN_BLOCKED` (disposable or
 * deny-listed, only when `blockDisposable`, the default), or `EMAIL_UNDELIVERABLE`
 * (no MX records, only when `mx: true`).
 *
 * Returns the {@link EmailClassification} on success so callers can branch on
 * `free` vs `business`. Async only because of the opt-in MX step; with `mx` off
 * it resolves without any network I/O.
 */
const assertEmailAllowed = async (email: string, config: EmailGateConfig = {}): Promise<EmailClassification> => {
    // Syntax gate (pure-data). Default on; only skipped when explicitly disabled.
    if (config.requireValidSyntax !== false) {
        const { validateSyntax } = await import("@visulima/email-verifier/checks/syntax");

        if (!validateSyntax(email)) {
            throw new LunoraError("VALIDATION_ERROR", `@lunora/auth: "${email}" is not a valid email address.`);
        }
    }

    // Ensure the domain lists are injected before classifying — this is what
    // keeps the gate edge-safe (workerd has no `node:fs` auto-loader).
    await loadEmailDomainLists();

    const classification = classifyEmail(email, config);

    if (classification.emailClass === "disposable" && config.blockDisposable !== false) {
        throw new LunoraError(
            "EMAIL_DOMAIN_BLOCKED",
            `@lunora/auth: signups from the disposable/throwaway domain "${classification.domain ?? email}" are not allowed.`,
        );
    }

    if (config.mx === true && classification.domain !== undefined && !(await verifyMx(classification.domain))) {
        throw new LunoraError(
            "EMAIL_UNDELIVERABLE",
            `@lunora/auth: the domain "${classification.domain}" publishes no MX records, so mail to it cannot be delivered.`,
        );
    }

    return classification;
};

/**
 * Lunora procedure middleware that gates a non-auth, signup-shaped
 * `mutation`/`action` on the email-domain policy. Attach it with `.use()`; it
 * reads the email from `ctx` via the `email` selector (declare it with
 * `.input(...)` and read it back as `ctx.args.email`)
 * and runs {@link assertEmailAllowed}, which throws a coded {@link LunoraError}
 * (`EMAIL_DOMAIN_BLOCKED` / `EMAIL_UNDELIVERABLE` / `VALIDATION_ERROR`) the
 * runtime maps to the matching status.
 *
 * To gate better-auth's native `/sign-up/email` endpoint instead, use
 * `emailGateDatabaseHooks` / `withEmailGate` from `@lunora/auth` — those hook
 * better-auth's own user-create path. The `Middleware` import is type-only, so
 * this stays free of any runtime `@lunora/server` dependency.
 */
const emailGateMiddleware =
    <Context>(options: EmailGateMiddlewareOptions<Context>): Middleware<Context, Context> =>
    async ({ ctx, next }) => {
        const email = options.email(ctx);

        if (email === undefined || email === "") {
            throw new LunoraError("VALIDATION_ERROR", "@lunora/auth: emailGateMiddleware received no email to check.");
        }

        const classification = await assertEmailAllowed(email, options);

        options.onClassify?.(classification, ctx);

        return next();
    };

export { assertEmailAllowed, classifyEmail, emailGateMiddleware, loadEmailDomainLists };
export type { EmailClass, EmailClassification, EmailGateConfig, EmailGateMiddlewareOptions };
