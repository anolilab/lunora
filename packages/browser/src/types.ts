/**
 * Structural projection of the Cloudflare **Browser Rendering** binding
 * (`env.BROWSER`). The binding is a `Fetcher` under the hood — `@cloudflare/playwright`
 * drives it via `launch(env.BROWSER)`. Declared locally (an empty structural
 * marker) so unit tests can pass a plain-object double and the real binding
 * satisfies the same shape without importing `@cloudflare/workers-types` into
 * the public surface. See https://developers.cloudflare.com/browser-rendering/.
 *
 * It is intentionally opaque: callers never touch the binding directly, they
 * hand it to {@link LunoraBrowserOptions.binding} and the Playwright layer
 * consumes it. `fetch` is REQUIRED (the real binding is a `Fetcher`, so it
 * always has one) so the marker actually excludes an arbitrary value like `{}` —
 * a bare object fails to type-check where a binding is required, catching the
 * misuse at the call site instead of deferring to an opaque launch error.
 * @experimental
 */
export interface BrowserBindingLike {
    readonly fetch: typeof fetch;

    /**
     * Browser Run Quick Actions over the binding (`env.BROWSER.quickAction`,
     * compatibility date `2026-03-24` or later). Optional: an older binding, or
     * one typed as a plain `Fetcher`, lacks it, and only
     * {@link Browser.quickAction} needs it. Method syntax on purpose — the real
     * `BrowserRun` declares one overload per action, which only a bivariant
     * method parameter accepts.
     */
    // eslint-disable-next-line @typescript-eslint/method-signature-style -- see above: a property signature rejects the real overloaded binding
    quickAction?(action: QuickActionName, options: { url: string }): Promise<Response>;
}

/**
 * The Browser Run Quick Actions reachable through the binding. `accessibilityTree`
 * is newer than the `@cloudflare/workers-types` overloads, so it is listed here
 * rather than derived from them.
 * @experimental
 */
export type QuickActionName = "accessibilityTree" | "content" | "json" | "links" | "markdown" | "pdf" | "scrape" | "screenshot" | "snapshot";

/**
 * The page representations `/snapshot` can return in one call. Browser Run's
 * default is `["content", "screenshot"]` and it requires at least two.
 * @experimental
 */
export type SnapshotFormat = "accessibilityTree" | "content" | "markdown" | "screenshot";

/**
 * Per-action Quick Action options, forwarded to the binding as-is. The target
 * is the `url` argument of {@link Browser.quickAction}, so `url` and `html` are
 * not accepted here: an inline `html` document would bypass the URL guard.
 * See https://developers.cloudflare.com/browser-run/quick-actions/ for every
 * action's fields.
 * @experimental
 */
export interface QuickActionOptions {
    [key: string]: unknown;
    /** `snapshot` only: which representations to return (at least two). */
    formats?: ReadonlyArray<SnapshotFormat>;
    html?: never;
    /** `accessibilityTree` only: return just the semantically meaningful nodes. */
    interestingOnly?: boolean;
    url?: never;
}

/**
 * Cloudflare account credentials for the Browser Run REST API. The `/crawl`
 * endpoint has no binding method, so {@link Browser.crawl} and its siblings
 * call `api.cloudflare.com` with a bearer token instead.
 * @experimental
 */
export interface BrowserRestApiOptions {
    accountId: string;
    /** API token with `Browser Rendering - Edit`. A secret — keep it in `.dev.vars` / `wrangler secret`. */
    apiToken: string;
}

/**
 * Output formats a crawl can return per page.
 * @experimental
 */
export type CrawlFormat = "html" | "json" | "markdown";

/**
 * Options for {@link Browser.crawl}, mirroring the `/crawl` request body.
 * See https://developers.cloudflare.com/browser-run/quick-actions/crawl-endpoint/.
 * @experimental
 */
export interface CrawlOptions {
    /**
     * The Content Signals `use` level you declare. A site whose robots.txt sets
     * a stricter level rejects the crawl with a 400. Default `full`.
     */
    contentUse?: "full" | "reference";
    /** Purposes the crawl is for, checked against the site's Content Signals. Default: all three. */
    crawlPurposes?: ReadonlyArray<"ai-input" | "ai-train" | "search">;
    /** Maximum link depth from the starting URL. */
    depth?: number;
    /** Per-page output formats. Default `["html"]`. */
    formats?: ReadonlyArray<CrawlFormat>;
    /** Maximum number of pages to crawl (Browser Run default 10, maximum 100,000). */
    limit?: number;
    options?: {
        excludePatterns?: ReadonlyArray<string>;
        /** Refused when `allowedHosts` is configured: the crawler would leave the allowlist. */
        includeExternalLinks?: boolean;
        includePatterns?: ReadonlyArray<string>;
        /** Refused when `allowedHosts` is configured: subdomains are not exact allowlist matches. */
        includeSubdomains?: boolean;
    };
    /** `false` fetches HTML without executing JavaScript. Default `true`. */
    render?: boolean;
    /** Where pages are discovered from. Default `all`. */
    source?: "all" | "links" | "sitemaps";
}

/**
 * Status of a whole crawl job.
 * @experimental
 */
export type CrawlJobStatus = "cancelled_by_user" | "cancelled_due_to_limits" | "cancelled_due_to_timeout" | "completed" | "errored" | "running";

/**
 * Status of one crawled URL.
 * @experimental
 */
export type CrawlRecordStatus = "cancelled" | "completed" | "disallowed" | "errored" | "queued" | "skipped";

/**
 * One crawled page. Only the formats the crawl asked for are present.
 * @experimental
 */
export interface CrawlRecord {
    html?: string;
    json?: unknown;
    markdown?: string;
    metadata?: { status?: number; title?: string; url?: string };
    status: CrawlRecordStatus;
    url: string;
}

/**
 * A crawl job and one page of its records, as `GET /crawl/{id}` returns it.
 * @experimental
 */
export interface CrawlJob {
    browserSecondsUsed?: number;
    /** Pass back as {@link CrawlResultOptions.cursor} for the next page; absent on the last one. */
    cursor?: number | string;
    finished: number;
    id: string;
    records: CrawlRecord[];
    status: CrawlJobStatus;
    total: number;
}

/**
 * Paging and filtering for {@link Browser.crawlResult}.
 * @experimental
 */
export interface CrawlResultOptions {
    cursor?: number | string;
    limit?: number;
    status?: CrawlRecordStatus;
}

/**
 * The crawl configuration Browser Run echoes in crawl lifecycle events.
 * @experimental
 */
export interface BrowserRunCrawlEventConfig {
    depth: number;
    formats: CrawlFormat[];
    limit: number;
    render: boolean;
    source: "all" | "links" | "sitemaps";
    url: string;
}

/**
 * Envelope fields shared by every Browser Run Queues event.
 * @experimental
 */
export interface BrowserRunEventEnvelope {
    metadata: { accountId: string; eventSchemaVersion: number; eventSubscriptionId: string; eventTimestamp: string };
    source: { type: "browserRun" };
}

/**
 * A crawl lifecycle event delivered to a Queue by an account-level subscription
 * (`wrangler queues subscription create --source browserRun --events
 * crawl.started,crawl.updated,crawl.finished`). Narrow on `type`. It carries
 * status, not page content — fetch that with {@link Browser.crawlResult}.
 * See https://developers.cloudflare.com/queues/event-subscriptions/events-schemas/.
 * @experimental
 */
export type BrowserRunCrawlEvent =
    | (BrowserRunEventEnvelope & {
          payload: {
              completed: number;
              crawlConfig: BrowserRunCrawlEventConfig;
              createdAt: string;
              errored: number;
              finishedAt: string;
              jobId: string;
              jobStatus: CrawlJobStatus;
              skipped: number;
              total: number;
          };
          type: "cf.browserRun.crawl.finished";
      })
    | (BrowserRunEventEnvelope & {
          payload: { crawlConfig: BrowserRunCrawlEventConfig; createdAt: string; jobId: string };
          type: "cf.browserRun.crawl.started";
      })
    | (BrowserRunEventEnvelope & {
          payload: { crawlStatus: CrawlRecordStatus; httpStatus: number; jobId: string; url: string };
          type: "cf.browserRun.crawl.updated";
      });

/**
 * Minimal projection of a Playwright `Route` (the argument the `page.route`
 * handler receives). Only the members the SSRF redirect guard drives are
 * declared: inspect the intercepted request's URL / navigation-ness, then either
 * let it proceed ({@link RouteLike.continue}) or reject it ({@link RouteLike.abort}).
 */
export interface RouteLike {
    /** Reject the intercepted request (fail-closed); `errorCode` is a Playwright abort reason. */
    abort: (errorCode?: string) => Promise<void>;
    /** Allow the intercepted request to proceed. */
    continue: () => Promise<void>;
    /** The intercepted request: its URL and (when available) whether it is a top-level navigation. */
    request: () => { isNavigationRequest?: () => boolean; url: () => string };
}

/**
 * Minimal projection of a Playwright `Page` — just the methods the helpers drive.
 * Declared structurally so a test can inject a plain stub instead of a real
 * headless page (which needs workerd + the Browser Rendering binding).
 * @experimental
 */
export interface PageLike {
    /** Return the page's serialized HTML after the navigation settles. */
    content: () => Promise<string>;
    /** Run a function in the page context and return its (serializable) result. */
    evaluate: <T>(function_: () => T) => Promise<T>;

    /** Navigate to a URL; resolves once the configured wait condition is met. */
    goto: (url: string, options?: { timeout?: number; waitUntil?: "commit" | "domcontentloaded" | "load" | "networkidle" }) => Promise<unknown>;
    /** Render the page to a PDF buffer. */
    pdf: (options?: Record<string, unknown>) => Promise<Uint8Array>;

    /**
     * Register a request interceptor (Playwright `page.route`). Optional: a fake
     * or older page double without it still works — the SSRF redirect guard only
     * activates when interception is available, and the initial-URL guard applies
     * regardless. `pattern` follows Playwright's glob/URL matcher.
     */
    route?: (pattern: string, handler: (route: RouteLike) => unknown) => Promise<void>;
    /** Render the page to a PNG/JPEG buffer. */
    screenshot: (options?: Record<string, unknown>) => Promise<Uint8Array>;
    /** Constrain the page viewport (a hard cap so a hostile page can't pin the worker). */
    setViewportSize?: (viewport: { height: number; width: number }) => Promise<void>;
}

/**
 * Minimal projection of a Playwright `BrowserContext`. Only `newPage` is used;
 * declared structurally for the same test-double reason as {@link PageLike}.
 * @experimental
 */
export interface BrowserContextLike {
    newPage: () => Promise<PageLike>;
}

/**
 * Minimal projection of a Playwright `Browser` (the value `launch` resolves to).
 * Only `newContext`/`close` are used; declared structurally for the same
 * test-double reason as {@link PageLike}.
 * @experimental
 */
export interface BrowserLike {
    close: () => Promise<void>;
    newContext: () => Promise<BrowserContextLike>;

    /**
     * The Browser Rendering session this browser is attached to, when the
     * runtime exposes it.
     *
     * Optional because this is a structural projection, not a re-declaration of
     * the upstream Playwright type — but without it there is no way to learn
     * the id of a session you just held open with `launch(fn, { keepAlive })`,
     * which makes {@link Browser.connect} unreachable except by guessing from
     * {@link Browser.sessions}.
     */
    sessionId?: () => string | undefined;
}

/* eslint-disable no-secrets/no-secrets -- the entropy scanner trips on the repeated `@cloudflare/playwright` package name in these doc comments, not a credential */

/**
 * Structural projection of `@cloudflare/playwright`'s `launch` export
 * (`import { launch } from "@cloudflare/playwright"`). Injected via
 * {@link LunoraBrowserOptions.launch} so the factory never imports
 * `@cloudflare/playwright` at module top — that keeps the heavy optional peer
 * dep out of the bundle for apps that never screenshot, and lets tests pass a
 * fake. Calling it with the Browser Rendering binding resolves a {@link BrowserLike}.
 * @experimental
 */
export type BrowserLaunchLike = (binding: BrowserBindingLike, options?: Record<string, unknown>) => Promise<BrowserLike>;

/**
 * One live Browser Run session, as `@cloudflare/playwright`'s `sessions()`
 * reports it. `connectionId` is set while a worker is connected. Sessions accept
 * several concurrent connections, so a set `connectionId` does not stop
 * {@link Browser.connect}; it only tells you the browser is shared.
 * @experimental
 */
export interface BrowserSession {
    connectionId?: string;
    sessionId: string;
    startTime?: number;
}

/**
 * Structural projection of `@cloudflare/playwright`'s `connect` export —
 * re-attaches to an existing session rather than starting a new browser.
 * Injected like {@link BrowserLaunchLike} so the peer dep stays optional.
 * @experimental
 */
export type BrowserConnectLike = (binding: BrowserBindingLike, sessionId: string) => Promise<BrowserLike>;

/**
 * Structural projection of `@cloudflare/playwright`'s `sessions` export — lists
 * the account's live Browser Rendering sessions for this binding.
 * @experimental
 */
export type BrowserSessionsLike = (binding: BrowserBindingLike) => Promise<ReadonlyArray<BrowserSession>>;

/**
 * Options shared by the page-driving helpers ({@link Browser.screenshot} etc.).
 * @experimental
 */
export interface NavigateOptions {
    /**
     * Hard timeout in milliseconds for the navigation + operation. Clamped to a
     * sane ceiling so a hung/hostile page can't pin the worker. Default 30000.
     */
    timeoutMs?: number;

    /**
     * Playwright navigation wait condition. Playwright's set differs from
     * Puppeteer's: `load`, `domcontentloaded`, `networkidle`, `commit`.
     * Default `load`.
     */
    waitUntil?: "commit" | "domcontentloaded" | "load" | "networkidle";
}

/**
 * Options for {@link Browser.screenshot}.
 * @experimental
 */
export interface ScreenshotOptions extends NavigateOptions {
    /** Capture the full scrollable page rather than just the viewport. */
    fullPage?: boolean;
    /** Image encoding. Default `png`. */
    type?: "jpeg" | "png";

    /**
     * Viewport size. Each dimension is hard-capped (see the factory's
     * `MAX_VIEWPORT_*`) so a caller can't request a multi-million-pixel render.
     */
    viewport?: { height: number; width: number };
}

/**
 * Options for {@link Browser.pdf}.
 * @experimental
 */
export interface PdfOptions extends NavigateOptions {
    /** Paper format (`A4`, `Letter`, …) forwarded to Playwright. */
    format?: string;
    /** Print background graphics. Default `false`. */
    printBackground?: boolean;

    /**
     * Viewport used while laying out the page before printing. Hard-capped like
     * {@link ScreenshotOptions.viewport}.
     */
    viewport?: { height: number; width: number };
}

/**
 * `LunoraBrowserOptions` is part of the experimental `@lunora/browser` API and may change without a major version bump.
 * @experimental
 */
export interface LunoraBrowserOptions {
    /**
     * Strict host allowlist. When set, a navigation URL is refused unless its
     * hostname exactly matches one of these entries (case-insensitive,
     * trailing-dot-normalized, IPv6 brackets stripped). This is the only guard
     * that fully closes DNS rebinding: a public hostname that resolves to a
     * private/metadata IP can still be pinned out if it isn't on the list. Set it
     * whenever you pass client-controlled URLs to the browser.
     *
     * **`allowedHosts: []` allows NOTHING.** An empty list is a configured
     * allowlist with no members, so every navigation, redirect hop and http(s)
     * sub-resource is refused with a `FORBIDDEN` naming the empty list — it is
     * never read as "no allowlist configured". To run without an allowlist, omit
     * the option; that is the guarded default described below. (The allowlist arm
     * is not relaxed by {@link LunoraBrowserOptions.allowPrivateTargets}, so an
     * empty list refuses private targets too.)
     *
     * Leaving it unset (the default) is NOT unguarded: it turns
     * {@link LunoraBrowserOptions.resolveDns} on, so every host is resolved over
     * DoH and refused if it maps to a private address. Setting an allowlist —
     * empty or not — turns that re-check off by default (the allowlist is the
     * stronger guard, and may deliberately name an internal host); `resolveDns:
     * true` forces both.
     *
     * Every browser this factory launches also gets the list as Browser Run
     * session guardrails (`guardrails.allowedDomains`), so Cloudflare enforces it
     * on redirects and sub-resources too, including inside the raw
     * {@link Browser.launch} escape hatch, which has no Lunora-side interception.
     * Guardrails accept at most 50 entries, so a longer list is refused at
     * launch. Quick Actions and crawls have no guardrails: for those the list is
     * checked against the starting URL only.
     */
    allowedHosts?: string[];

    /**
     * Opt out of the SSRF guard that, by default, refuses to navigate to a
     * private / internal / loopback / link-local host (RFC1918, `127.0.0.0/8`,
     * `169.254.0.0/16` incl. the cloud-metadata address, CGNAT, IPv6 ULA/
     * link-local, and `localhost` / `*.internal` / `*.local` literals). Leave it
     * `false` (the default) unless every caller-supplied URL is trusted — e.g.
     * you deliberately drive the browser at an internal service reachable through
     * a Cloudflare Tunnel / private-network binding. Setting it `true` re-opens
     * the SSRF surface, so never combine it with caller-controlled URLs.
     */
    allowPrivateTargets?: boolean;

    /** The Cloudflare Browser Rendering binding (`env.BROWSER`). Required. */
    binding: BrowserBindingLike;

    /**
     * The `@cloudflare/playwright` `connect` function, injected like
     * {@link LunoraBrowserOptions.launch}. Required for {@link Browser.connect}.
     */
    connect?: BrowserConnectLike;

    /**
     * The `@cloudflare/playwright` `launch` function. Injected rather than
     * imported at module top so the optional peer dep stays out of the bundle
     * for non-browser apps and tests can pass a double.
     *
     * The APP passes the real function, not codegen: the generated shard builds
     * `ctx.browser` from a `config.browser` thunk and falls back to a throwing
     * stub, so `createShardDO({ browser: (env) => createBrowser({ binding:
     * env.BROWSER, launch }) })` is what wires it. Omitting `launch` makes the
     * helper throw on first use with a clear "install `@cloudflare/playwright`"
     * error.
     */
    launch?: BrowserLaunchLike;

    /**
     * Best-effort DNS-rebinding re-check. When `true` (and `allowPrivateTargets`
     * is `false`), the factory resolves the URL's hostname over Cloudflare DoH
     * (`https://cloudflare-dns.com/dns-query`) and refuses to navigate if any
     * resolved A/AAAA record is a private/internal address — closing the gap
     * where a public hostname resolves to a private IP after the string guard
     * passes.
     *
     * **On by default when no {@link LunoraBrowserOptions.allowedHosts} is set**,
     * because a `scrape`/`screenshot` action that forwards a client-supplied URL
     * is the common shape and the string guard alone lets
     * `http://127.0.0.1.nip.io:8787/…` through to an internal service. It costs
     * one DNS round-trip per navigation and is TOCTOU-imperfect (the browser
     * re-resolves independently), and if the DoH lookup itself fails it falls
     * back to the string guard rather than allowing a resolved private IP.
     *
     * Configuring `allowedHosts` at all — an empty list included, since that
     * refuses every navigation outright — turns it OFF by default: an exact-origin
     * allowlist is the stronger guard and may deliberately name an internal host
     * (reachable over a Tunnel / private-network binding) that a resolved-address
     * check would refuse. Set this explicitly to `true` to run both, or to
     * `false` for trusted, non-caller-supplied URLs where the round-trip matters.
     */
    resolveDns?: boolean;
    /* eslint-enable no-secrets/no-secrets */

    /**
     * Account id + API token for the Browser Run REST API. Required only for
     * {@link Browser.crawl}, {@link Browser.crawlResult} and
     * {@link Browser.cancelCrawl}, which have no binding method.
     */
    restApi?: BrowserRestApiOptions;

    /**
     * The `@cloudflare/playwright` `sessions` function, injected like
     * {@link LunoraBrowserOptions.launch}. Required for {@link Browser.sessions}.
     */
    sessions?: BrowserSessionsLike;

    /**
     * Default navigation timeout (ms) applied when a per-call `timeoutMs` is not
     * given. Clamped to the factory's `MAX_TIMEOUT_MS`. Default 30000.
     */
    timeoutMs?: number;
}

/**
 * The `ctx.browser` surface — Cloudflare Browser Rendering driven through
 * `@cloudflare/playwright`. **Action-only**: every method performs
 * non-deterministic network I/O (it navigates a real headless browser to a
 * URL), so codegen wires it onto `ActionCtx` exclusively — never `QueryCtx`/
 * `MutationCtx` — exactly like `ctx.ai` / `ctx.fetch`. Each helper launches a
 * browser, opens a context + page, navigates, performs the op, and always
 * closes the browser in a `finally` (a leaked session is billed and
 * rate-limited).
 * @experimental
 */
export interface Browser {
    /** Cancel a running crawl job. Needs {@link LunoraBrowserOptions.restApi}. */
    cancelCrawl: (jobId: string) => Promise<void>;

    /**
     * Re-attach to an existing session and hand the browser to `fn`.
     *
     * Get the id either by reading it inside the call that opened the session
     * (`launch(async (browser) => browser.sessionId?.(), { keepAlive: 600 })`)
     * and persisting it, or by picking a free one out of
     * {@link Browser.sessions}.
     *
     * Several workers may be connected to one session at once. Open your own
     * context (`browser.newContext()`) per caller so pages, cookies and storage
     * stay apart, and close that context when you are done.
     *
     * The session is deliberately **left open** afterwards — closing it is the
     * whole thing you are avoiding. `close: true` closes the browser itself, for
     * every connected client, so pass it only from the flow that owns the
     * session; otherwise let `keepAlive` lapse.
     *
     * This is what makes agent-style browsing possible: a model calls
     * `navigate`, then `click`, then `extract` as three separate action
     * invocations, and the page has to survive between them. With only the
     * per-call lifecycle each step got a fresh browser, so `click` ran against
     * a blank page — silently, which is the worst shape for that bug.
     */
    connect: <T>(sessionId: string, function_: (browser: BrowserLike) => Promise<T>, options?: { close?: boolean }) => Promise<T>;

    /** Serialized HTML of `url` after navigation settles. */
    content: (url: string, options?: NavigateOptions) => Promise<string>;

    /**
     * Start an asynchronous Browser Run crawl from `url` and return its job id.
     * Poll with {@link Browser.crawlResult}, or subscribe a Queue to crawl events
     * (see {@link BrowserRunCrawlEvent}). The crawler respects robots.txt and
     * Content Signals. `url` passes the same guards as a navigation; pages the
     * crawler discovers afterwards are outside Lunora's reach, which is why
     * `includeExternalLinks` / `includeSubdomains` are refused under
     * `allowedHosts`. Needs {@link LunoraBrowserOptions.restApi}: `/crawl` is
     * REST-only.
     */
    crawl: (url: string, options?: CrawlOptions) => Promise<string>;

    /** Read a crawl job's status and one page of its records. Needs {@link LunoraBrowserOptions.restApi}. */
    crawlResult: (jobId: string, options?: CrawlResultOptions) => Promise<CrawlJob>;

    /**
     * Low-level escape hatch: launch a raw Playwright `Browser` and hand it to
     * `fn` (e.g. for multi-page flows or APIs not surfaced here).
     *
     * The browser is **always closed** when `fn` resolves or throws — unless
     * `keepAlive` is a number of seconds **between 10 and 600**, which holds the
     * session open for that long so a later {@link Browser.connect} can
     * re-attach. `0`, a negative value and `NaN` all mean "do not keep alive"
     * and take the always-close path (a held session is billed, so the
     * ambiguous values fall to the safe side); a positive value outside the
     * 10–600s window Browser Rendering accepts throws `BAD_REQUEST` rather than
     * being sent on for the provider to refuse. Do not retain references to the
     * browser past the callback either way.
     */
    launch: <T>(function_: (browser: BrowserLike) => Promise<T>, options?: { keepAlive?: number }) => Promise<T>;

    /** Render `url` to a PDF buffer. */
    pdf: (url: string, options?: PdfOptions) => Promise<Uint8Array>;

    /**
     * Run a Browser Run Quick Action on `url` through the binding — one request,
     * no Playwright session: `markdown`, `snapshot` (several `formats` at once),
     * `accessibilityTree`, `links`, `json` (AI extraction), and the rest.
     *
     * Returns Browser Run's `Response` untouched: binary for `screenshot`/`pdf`,
     * JSON otherwise, and an error JSON body with a non-2xx status on failure.
     * `url` passes the same guards as a navigation, but Quick Actions have no
     * request interception or guardrails, so redirects and sub-resources are not
     * re-checked. Needs a binding with `quickAction` (compatibility date
     * `2026-03-24` or later).
     */
    quickAction: (action: QuickActionName, url: string, options?: QuickActionOptions) => Promise<Response>;

    /**
     * Navigate to `url`, run `fn` inside the page context, and return its
     * (serializable) result. `fn` runs in the browser, not the worker — it
     * cannot close over worker-side variables.
     */
    scrape: <T>(url: string, function_: (...args: never[]) => T, options?: NavigateOptions) => Promise<T>;

    /** Render `url` to an image buffer (PNG by default). */
    screenshot: (url: string, options?: ScreenshotOptions) => Promise<Uint8Array>;

    /**
     * List the live Browser Run sessions for this binding, so a caller can pick
     * one to {@link Browser.connect} to. An entry with a `connectionId` already
     * has a worker connected; connecting as well shares that browser.
     */
    sessions: () => Promise<ReadonlyArray<BrowserSession>>;
}
