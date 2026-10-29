/* eslint-disable sonarjs/no-clear-text-protocols -- the private redirect targets the guard must refuse are plain http by design; nothing connects to them */

/**
 * Live smoke test for `@lunora/browser` against a real Browser Run binding.
 *
 * Deployed by `scripts/browser-smoke.sh`; never part of the package build or
 * publish. The Worker is its own test fixture: it serves the pages and the
 * attacker-like endpoints (redirects to private addresses, a service worker, a
 * header echo) that the checks point Browser Run at, so nothing third-party is
 * involved. `GET /report` runs every check and answers a JSON pass/fail report.
 *
 * The decisions themselves (what is refused, which headers a hop keeps) are
 * unit-tested against fakes in `__tests__/`. What only a real session can show
 * is that the guard's mechanisms work there: `route.fetch` / `route.fulfill`
 * inside Browser Run, `serviceWorkers: "block"`, and the abort reason Chromium
 * reports for a request the guard refused.
 */
import { launch } from "@cloudflare/playwright";

import { createBrowser } from "../../src/create-browser";
import type { BrowserLike, PageLike } from "../../src/types";

interface Env {
    BROWSER: Fetcher;
    /** Optional: a second origin serving this Worker, for the cross-origin hop. Defaults to this version's preview URL. */
    CROSS_ORIGIN?: string;
    VERSION: { id: string };
}

interface Check {
    detail: string;
    name: string;
    pass: boolean;
}

/** A page as the smoke checks drive it: the projection plus the failure event. */
interface SmokePage extends PageLike {
    on: (event: "requestfailed", listener: (request: { failure: () => { errorText: string } | null; url: () => string }) => void) => void;
}

const PRIVATE_TARGET = "http://169.254.169.254/latest/meta-data/";

const html = (body: string): Response =>
    new Response(`<!doctype html><html><head><title>pending</title></head><body>${body}</body></html>`, { headers: { "content-type": "text/html" } });

/** A page script that runs `work` and writes its outcome into `document.title` for a check to read. */
const titleScript = (work: string): string =>
    `<script>(async () => { try { document.title = await (${work})(); } catch (error) { document.title = "error:" + error.name; } })();</script>`;

/** The endpoints the checks point Browser Run at. */
const fixture = (url: URL, env: Env): Response | undefined => {
    const origin = env.CROSS_ORIGIN ?? `https://${env.VERSION.id.slice(0, 8)}-${url.host}`;

    switch (url.pathname) {
        case "/img-to-metadata": {
            return html('<p>smoke-ok</p><img id="probe" src="/redirect-to-metadata">');
        }
        case "/page": {
            return html("<h1>smoke-ok</h1>");
        }
        case "/redirect-cross-origin": {
            return Response.redirect(`${origin}/echo-headers`, 302);
        }
        case "/redirect-to-metadata": {
            return Response.redirect(PRIVATE_TARGET, 302);
        }
        case "/redirect-to-private": {
            return Response.redirect("http://10.0.0.1/", 302);
        }
        case "/sw-page": {
            return html(titleScript('async () => { await navigator.serviceWorker.register("/sw.js"); return "registered"; }'));
        }
        case "/sw.js": {
            return new Response('self.addEventListener("fetch", (event) => event.respondWith(fetch(event.request)));', {
                headers: { "content-type": "text/javascript" },
            });
        }
        case "/xhr-auth": {
            return html(
                titleScript(
                    'async () => { const response = await fetch("/redirect-cross-origin", { headers: { authorization: "Bearer smoke-secret" } }); return "echo:" + (await response.text()); }', // secret-scanner:allow -- a fixture token the cross-origin hop must drop, not a credential
                ),
            );
        }
        default: {
            return undefined;
        }
    }
};

const runCheck = async (name: string, check: () => Promise<string>): Promise<Check> => {
    try {
        return { detail: await check(), name, pass: true };
    } catch (error) {
        return { detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error), name, pass: false };
    }
};

/** Read `document.title` once the page script has replaced "pending", waiting up to `ms`. */
const settledTitle = (ms: number) => (): Promise<string> =>
    new Promise((resolve) => {
        const page = globalThis as unknown as { document: { title: string } };
        const started = Date.now();
        const poll = (): void => {
            if (page.document.title !== "pending" || Date.now() - started > ms) {
                resolve(page.document.title);

                return;
            }

            setTimeout(poll, 50);
        };

        poll();
    });

/** Expect `run` to be refused by the guard with a `FORBIDDEN` LunoraError. */
const expectForbidden = async (run: () => Promise<unknown>): Promise<string> => {
    try {
        await run();
    } catch (error) {
        const { code, message } = error as { code?: string; message?: string };

        if (code === "FORBIDDEN") {
            return `refused: ${message ?? ""}`;
        }

        throw error;
    }

    throw new Error("expected a FORBIDDEN refusal, but the call succeeded");
};

const report = async (url: URL, env: Env): Promise<Response> => {
    const { origin } = url;
    // The default mode: no allowedHosts, every request fetched and checked by the Worker-side guard.
    const guarded = createBrowser({ binding: env.BROWSER, launch });
    // The production posture: Browser Run enforces the list on the session.
    const pinned = createBrowser({ allowedHosts: [url.hostname], binding: env.BROWSER, launch });

    const checks = [
        await runCheck("default: guarded screenshot of a public page (route.fetch inside a real session)", async () => {
            const png = await guarded.screenshot(`${origin}/page`);

            if (png.byteLength < 8 || png[0] !== 0x89) {
                throw new Error(`not a PNG (${String(png.byteLength)} bytes)`);
            }

            return `${String(png.byteLength)} byte PNG`;
        }),
        await runCheck("default: an <img> that 302s to 169.254.169.254 is refused by the guard", async () =>
            guarded.launch(async (browser: BrowserLike) => {
                const context = await browser.newContext();
                const page = (await context.newPage()) as SmokePage;
                const failures: string[] = [];

                page.on("requestfailed", (request) => {
                    failures.push(`${request.url()} ${request.failure()?.errorText ?? ""}`);
                });
                await page.goto(`${origin}/img-to-metadata`, { waitUntil: "load" });

                const refused = failures.find((failure) => failure.includes("/redirect-to-metadata") && failure.includes("BLOCKED_BY_CLIENT"));

                if (refused === undefined) {
                    throw new Error(`no blockedbyclient failure for the probe image; failures: ${JSON.stringify(failures)}`);
                }

                return refused;
            }),
        ),
        await runCheck("default: a main-frame redirect to a private address is refused", async () =>
            expectForbidden(async () => guarded.content(`${origin}/redirect-to-private`)),
        ),
        await runCheck("default: service-worker registration is blocked", async () => {
            const title = await guarded.scrape(`${origin}/sw-page`, settledTitle(3000));

            if (title === "registered") {
                throw new Error("the service worker registered");
            }

            return `page saw: ${title}`;
        }),
        await runCheck("default: a cross-origin redirect hop does not carry Authorization", async () => {
            const title = await guarded.scrape(`${origin}/xhr-auth`, settledTitle(5000));

            if (!title.startsWith("echo:")) {
                throw new Error(`the cross-origin echo was not reached (${title}); set CROSS_ORIGIN if preview URLs are off`);
            }

            const echoed = JSON.parse(title.slice("echo:".length)) as { authorization: string | null };

            if (echoed.authorization !== null) {
                throw new Error(`the hop carried Authorization: ${echoed.authorization}`);
            }

            return "no Authorization on the cross-origin hop";
        }),
        await runCheck("allowedHosts: an allowed host loads", async () => {
            const content = await pinned.content(`${origin}/page`);

            if (!content.includes("smoke-ok")) {
                throw new Error("the page content is missing");
            }

            return "loaded";
        }),
        await runCheck("allowedHosts: a host off the list is blocked", async () => expectForbidden(async () => pinned.content("https://example.com/"))),
    ];

    return Response.json({ checks, ok: checks.every((check) => check.pass) }, { status: 200 });
};

const worker = {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        // What a cross-origin hop arrived with: the Authorization check reads it.
        if (url.pathname === "/echo-headers") {
            return Response.json({ authorization: request.headers.get("authorization") }, { headers: { "access-control-allow-origin": "*" } });
        }

        if (url.pathname === "/report") {
            return report(url, env);
        }

        return fixture(url, env) ?? new Response("@lunora/browser smoke worker: GET /report", { status: 404 });
    },
};

export default worker;
