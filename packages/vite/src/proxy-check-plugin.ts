/**
 * Dev-only guard for the "compose Lunora beside an existing Worker" setup, where
 * the app is served by Vite and `/_lunora/*` is proxied to a separately-running
 * worker (`wrangler dev`, or another Vite instance).
 *
 * Two mistakes in that wiring cost real debugging time, because both fail the same
 * silent way — the app loads, the HTTP RPC works, and the live query never arrives,
 * so the UI sits on its loading state forever with nothing in the console:
 *
 * First, a missing `ws: true`. Vite's string shorthand — and the object form without
 * `ws` — does not install the HTTP upgrade listener, so the WebSocket handshake is
 * never proxied. Queries answer; subscriptions don't.
 *
 * Second, `changeOrigin` without trusting the dev-server origin. Rewriting the Host
 * makes the worker compute a different self-origin than the browser's `Origin`, so the
 * CSRF guard rejects the cookie-bearing upgrade with `FORBIDDEN_ORIGIN`.
 * (`@lunora/runtime` trusts loopback-to-loopback by default, which covers the common
 * case; a non-loopback dev host still needs `security.csrf.trustedOrigins`.)
 *
 * Both are one-line fixes once you know. This plugin reads the resolved
 * `server.proxy` / `preview.proxy` config, finds entries that route a Lunora path,
 * and warns with the exact remedy.
 */

import type { Plugin } from "vite";

import { lunoraLine } from "./log";

/** Path prefixes a Lunora worker serves — a proxy entry matching one carries live traffic. */
const LUNORA_PATH_PREFIXES = ["/_lunora"];

/** The subset of Vite's `ProxyOptions` this check reads. */
interface ProxyEntryLike {
    changeOrigin?: boolean;
    target?: unknown;
    ws?: boolean;
}

/** `true` when `pattern` (a proxy key) routes a Lunora path. */
const routesLunora = (pattern: string): boolean => LUNORA_PATH_PREFIXES.some((prefix) => pattern.startsWith(prefix) || prefix.startsWith(pattern));

/**
 * Warnings for one proxy table. Pure + exported so the behavior is unit-testable
 * without booting a dev server.
 */
const checkLunoraProxy = (proxy: Record<string, unknown> | undefined, label: string): string[] => {
    if (!proxy) {
        return [];
    }

    const warnings: string[] = [];

    for (const [pattern, entry] of Object.entries(proxy)) {
        if (!routesLunora(pattern)) {
            continue;
        }

        // The string shorthand can't express `ws`, so it is always wrong for a
        // Lunora path — call that out specifically rather than emitting the generic
        // "add ws: true" line against a value that has nowhere to put it.
        if (typeof entry === "string") {
            warnings.push(
                `${label}.proxy["${pattern}"] uses the string shorthand, which does not proxy WebSocket upgrades. ` +
                    `Live queries and shapes will never connect (the app hangs on its loading state) while HTTP RPC appears to work. ` +
                    `Use the object form: { target: "${entry}", ws: true }.`,
            );
            continue;
        }

        if (typeof entry !== "object") {
            continue;
        }

        const options = entry as ProxyEntryLike;

        if (options.ws !== true) {
            warnings.push(
                `${label}.proxy["${pattern}"] is missing \`ws: true\`, so WebSocket upgrades are not proxied. ` +
                    `Live queries and shapes will never connect (the app hangs on its loading state) while HTTP RPC appears to work.`,
            );
        }

        if (options.changeOrigin === true) {
            warnings.push(
                `${label}.proxy["${pattern}"] sets \`changeOrigin: true\`, so the worker sees a different origin than the browser sends. ` +
                    `Loopback-to-loopback is trusted by default; for any other dev host add the dev-server origin to the worker's ` +
                    `\`security.csrf.trustedOrigins\` or the cookie-bearing WebSocket upgrade is rejected with FORBIDDEN_ORIGIN.`,
            );
        }
    }

    return warnings;
};

/**
 * Warn when a dev/preview proxy routes `/_lunora/*` without `ws: true` (or with an
 * origin-rewriting `changeOrigin`). See the module docs.
 */
const proxyCheckPlugin = (): Plugin => {
    return {
        apply: "serve",
        configResolved(config) {
            const warnings = [...checkLunoraProxy(config.server.proxy, "server"), ...checkLunoraProxy(config.preview.proxy, "preview")];

            for (const warning of warnings) {
                config.logger.warn(lunoraLine(warning));
            }
        },
        name: "lunora:proxy-check",
    };
};

export { checkLunoraProxy, proxyCheckPlugin };
