/**
 * Compile-time only: pins every `*Like` projection in `src/types.ts` against the
 * real `@cloudflare/playwright`, which is a devDependency here even though `src/`
 * never imports it.
 *
 * `createBrowser` takes `launch` / `connect` / `sessions` by INJECTION and types
 * them structurally so the heavy optional peer stays out of the bundle for apps
 * that never screenshot, and so tests can pass plain doubles. The cost of that
 * decoupling is that nothing consumed the real signatures — which is exactly the
 * failure mode `AGENTS.md` names: "the canonical binding `*Like` types drifted
 * from the real ones because nothing consumed them".
 *
 * They had drifted, in four places, and the documented usage
 * (`createBrowser({ binding, launch })` — the call `create-browser.ts`'s own
 * error message tells users to write) did not type-check against ANY published
 * version. The whole chain is asserted here, not just the three injected
 * functions, because the function mismatches were downstream of the return
 * types: `launch` returns `Browser`, whose `newContext()` returns
 * `BrowserContext`, whose `newPage()` returns `Page`. One wrong leaf failed all
 * six assertions, and fixing `PageLike` fixed `launch` and `connect` with it.
 * Asserting each layer separately is what makes the next failure legible.
 *
 * This does not replace the live-worker vetting the `@cloudflare/playwright` pin
 * documents — the protocol handshake with Browser Rendering needs a real binding
 * and no Cloudflare credentials are wired into this repo's CI. It covers the half
 * that is checkable offline: a re-signed upstream export now fails `lint:types`
 * on the bump instead of at runtime.
 *
 * `import type` throughout, so no `@cloudflare/playwright` code is loaded — the
 * package targets workerd and this suite is plain Node.
 */
import type { Browser, BrowserContext, connect, launch, Page, sessions } from "@cloudflare/playwright";

import type { BrowserConnectLike, BrowserContextLike, BrowserLaunchLike, BrowserLike, BrowserSessionsLike, PageLike } from "../src/types";

declare const realPage: Page;
declare const realContext: BrowserContext;
declare const realBrowser: Browser;

/**
 * The object chain, deepest first — `launch()` hands back a real `Browser`, so
 * every layer it exposes has to satisfy our projection of it.
 */
export const pageConforms: PageLike = realPage;

export const contextConforms: BrowserContextLike = realContext;

export const browserConforms: BrowserLike = realBrowser;

/**
 * The three injected entry points. Assignability (not equality) is the right
 * relation: upstream may widen a parameter or add an overload — as 1.3.5 did with
 * `browser: "kitesurf"` — and we only care that the shape `createBrowser` calls
 * through still type-checks.
 */
export const launchConforms = (real: typeof launch): BrowserLaunchLike => real;

export const connectConforms = (real: typeof connect): BrowserConnectLike => real;

export const sessionsConforms = (real: typeof sessions): BrowserSessionsLike => real;
