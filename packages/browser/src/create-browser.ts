import type { Browser, BrowserLaunchLike, BrowserLike, CirrusBrowserOptions, NavigateOptions, PageLike, PdfOptions, ScreenshotOptions } from "./types";

/** Default navigation timeout when neither the call nor the factory sets one. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Hard ceiling on any navigation timeout — a hung page can't pin the worker forever. */
const MAX_TIMEOUT_MS = 120_000;

/** Hard caps on a requested viewport so a caller can't ask for a multi-million-pixel render. */
const MAX_VIEWPORT_WIDTH = 3840;
const MAX_VIEWPORT_HEIGHT = 4320;

/**
 * Reject anything that isn't an absolute `http(s)` URL up front (the spirit of
 * `validateKey` in `@cirrus/storage`): a non-string, empty, relative, or
 * non-`http(s)` value (e.g. `javascript:`, `file:`, `ftp:`, `data:`) never
 * reaches the headless browser, so a hostile caller can't drive it to a local
 * file or a non-network scheme. Returns the normalized absolute URL string.
 */
const validateUrl = (url: string): string => {
    if (typeof url !== "string" || url.length === 0) {
        throw new Error("@cirrus/browser: url must be a non-empty string");
    }

    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`@cirrus/browser: url must be an absolute http(s) URL (got "${url}")`);
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`@cirrus/browser: url protocol must be http(s) (got "${parsed.protocol}")`);
    }

    return parsed.toString();
};

/** Clamp a requested viewport to the hard caps; both dimensions floored to >= 1. */
const clampViewport = (viewport: { height: number; width: number }): { height: number; width: number } => {
    return {
        height: Math.min(Math.max(1, Math.floor(viewport.height)), MAX_VIEWPORT_HEIGHT),
        width: Math.min(Math.max(1, Math.floor(viewport.width)), MAX_VIEWPORT_WIDTH),
    };
};

/** Resolve and clamp a navigation timeout from the per-call + factory defaults. */
const resolveTimeout = (callTimeout: number | undefined, factoryTimeout: number | undefined): number => {
    const requested = callTimeout ?? factoryTimeout ?? DEFAULT_TIMEOUT_MS;

    return Math.min(Math.max(1, Math.floor(requested)), MAX_TIMEOUT_MS);
};

// eslint-disable-next-line import/prefer-default-export -- named export: the package barrel re-exports by name, per the repo's no-default-mixing convention
export const createBrowser = (options: CirrusBrowserOptions): Browser => {
    // Defensive runtime guard: `binding` is required by the type, but JS callers
    // (and `createBrowser({})` misuse) can omit it.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guards untrusted JS callers despite the type
    if (!options.binding) {
        throw new Error("@cirrus/browser: `binding` is required (env.BROWSER)");
    }

    const getLaunch = (): BrowserLaunchLike => {
        if (!options.launch) {
            throw new Error(
                '@cirrus/browser: `launch` is not available — install the `@cloudflare/playwright` peer dependency. The generated worker wires it for you; outside codegen pass it via createBrowser({ binding, launch }) (import { launch } from "@cloudflare/playwright").',
            );
        }

        return options.launch;
    };

    /**
     * Launch a browser, run `use`, and **always** close the browser in a
     * `finally` — a leaked Browser Rendering session is billed and rate-limited,
     * so this is the one real footgun. The close error is swallowed (we never
     * mask the caller's original error with a close failure).
     */
    const withBrowser = async <T>(use: (browser: BrowserLike) => Promise<T>): Promise<T> => {
        const browser = await getLaunch()(options.binding);

        try {
            return await use(browser);
        } finally {
            try {
                await browser.close();
            } catch {
                // Swallow: the session is being torn down anyway, and a close
                // failure must not mask the caller's result/error.
            }
        }
    };

    /**
     * Open a context + page, navigate to `url`, run `use`. The page/context are
     * torn down when the browser is closed by {@link withBrowser}'s `finally`,
     * so a single always-close at the browser level covers the whole chain.
     */
    const withPage = async <T>(
        url: string,
        navigate: NavigateOptions,
        use: (page: PageLike) => Promise<T>,
        viewport?: { height: number; width: number },
    ): Promise<T> => {
        const target = validateUrl(url);
        const timeout = resolveTimeout(navigate.timeoutMs, options.timeoutMs);

        return withBrowser(async (browser) => {
            const context = await browser.newContext();
            const page = await context.newPage();

            if (viewport && page.setViewportSize) {
                await page.setViewportSize(clampViewport(viewport));
            }

            await page.goto(target, { timeout, waitUntil: navigate.waitUntil ?? "load" });

            return use(page);
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

    const launch = async <T>(function_: (browser: BrowserLike) => Promise<T>): Promise<T> => withBrowser(function_);

    return {
        content,
        launch,
        pdf,
        scrape,
        screenshot,
    };
};
