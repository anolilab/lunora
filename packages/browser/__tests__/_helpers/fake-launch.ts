import type { BrowserBindingLike, BrowserContextLike, BrowserLaunchLike, BrowserLike, PageLike, RouteLike, RouteResponseLike } from "../../src/types";

/** One response of the fake network. */
interface FakeResponse {
    body?: string;
    headers?: Record<string, string>;
    status: number;
}

/** What the guard did with one request it was handed. */
interface RouteOutcome {
    aborted?: string;
    continued: boolean;
    fetched: string[];
    fulfilled?: { body?: string; contentType?: string; response?: FakeApiResponse; status?: number };
}

interface FakeApiResponse extends RouteResponseLike {
    readonly url: string;
}

interface PageSpy extends PageLike {
    gotoCalls: string[];
    gotoOptions: ({ timeout?: number; waitUntil?: string } | undefined)[];
    screenshotCalls: Record<string, unknown>[];
    viewportCalls: { height: number; width: number }[];
}

interface BrowserSpy extends BrowserLike {
    closed: number;
    contextsOpened: number;
    pages: PageSpy[];
}

type RouteHandler = <TResponse extends RouteResponseLike>(route: RouteLike<TResponse>) => unknown;

interface FakeLaunch extends BrowserLaunchLike {
    browsers: BrowserSpy[];
    /** Hand one request to the newest handler, the way Playwright does, and report what the guard did. */
    dispatch: (url: string, kind: { frame?: unknown; navigation: boolean }) => Promise<RouteOutcome>;
    /** Every `launch` options object the factory passed. */
    launchOptions: (Record<string, unknown> | undefined)[];
    /** Every URL that reached the fake network, in order: what an SSRF test must keep private hosts out of. */
    requested: string[];
    /** Every handler registered with `context.route`, across all contexts. */
    routeHandlers: RouteHandler[];
}

interface FakeLaunchOptions {
    /** The browser's `close()` rejects. */
    closeThrows?: boolean;
    /** `page.goto` rejects, as a failed navigation does. */
    gotoThrows?: boolean;
    /** The network behind the browser. Default: every URL answers 200 with a small page. */
    network?: (url: string) => FakeResponse;
    /** Members to override on every page. */
    page?: Partial<PageLike>;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const PAGE_HTML = "<html><body>hi</body></html>";

const isRedirect = (response: FakeResponse): boolean => REDIRECTS.has(response.status) && response.headers?.["location"] !== undefined;

/** A binding marker the fake chain never calls; `fetch` only has to type-check. */
const fakeBinding = (): BrowserBindingLike => {
    return { fetch: async () => new Response() };
};

/**
 * A fake `@cloudflare/playwright` `launch` (browser → context → page) that models
 * the one Playwright behaviour the SSRF guard rests on: a `context.route` handler
 * is called for the FIRST request of a navigation only. Redirect hops, whether
 * the browser follows them after `route.continue()` or after a fulfilled 3xx,
 * reach the network without the handler seeing them. `route.fetch` follows up to
 * `maxRedirects` hops itself. Everything that reaches the network is recorded in
 * `requested`.
 */
const fakeLaunch = (config: FakeLaunchOptions = {}): FakeLaunch => {
    const network =
        config.network ??
        ((): FakeResponse => {
            return { body: PAGE_HTML, status: 200 };
        });
    const browsers: BrowserSpy[] = [];
    const requested: string[] = [];
    const routeHandlers: RouteHandler[] = [];

    /** The browser fetching `url` on its own: every hop follows without a handler. */
    const browserLoad = (url: string): FakeResponse => {
        let current = url;

        for (let hop = 0; hop <= 20; hop += 1) {
            requested.push(current);

            const response = network(current);

            if (!isRedirect(response)) {
                return response;
            }

            current = new URL(response.headers?.["location"] ?? "", current).href;
        }

        throw new Error("net::ERR_TOO_MANY_REDIRECTS");
    };

    const runHandler = async (handler: RouteHandler, url: string, kind: { frame?: unknown; navigation: boolean }): Promise<RouteOutcome> => {
        const outcome: RouteOutcome = { continued: false, fetched: [] };

        const route: RouteLike<FakeApiResponse> = {
            abort: async (errorCode) => {
                outcome.aborted = errorCode ?? "failed";
            },
            continue: async () => {
                outcome.continued = true;
            },
            fetch: async (options) => {
                let current = url;

                for (let hop = 0; ; hop += 1) {
                    requested.push(current);
                    outcome.fetched.push(current);

                    const response = network(current);

                    if (!isRedirect(response) || hop >= (options?.maxRedirects ?? 20)) {
                        const finalUrl = current;

                        return { headers: () => response.headers ?? {}, status: () => response.status, url: finalUrl };
                    }

                    current = new URL(response.headers?.["location"] ?? "", current).href;
                }
            },
            fulfill: async (options) => {
                outcome.fulfilled = options;
            },
            request: () => {
                return { frame: () => kind.frame, isNavigationRequest: () => kind.navigation, url: () => url };
            },
        };

        await handler(route);

        return outcome;
    };

    /** The one frame every fake page reports as its main frame. */
    const mainFrame = { main: true };

    /**
     * A page navigation as Chromium + Playwright run it: the route handler (if
     * any) sees the first request only, and every redirect the browser follows
     * afterwards reaches the network unseen.
     */
    const navigate = async (url: string, handler: RouteHandler | undefined): Promise<void> => {
        if (handler === undefined) {
            browserLoad(url);

            return;
        }

        const outcome = await runHandler(handler, url, { frame: mainFrame, navigation: true });

        if (outcome.aborted !== undefined) {
            throw new Error(`net::ERR_${outcome.aborted.toUpperCase()} at ${url}`);
        }

        if (outcome.continued) {
            browserLoad(url);

            return;
        }

        // A fulfilled redirect is followed by the browser, unguarded.
        const response = outcome.fulfilled?.response;
        const location = response?.headers()["location"];

        if (response !== undefined && REDIRECTS.has(response.status()) && location !== undefined) {
            browserLoad(new URL(location, response.url).href);
        }
    };

    const makePage = (handler: () => RouteHandler | undefined): PageSpy => {
        const page: PageSpy = {
            content: async () => PAGE_HTML,
            evaluate: async (function_) => function_(),
            goto: async (url, gotoOptions) => {
                page.gotoCalls.push(url);
                page.gotoOptions.push(gotoOptions);

                if (config.gotoThrows) {
                    throw new Error("navigation failed");
                }

                await navigate(url, handler());

                return undefined;
            },
            gotoCalls: [],
            gotoOptions: [],
            mainFrame: () => mainFrame,
            pdf: async () => new Uint8Array([37, 80, 68, 70]),
            screenshot: async (screenshotOptions) => {
                page.screenshotCalls.push(screenshotOptions ?? {});

                return new Uint8Array([137, 80, 78, 71]);
            },
            screenshotCalls: [],
            setViewportSize: async (viewport) => {
                page.viewportCalls.push(viewport);
            },
            viewportCalls: [],
            ...config.page,
        };

        return page;
    };

    const makeContext = (pages: PageSpy[]): BrowserContextLike => {
        let handler: RouteHandler | undefined;

        return {
            newPage: async () => {
                const page = makePage(() => handler);

                pages.push(page);

                return page;
            },
            route: async (_pattern, registered) => {
                handler = registered;
                routeHandlers.push(registered);
            },
        };
    };

    const launch = (async (_binding: BrowserBindingLike, launchOptions?: Record<string, unknown>): Promise<BrowserLike> => {
        launch.launchOptions.push(launchOptions);

        const browser: BrowserSpy = {
            close: async () => {
                browser.closed += 1;

                if (config.closeThrows) {
                    throw new Error("close failed");
                }
            },
            closed: 0,
            contextsOpened: 0,
            newContext: async () => {
                browser.contextsOpened += 1;

                return makeContext(browser.pages);
            },
            pages: [],
        };

        browsers.push(browser);

        return browser;
    }) as FakeLaunch;

    launch.browsers = browsers;
    launch.launchOptions = [];
    launch.requested = requested;
    launch.routeHandlers = routeHandlers;
    launch.dispatch = async (url, kind) => {
        const handler = routeHandlers.at(-1);

        if (handler === undefined) {
            throw new Error("no route handler registered");
        }

        return runHandler(handler, url, kind);
    };

    return launch;
};

export type { BrowserSpy, FakeLaunch, FakeResponse, PageSpy, RouteOutcome };
export { fakeBinding, fakeLaunch };
