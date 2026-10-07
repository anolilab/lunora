import { LunoraError } from "@lunora/errors";

import { isPrivateHost, normalizeHost } from "../../../shared/ssrf-host";
import { resolveHostSsrf } from "../../../shared/ssrf-resolve";
import createCrawlClient from "./crawl-client";
import type {
    Browser,
    BrowserContextLike,
    BrowserLaunchLike,
    BrowserLike,
    BrowserSession,
    LunoraBrowserOptions,
    NavigateOptions,
    PageLike,
    PdfOptions,
    QuickActionName,
    QuickActionOptions,
    RouteLike,
    RouteResponseLike,
    ScreenshotOptions,
} from "./types";

/** Browser Run refuses a session whose guardrails list more hostnames than this (400 at acquire). */
const MAX_GUARDRAIL_DOMAINS = 50;

/** The most distinct URLs a Quick Action's options may nest (`addScriptTag[].url`, …) — each is guarded, maybe with DNS lookups. */
const MAX_NESTED_QUICK_ACTION_URLS = 50;

/** The redirect hops one navigation may take — Chromium's own ceiling. */
const MAX_REDIRECTS = 20;

/** The statuses whose `Location` a browser follows. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Default navigation timeout when neither the call nor the factory sets one. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Hard ceiling on any navigation timeout — a hung page can't pin the worker forever. */
const MAX_TIMEOUT_MS = 120_000;

/** Hard caps on a requested viewport so a caller can't ask for a multi-million-pixel render. */
const MAX_VIEWPORT_WIDTH = 3840;
const MAX_VIEWPORT_HEIGHT = 4320;

/**
 * The window Browser Rendering accepts for `keep_alive`, expressed in the
 * SECONDS this package's `launch({ keepAlive })` takes (the provider's own unit
 * is milliseconds: `keep_alive?: number // from 10_000ms to 600_000ms`).
 *
 * Outside it the launch is rejected by the provider, so a `keepAlive: 1` or
 * `keepAlive: 3600` reaches Cloudflare only to come back as an opaque launch
 * failure — after the caller has already been told, by this package's own
 * types, that any finite positive number of seconds holds the session open.
 * Checking it here names the bound that was actually violated.
 */
const MIN_KEEP_ALIVE_SECONDS = 10;
const MAX_KEEP_ALIVE_SECONDS = 600;

/**
 * Hard ceiling on a single DoH lookup. Without it the `fetch` could stall
 * indefinitely and pin the worker before the browser even launches — a hung
 * resolver would defeat the whole point of paying for the pre-launch re-check.
 * The caller reuses the (smaller of the) navigation timeout budget, capped here.
 * Named `CEILING` rather than `TIMEOUT` because it is a `Math.min` bound on the
 * caller's own budget, not the value passed through — and so it can't be read as
 * the shared resolver's own (smaller) default.
 */
const DOH_CEILING_MS = 5000;

/**
 * DNS-rebinding re-check for a validated navigation target: throws when the
 * host resolves to a private/internal address. The resolution + classification
 * live in the shared `resolveHostSsrf` helper (see its docblock for the
 * best-effort semantics — IP literals skipped, a failed lookup falls back to the
 * string guard, never fail-open on an address that DID resolve private); this
 * only turns a `"private"` verdict into the package's own user-facing refusal.
 */
const assertResolvedHostIsPublic = async (target: string, timeoutMs: number = DOH_CEILING_MS): Promise<void> => {
    const host = normalizeHost(new URL(target).hostname);
    const resolution = await resolveHostSsrf(host, timeoutMs);

    if (resolution.kind === "private") {
        throw new LunoraError(
            "FORBIDDEN",
            `@lunora/browser: url host "${host}" resolves to a private/internal address (${resolution.address}); refusing to navigate (DNS-rebinding guard)`,
        );
    }

    // An answer with no address (empty, SERVFAIL, NXDOMAIN) is not "public": the
    // name's nameserver can fail this lookup and answer the browser's a moment later.
    if (resolution.kind === "unresolved") {
        throw new LunoraError("FORBIDDEN", `@lunora/browser: url host "${host}" did not resolve to any address; refusing to navigate (DNS-rebinding guard)`);
    }
};

/**
 * The ASCII (punycode) form of an `allowedHosts` entry — what `URL.hostname`
 * yields for the same name — so a Unicode entry matches the URL it was meant for.
 * An entry no URL could carry is kept as written; it then matches nothing.
 */
const toAsciiHost = (entry: string): string => {
    try {
        return normalizeHost(new URL(`http://${entry}`).hostname);
    } catch {
        return normalizeHost(entry);
    }
};

/** Escape a value for a double-quoted HTML attribute. */
const escapeHtmlAttribute = (value: string): string => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** How `withPage` hears from the guard about redirects of its own page's main frame. */
interface MainFrameWatch {
    /** The watched page, once it is open. */
    page: () => PageLike | undefined;
    /** A main-frame redirect passed the guards; `next` is its checked target. */
    redirected: (next: string) => void;
    /** A main-frame navigation or redirect was refused. */
    refused: (error: Error) => void;
}

/** What one main-frame navigation of `withPage` ended in. */
interface NavigationOutcome {
    redirect?: string;
    refusal?: Error;
}

/**
 * Validate a caller-supplied navigation URL. The boundary, in order:
 *
 * - Scheme — only absolute `http(s)`. A non-string, empty, relative, or non-`http(s)`
 * value (`javascript:`, `file:`, `ftp:`, `data:`) never reaches the headless browser,
 * so a hostile caller can't drive it at a local file or a non-network scheme.
 * - Credentials — a `user:pass@host` userinfo component is rejected: page navigation
 * never needs it, and it's a credential-leak / host-spoof smell.
 * - Host allowlist — when `allowedHosts` is set (an EMPTY list allows nothing), the hostname must match
 * one of its entries exactly (case-insensitive, trailing-dot-normalized, IPv6 brackets
 * stripped); anything else is refused. This is the one guard that fully closes DNS
 * rebinding for a URL boundary that accepts client-controlled hosts.
 * - SSRF target — unless `allowPrivateTargets` is set, a private / internal / loopback
 * / link-local host is refused (see the shared `isPrivateHost` classifier). Browser Rendering egresses
 * from Cloudflare's network, but a private-network binding / Cloudflare Tunnel can still
 * make such hosts reachable, so default-deny is the safe posture; trusted internal use
 * opts in explicitly.
 *
 * Returns the normalized absolute URL string. This string check classifies the host
 * as-written — it does **not** resolve DNS. So on its own, a PUBLIC hostname that
 * resolves — via attacker-controlled DNS — to a private/metadata IP is NOT blocked
 * here (classic DNS rebinding). That gap is closed by the `resolveDns` re-check the
 * caller applies before `page.goto` (on by default when no `allowedHosts` is set);
 * `allowedHosts` is itself the hard guarantee when the reachable hosts are known.
 *
 * This validates one target. A 3xx can point the browser somewhere else, so the
 * context guard (`guardContext`) re-runs it on every navigation and on every
 * redirect's `Location` before the hop is requested.
 */
const validateUrl = (url: string, allowPrivateTargets: boolean, allowedHosts: ReadonlyArray<string> | undefined): string => {
    // Caller-supplied URL faults are BAD_REQUEST, not INTERNAL: they carry
    // actionable, client-safe text and must present as 4xx with the message
    // intact — never as a redacted 500 (see @lunora/errors' toErrorBody).
    if (typeof url !== "string" || url.length === 0) {
        throw new LunoraError("BAD_REQUEST", "@lunora/browser: url must be a non-empty string");
    }

    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        throw new LunoraError("BAD_REQUEST", `@lunora/browser: url must be an absolute http(s) URL (got "${url}")`);
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new LunoraError("BAD_REQUEST", `@lunora/browser: url protocol must be http(s) (got "${parsed.protocol}")`);
    }

    if (parsed.username !== "" || parsed.password !== "") {
        throw new LunoraError("BAD_REQUEST", "@lunora/browser: url must not embed credentials (strip the `user:pass@` userinfo)"); // gitleaks:allow -- illustrative error text, not a credential
    }

    // PRESENCE, not length. An empty `allowedHosts` is a configured allowlist
    // that permits nothing (fail closed), never "no allowlist" — the reading its
    // name carries, and the one the sibling registry item's EMPTY
    // `ALLOWED_RENDER_HOSTS` already ships. Keying on `length > 0` made
    // `createBrowser({ allowedHosts: [] })` permit every host while reading as
    // hardened to a reviewer and to the advisor's
    // `browser_user_url_without_allowlist`, which suppresses on the key being set.
    if (allowedHosts !== undefined) {
        const host = normalizeHost(parsed.hostname);

        if (!allowedHosts.includes(host)) {
            throw new LunoraError(
                "FORBIDDEN",
                allowedHosts.length === 0
                    ? `@lunora/browser: allowedHosts is configured but EMPTY, so every navigation is refused (including "${parsed.hostname}"). List the hosts to allow, or omit the option entirely to fall back to the private-target + DNS-rebinding guards.`
                    : `@lunora/browser: url host "${parsed.hostname}" is not in the configured allowedHosts allowlist`,
            );
        }
    }

    if (!allowPrivateTargets && isPrivateHost(parsed.hostname)) {
        // FORBIDDEN (403), matching the sibling SSRF refusals (allowlist mismatch
        // above, DNS-rebinding re-check) — the same class of refusal must present
        // identically on the wire, message intact, not as a redacted 500.
        throw new LunoraError(
            "FORBIDDEN",
            `@lunora/browser: url host "${parsed.hostname}" is a private/internal address; pass createBrowser({ …, allowPrivateTargets: true }) to allow it`,
        );
    }

    return parsed.toString();
};

/** Clamp one viewport dimension into `[1, max]`; a non-finite request (NaN/Infinity) falls back to `max`. */
const clampDimension = (value: number, max: number): number => {
    if (!Number.isFinite(value)) {
        return max;
    }

    return Math.min(Math.max(1, Math.floor(value)), max);
};

/** Clamp a requested viewport to the hard caps; both dimensions floored to >= 1 (non-finite → the cap). */
const clampViewport = (viewport: { height: number; width: number }): { height: number; width: number } => {
    return {
        height: clampDimension(viewport.height, MAX_VIEWPORT_HEIGHT),
        width: clampDimension(viewport.width, MAX_VIEWPORT_WIDTH),
    };
};

/**
 * Resolve and clamp a navigation timeout from the per-call + factory defaults.
 * A non-finite request (NaN/Infinity, which `??` cannot catch) falls back to the
 * default so a bad caller value can't disable the timeout.
 */
const resolveTimeout = (callTimeout: number | undefined, factoryTimeout: number | undefined): number => {
    const requested = callTimeout ?? factoryTimeout ?? DEFAULT_TIMEOUT_MS;
    const safe = Number.isFinite(requested) ? requested : DEFAULT_TIMEOUT_MS;

    return Math.min(Math.max(1, Math.floor(safe)), MAX_TIMEOUT_MS);
};

/**
 * Race `operation` against a hard `timeoutMs` deadline. `page.goto`'s own
 * `timeout` bounds only the navigation phase — `page.evaluate` (scrape),
 * `page.pdf`, `page.content`, and `page.screenshot` take no timeout, so a
 * hostile page that traps the operation post-navigation would otherwise pin the
 * worker until the platform limit kills it (holding the billed Browser Rendering
 * session open). Racing the whole goto+operation sequence against the resolved
 * budget honours the documented "navigation + operation" invariant; the browser
 * is torn down by `withBrowser`'s `finally` when the deadline rejects. The
 * timer is always cleared so a completed operation never keeps the runtime alive.
 */
const withDeadline = async <T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            operation(),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    reject(
                        new LunoraError("BROWSER_TIMEOUT", `@lunora/browser: navigation + operation exceeded the ${String(timeoutMs)}ms timeout budget`, {
                            status: 504,
                        }),
                    );
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
};

/**
 * Close a browser, swallowing any close failure: the session is being torn down
 * anyway, and a close failure must not mask the caller's result/error.
 */
const closeQuietly = async (browser: BrowserLike): Promise<void> => {
    try {
        await browser.close();
    } catch {
        // Swallowed — see above.
    }
};

/**
 * Rebuild a Quick Action options value with every nested `url` string passed
 * through `guard` (which throws for a target the factory forbids). Walks plain
 * objects and arrays; any other value is kept as-is.
 */
const guardNestedUrls = async (value: unknown, guard: (url: string) => Promise<string>): Promise<unknown> => {
    if (Array.isArray(value)) {
        return Promise.all(value.map(async (item: unknown) => guardNestedUrls(item, guard)));
    }

    if (typeof value !== "object" || value === null) {
        return value;
    }

    const entries = await Promise.all(
        Object.entries(value).map(async ([key, item]): Promise<[string, unknown]> => [
            key,
            key === "url" && typeof item === "string" ? await guard(item) : await guardNestedUrls(item, guard),
        ]),
    );

    return Object.fromEntries(entries);
};

/**
 * Map `allowedHosts` onto Browser Run session guardrails, refusing what the two
 * cannot agree on: more hosts than guardrails accept, and a `*` — guardrails
 * read it as a wildcard, while `allowedHosts` matches exactly, so forwarding one
 * would open the raw session far past what the Lunora-side guard allows.
 */
const toGuardrails = (allowedHosts: ReadonlyArray<string>): { allowedDomains: string[] } => {
    if (allowedHosts.length > MAX_GUARDRAIL_DOMAINS) {
        throw new LunoraError(
            "BAD_REQUEST",
            `@lunora/browser: allowedHosts has ${String(allowedHosts.length)} entries, but Browser Run session guardrails accept at most ${String(MAX_GUARDRAIL_DOMAINS)}`,
        );
    }

    const wildcard = allowedHosts.find((host) => host.includes("*"));

    if (wildcard !== undefined) {
        throw new LunoraError("BAD_REQUEST", `@lunora/browser: allowedHosts entry "${wildcard}" contains "*" — entries match exactly; list each host`);
    }

    return { allowedDomains: allowedHosts.map((host) => toAsciiHost(host)) };
};

/**
 * Build the `ctx.browser` helper over a Browser Run binding. Every URL-taking method passes the
 * SSRF guards documented on {@link LunoraBrowserOptions}; every Playwright session it opens is
 * closed in a `finally` unless the caller asks to keep it alive.
 */
// eslint-disable-next-line import/prefer-default-export -- named export: the package barrel re-exports by name, per the repo's no-default-mixing convention
export const createBrowser = (options: LunoraBrowserOptions): Browser => {
    // Defensive runtime guard: `binding` is required by the type, but JS callers
    // (and `createBrowser({})` misuse) can omit it.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guards untrusted JS callers despite the type
    if (!options.binding) {
        throw new TypeError("@lunora/browser: `binding` is required (env.BROWSER)");
    }

    const getLaunch = (): BrowserLaunchLike => {
        if (!options.launch) {
            throw new LunoraError(
                "INTERNAL",
                '@lunora/browser: `launch` is not available — install the `@cloudflare/playwright` peer dependency. The generated worker wires it for you; outside codegen pass it via createBrowser({ binding, launch }) (import { launch } from "@cloudflare/playwright").',
            );
        }

        return options.launch;
    };

    /** Same injection contract as {@link getLaunch}, for the session surface. */
    const requirePeer = <F>(function_: F | undefined, name: string): F => {
        if (!function_) {
            throw new LunoraError(
                "INTERNAL",
                `@lunora/browser: \`${name}\` is not available — install the \`@cloudflare/playwright\` peer dependency. The generated worker wires it for you; outside codegen pass it via createBrowser({ binding, ${name} }).`,
            );
        }

        return function_;
    };

    // The allowlist doubles as Browser Run session guardrails, so Cloudflare
    // enforces it on every request the session makes, sub-resource redirects
    // included. Checked once, here, since it is static config. An empty list is
    // forwarded as-is: Browser Run reads it as "block every request", which is
    // what `allowedHosts: []` means here too.
    const guardrails = options.allowedHosts === undefined ? undefined : toGuardrails(options.allowedHosts);
    // Normalized once: lower-cased, trailing dot and IPv6 brackets dropped, IDN in punycode.
    const allowedHosts = options.allowedHosts?.map((entry) => toAsciiHost(entry));
    const allowPrivateTargets = options.allowPrivateTargets ?? false;
    // Default-deny on private targets, or pinned to an allowlist: either way
    // every request a browser makes is checked. Only `allowPrivateTargets`
    // without an allowlist leaves the browser unguarded, by request.
    const guarded = !allowPrivateTargets || allowedHosts !== undefined;
    // A configured `allowedHosts` is the STRONGER guard — an exact-origin
    // allowlist closes rebinding outright — and it may deliberately name an
    // internal host reachable over a Tunnel/private-network binding. Running
    // the resolved-address check on top would refuse that documented config,
    // so the allowlist suppresses it, exactly as `allowedPushOrigins` does in
    // `@lunora/notify`. An explicit `resolveDns: true` still forces it on.
    const resolveDns = options.resolveDns ?? options.allowedHosts === undefined;

    /**
     * Run every URL guard against `url` — {@link validateUrl}, then the
     * DNS-rebinding re-check when it is on — and return the normalized target.
     * Shared by the initial navigation, every redirect hop, and the Quick Action
     * and crawl entry points, so no URL-taking method can skip a guard.
     */
    const assertTargetAllowed = async (url: string, dohTimeout: number): Promise<string> => {
        const target = validateUrl(url, allowPrivateTargets, allowedHosts);

        if (!allowPrivateTargets && resolveDns) {
            await assertResolvedHostIsPublic(target, dohTimeout);
        }

        return target;
    };

    /** The DoH budget for a call that has no per-call timeout (Quick Actions, crawl). */
    const defaultDohTimeout = (): number => Math.min(resolveTimeout(undefined, options.timeoutMs), DOH_CEILING_MS);

    /**
     * Launch a browser, run `use`, and **always** close the browser in a
     * `finally` — a leaked Browser Rendering session is billed and rate-limited,
     * so this is the one real footgun. The close error is swallowed (we never
     * mask the caller's original error with a close failure).
     */
    const withBrowser = async <T>(use: (browser: BrowserLike) => Promise<T>, requestedKeepAlive?: number): Promise<T> => {
        // Only a FINITE, POSITIVE duration asks for a held-open session. `0` is
        // the natural spelling of "do not keep alive", and what a `Number(...)`
        // over an unset env var yields; `NaN` is what a failed parse of one
        // yields. Treating either as a
        // keep-alive request both sent a nonsense `keep_alive` AND skipped the
        // always-close `finally`, leaking exactly the billed session that
        // `finally` exists to prevent. The sibling numeric inputs are
        // non-finite-safe the same way — see `resolveTimeout`, `clampDimension`.
        const keepAlive = requestedKeepAlive !== undefined && Number.isFinite(requestedKeepAlive) && requestedKeepAlive > 0 ? requestedKeepAlive : undefined;

        // A positive duration outside the provider's window is a DIFFERENT
        // failure from the ambiguous values above: the caller did ask for a
        // held-open session, and Browser Rendering will refuse the launch. Say
        // which bound was missed rather than forwarding it and surfacing a
        // provider error, and rather than silently degrading to the always-close
        // path (which would hand back a session id that is already dead).
        if (keepAlive !== undefined && (keepAlive < MIN_KEEP_ALIVE_SECONDS || keepAlive > MAX_KEEP_ALIVE_SECONDS)) {
            throw new LunoraError(
                "BAD_REQUEST",
                `@lunora/browser: keepAlive must be between ${String(MIN_KEEP_ALIVE_SECONDS)} and ${String(
                    MAX_KEEP_ALIVE_SECONDS,
                )} seconds (Browser Rendering accepts keep_alive from 10s to 10min; got ${String(requestedKeepAlive)})`,
            );
        }

        const launchOptions: Record<string, unknown> = {};

        // `keep_alive` (seconds) holds the Browser Rendering session open after
        // this worker detaches so a later `connect(sessionId)` can re-attach.
        // Closing it here would defeat that, so the close is skipped — the
        // session then expires on Cloudflare's clock rather than ours.
        if (keepAlive !== undefined) {
            launchOptions["keep_alive"] = keepAlive * 1000;
        }

        // The allowlist doubles as Browser Run session guardrails (see above).
        if (guardrails !== undefined) {
            launchOptions["guardrails"] = guardrails;
        }

        const browser = await getLaunch()(options.binding, Object.keys(launchOptions).length === 0 ? undefined : launchOptions);

        if (keepAlive === undefined) {
            try {
                return await use(browser);
            } finally {
                await closeQuietly(browser);
            }
        }

        // A held session is kept only for a caller that got what it came for: a
        // throw means nobody will `connect` to it, and it would be billed until
        // `keepAlive` lapsed.
        try {
            return await use(browser);
        } catch (error) {
            await closeQuietly(browser);

            throw error;
        }
    };

    /**
     * Sub-resource SSRF check. A rendered page autonomously issues img/fetch/
     * link/xhr requests; each fires the route handler as a non-navigation
     * request and must not be let through unchecked to a private/internal host.
     *
     * Deliberately narrower and string-only, unlike {@link validateUrl}: it must
     * NOT refuse non-http(s) schemes (`data:`/`blob:`/`about:` inline assets are
     * legitimate and network-unreachable), and it must NOT run a DoH lookup per
     * sub-resource (a DoS footgun). It mirrors validateUrl's allowlist +
     * `isPrivateHost` arms only, including the `allowPrivateTargets` gate on the
     * latter. Returns `true` when the request should be aborted.
     */
    const isBlockedSubresource = (rawUrl: string): boolean => {
        let parsed: URL;

        try {
            parsed = new URL(rawUrl);
        } catch {
            // Fail closed, as the navigation sibling does.
            return true;
        }

        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return false;
        }

        if (allowedHosts !== undefined && !allowedHosts.includes(normalizeHost(parsed.hostname))) {
            return true;
        }

        // Gated on `allowPrivateTargets`, exactly as validateUrl's arm is, so the
        // documented Tunnel config (`allowPrivateTargets` + an internal host on
        // the allowlist) still loads that host's own stylesheets and scripts. The
        // allowlist arm above is not relaxed by the flag.
        return !allowPrivateTargets && isPrivateHost(parsed.hostname);
    };

    /**
     * Install the SSRF guard on `context`: every request any of its pages makes
     * passes through it.
     *
     * A navigation (a page's or an iframe's) is checked with every URL guard,
     * then FETCHED HERE with `maxRedirects: 0` rather than continued. Playwright
     * calls a route handler only for the first request of a redirect chain; the
     * hops Chromium follows by itself never reach it, so `route.continue()` would
     * let a public URL 302 the browser to `169.254.169.254` unchecked. Instead a
     * 3xx's `Location` is checked before anything requests it: refused, the
     * navigation is aborted; allowed, the browser is answered with a page that
     * navigates there afresh, and a fresh navigation comes back through this
     * handler. A non-redirect response is handed to the browser as fetched.
     *
     * The cost: navigations are fetched by the Worker (Playwright's request
     * client) rather than by the browser, and a redirect becomes a new
     * navigation instead of a followed hop. `watch` lets `withPage` follow a
     * main-frame redirect itself and report a refused one by its own error.
     */
    const guardContext = async (context: BrowserContextLike, dohTimeout: number, watch?: MainFrameWatch): Promise<void> => {
        await context.route("**/*", async <TResponse extends RouteResponseLike>(route: RouteLike<TResponse>) => {
            const request = route.request();

            if (!(request.isNavigationRequest?.() ?? true)) {
                await (isBlockedSubresource(request.url()) ? route.abort("blockedbyclient") : route.continue());

                return;
            }

            const frame = request.frame?.();
            const mainFrame = watch?.page()?.mainFrame?.();
            // Without frame identity on either side, assume the page's own frame: its
            // redirect target is checked either way, so the worst case is following it.
            const isMainFrame = watch !== undefined && (frame === undefined || mainFrame === undefined || frame === mainFrame);

            const refuse = async (error: unknown): Promise<void> => {
                if (isMainFrame) {
                    watch.refused(error instanceof Error ? error : new Error(String(error)));
                }

                await route.abort("blockedbyclient");
            };

            try {
                await assertTargetAllowed(request.url(), dohTimeout);
            } catch (error) {
                await refuse(error);

                return;
            }

            let response: TResponse;

            try {
                response = await route.fetch({ maxRedirects: 0 });
            } catch {
                await route.abort("failed");

                return;
            }

            const location = REDIRECT_STATUSES.has(response.status()) ? response.headers()["location"] : undefined;

            if (location === undefined) {
                await route.fulfill({ response });

                return;
            }

            let next: string;

            try {
                next = await assertTargetAllowed(new URL(location, request.url()).href, dohTimeout);
            } catch (error) {
                await refuse(error);

                return;
            }

            if (isMainFrame) {
                watch.redirected(next);
            }

            await route.fulfill({
                body: `<!doctype html><meta http-equiv="refresh" content="0;url=${escapeHtmlAttribute(next)}">`,
                contentType: "text/html",
                status: 200,
            });
        });
    };

    /**
     * A browser handed to caller code (`launch`, `connect`) with the guard on
     * every context: the ones already open (a shared session's) and every one
     * opened from it, including the implicit context of `browser.newPage()`.
     * The session guardrails `allowedHosts` adds are enforced by Cloudflare on
     * top; this is what guards a browser that has none.
     */
    const guardBrowser = async (browser: BrowserLike): Promise<BrowserLike> => {
        if (!guarded) {
            return browser;
        }

        const dohTimeout = defaultDohTimeout();

        for (const context of browser.contexts?.() ?? []) {
            // eslint-disable-next-line no-await-in-loop -- each registration must land before the caller sees the browser
            await guardContext(context, dohTimeout);
        }

        return new Proxy(browser, {
            get: (target, key) => {
                if (key === "newContext") {
                    return async (...args: unknown[]): Promise<BrowserContextLike> => {
                        // Forwarded whole: the real `newContext` takes options this projection does not declare.
                        const context = await (Reflect.apply(target.newContext, target, args) as Promise<BrowserContextLike>);

                        await guardContext(context, dohTimeout);

                        return context;
                    };
                }

                const value: unknown = Reflect.get(target, key, target);

                if (key === "newPage" && typeof value === "function") {
                    return async (...args: unknown[]): Promise<unknown> => {
                        const page = await (value as (...rest: unknown[]) => Promise<{ context: () => BrowserContextLike }>).apply(target, args);

                        await guardContext(page.context(), dohTimeout);

                        return page;
                    };
                }

                return typeof value === "function" ? (value as (...rest: unknown[]) => unknown).bind(target) : value;
            },
        });
    };

    /**
     * Open a guarded context + page, navigate to `url` (following main-frame
     * redirects one checked hop at a time), run `use`. The page/context are torn
     * down when {@link withBrowser} closes the browser.
     */
    const withPage = async <T>(
        url: string,
        navigate: NavigateOptions,
        use: (page: PageLike) => Promise<T>,
        viewport?: { height: number; width: number },
    ): Promise<T> => {
        const timeout = resolveTimeout(navigate.timeoutMs, options.timeoutMs);
        // Reuse the navigation timeout budget for the DoH re-check, but never let a
        // single lookup exceed the DoH ceiling — a stalled resolver mustn't burn
        // the full (up to 120s) navigation budget before the browser even launches.
        const dohTimeout = Math.min(timeout, DOH_CEILING_MS);
        // Checked before we pay for a browser launch + `page.goto`.
        const target = await assertTargetAllowed(url, dohTimeout);

        return withBrowser(async (browser) => {
            const context = await browser.newContext();
            let page: PageLike | undefined;
            // Replaced per navigation, so what one hop learned cannot leak into the next.
            let outcome: NavigationOutcome = {};

            if (guarded) {
                await guardContext(context, dohTimeout, {
                    page: () => page,
                    redirected: (next) => {
                        outcome.redirect = next;
                    },
                    refused: (error) => {
                        outcome.refusal = error;
                    },
                });
            }

            const opened = await context.newPage();

            page = opened;

            if (viewport && opened.setViewportSize) {
                await opened.setViewportSize(clampViewport(viewport));
            }

            // Bound the WHOLE navigation + operation against the resolved timeout
            // budget, not just `page.goto` — see {@link withDeadline}. `page.goto`
            // keeps its own `timeout` for a clean navigation-phase abort.
            return withDeadline(async () => {
                let next = target;

                for (let hops = 0; ; hops += 1) {
                    const current: NavigationOutcome = {};

                    outcome = current;

                    try {
                        // eslint-disable-next-line no-await-in-loop -- each hop is checked before the next is requested
                        await opened.goto(next, { timeout, waitUntil: navigate.waitUntil ?? "load" });
                    } catch (error) {
                        throw current.refusal ?? error;
                    }

                    if (current.refusal !== undefined) {
                        throw current.refusal;
                    }

                    if (current.redirect === undefined) {
                        break;
                    }

                    if (hops === MAX_REDIRECTS) {
                        throw new LunoraError(
                            "BROWSER_TOO_MANY_REDIRECTS",
                            `@lunora/browser: "${target}" redirected more than ${String(MAX_REDIRECTS)} times`,
                            {
                                status: 502,
                            },
                        );
                    }

                    next = current.redirect;
                }

                return use(opened);
            }, timeout);
        });
    };

    const screenshot = async (url: string, screenshotOptions: ScreenshotOptions = {}): Promise<Uint8Array> =>
        withPage(
            url,
            screenshotOptions,
            async (page) =>
                page.screenshot({
                    fullPage: screenshotOptions.fullPage ?? false,
                    type: screenshotOptions.type ?? "png",
                }),
            screenshotOptions.viewport,
        );

    const pdf = async (url: string, pdfOptions: PdfOptions = {}): Promise<Uint8Array> =>
        withPage(
            url,
            pdfOptions,
            async (page) =>
                page.pdf({
                    format: pdfOptions.format,
                    printBackground: pdfOptions.printBackground ?? false,
                }),
            pdfOptions.viewport,
        );

    const content = async (url: string, navigateOptions: NavigateOptions = {}): Promise<string> =>
        withPage(url, navigateOptions, async (page) => page.content());

    const scrape = async <T>(url: string, function_: (...args: never[]) => T, navigateOptions: NavigateOptions = {}): Promise<T> =>
        withPage(url, navigateOptions, async (page) => page.evaluate(function_));

    const launch = async <T>(function_: (browser: BrowserLike) => Promise<T>, launchOptions: { keepAlive?: number } = {}): Promise<T> =>
        withBrowser(async (browser) => function_(await guardBrowser(browser)), launchOptions.keepAlive);

    /**
     * Re-attach to an existing session. The browser is NOT closed on the way
     * out unless the caller asks — keeping the page alive across separate
     * action invocations is the entire point.
     */
    const connect = async <T>(sessionId: string, function_: (browser: BrowserLike) => Promise<T>, connectOptions: { close?: boolean } = {}): Promise<T> => {
        const browser = await requirePeer(options.connect, "connect")(options.binding, sessionId);

        if (connectOptions.close !== true) {
            return await function_(await guardBrowser(browser));
        }

        try {
            return await function_(await guardBrowser(browser));
        } finally {
            await closeQuietly(browser);
        }
    };

    const sessions = async (): Promise<ReadonlyArray<BrowserSession>> => await requirePeer(options.sessions, "sessions")(options.binding);

    const quickAction = async (action: QuickActionName, url: string, quickOptions: QuickActionOptions = {}): Promise<Response> => {
        if (typeof options.binding.quickAction !== "function") {
            throw new LunoraError(
                "INTERNAL",
                "@lunora/browser: the browser binding has no `quickAction` method — Quick Actions need a Browser Run binding with compatibility_date 2026-03-24 or later",
            );
        }

        // Types forbid it; untrusted JS can still pass it. An inline document is
        // not a URL, so none of the guards below would see what it loads.
        if (Object.hasOwn(quickOptions, "html")) {
            throw new LunoraError("BAD_REQUEST", "@lunora/browser: quickAction takes a url, not `html` — inline documents bypass the URL guard");
        }

        const target = await assertTargetAllowed(url, defaultDohTimeout());
        // Nested URLs load too — `addScriptTag[].url`, `addStyleTag[].url`, and
        // whatever Browser Run adds later — and a Quick Action has no session
        // guardrails behind it, so each passes the same guard as the target.
        // One check per distinct URL, however often it repeats, and a bounded
        // count — each check can start DoH lookups when `resolveDns` is on.
        const checks = new Map<string, Promise<string>>();
        const guardedOptions = await guardNestedUrls(quickOptions, async (nested) => {
            let check = checks.get(nested);

            if (check === undefined) {
                if (checks.size >= MAX_NESTED_QUICK_ACTION_URLS) {
                    throw new LunoraError(
                        "BAD_REQUEST",
                        `@lunora/browser: quickAction options carry more than ${String(MAX_NESTED_QUICK_ACTION_URLS)} distinct URLs`,
                    );
                }

                check = assertTargetAllowed(nested, defaultDohTimeout());
                checks.set(nested, check);
            }

            return check;
        });

        return options.binding.quickAction(action, { ...(guardedOptions as QuickActionOptions), url: target });
    };

    const { cancelCrawl, crawl, crawlResult } = createCrawlClient(options.restApi, allowedHosts !== undefined, async (url) =>
        assertTargetAllowed(url, defaultDohTimeout()),
    );

    return {
        cancelCrawl,
        connect,
        content,
        crawl,
        crawlResult,
        launch,
        pdf,
        quickAction,
        scrape,
        screenshot,
        sessions,
    };
};
