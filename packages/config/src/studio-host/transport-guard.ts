/**
 * Per-request transport gate for the dev studio's local endpoints, shared by
 * both dev hosts (`@lunora/vite`'s `/__lunora` middleware and `lunora dev`'s
 * standalone `node:http` server). The studio HTML embeds the worker admin
 * token and the server reverse-proxies the worker's privileged `/_lunora/*`
 * surface, so this is the one place that decides whether a request is trusted
 * enough to receive either.
 *
 * Moved here (rather than left duplicated per host) because the two hosts
 * previously diverged on exactly this guard: the Vite host checked the socket
 * peer, the `Host` header, AND the absence of forwarding headers, while the
 * CLI host checked the `Host` header literal only — a relay reaching the CLI
 * host's loopback socket with `Host: localhost` was served the token-bearing
 * document. One shared implementation keeps that from happening again.
 *
 * Two deliberate behaviour deltas from the CLI host's prior standalone guard,
 * both accepted rather than reconciled away:
 *
 * - **An absent `Host` header is now permitted** (the CLI used to reject it
 * outright). With the socket-peer check in front, an absent `Host` means an
 * HTTP/1.0 client — never a browser, and browsers are the only DNS-rebinding
 * vector this guard defends against, so there is nothing to rebind. Low
 * impact by construction, not an oversight.
 * - **A proxied request (`X-Forwarded-*`/`Forwarded`) from a loopback socket
 * is refused by default**, which the CLI host never checked at all. This is
 * correct against an actual relay, but it also 403s every port-forwarded dev
 * environment that legitimately proxies from loopback — GitHub Codespaces,
 * devcontainers, Gitpod, Cloud Workstations, ngrok, and a Docker reverse
 * proxy all connect this way. There is no way to tell "your own trusted
 * tunnel" apart from "an attacker's relay" from the request alone, so this
 * is not auto-detected: it needs an explicit, informed opt-in. Set
 * `LUNORA_STUDIO_ALLOW_FORWARDED=1` (see {@link ALLOW_FORWARDED_ENV}) to
 * allow it once you've confirmed the forwarding is yours. Left unset, the
 * refusal names the specific header it saw (in both the response body and,
 * when a logger is supplied, a `warnOnce` line) so the failure points at its
 * cause instead of landing as an opaque 403 on the studio page.
 */
import type { IncomingMessage } from "node:http";

import type { WarnLogger } from "./types";

/** A single header value, lower-cased and trimmed; `undefined` when absent or array-valued. */
const headerValue = (raw: string | string[] | undefined): string | undefined => {
    const value = Array.isArray(raw) ? raw[0] : raw;

    return typeof value === "string" ? value.trim().toLowerCase() : undefined;
};

/**
 * True for an IPv4/IPv6 loopback peer (`127.0.0.0/8`, `::1`, and the
 * IPv4-mapped `::ffff:127.x`). A missing address means we cannot read the
 * transport (e.g. a mocked request in tests) — treated as loopback so the
 * config-derived gate stays the source of truth there; on a real Vite/Node
 * server `remoteAddress` is always populated.
 */
const isLoopbackAddress = (remoteAddress: string | undefined): boolean => {
    if (remoteAddress === undefined || remoteAddress === "") {
        return true;
    }

    const address = remoteAddress.toLowerCase();
    // Strip the IPv4-mapped IPv6 prefix (`::ffff:127.0.0.1`) so the v4 test applies.
    const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;

    if (v4 === "::1") {
        return true;
    }

    return v4.startsWith("127.");
};

/** The host portion (no port) of a `Host` header value, lower-cased; brackets stripped from IPv6. */
const hostnameOf = (host: string | undefined): string | undefined => {
    if (host === undefined) {
        return undefined;
    }

    if (host.startsWith("[")) {
        // `[::1]:5173` → `::1`
        const close = host.indexOf("]");

        return close === -1 ? host.slice(1) : host.slice(1, close);
    }

    const colon = host.indexOf(":");

    return colon === -1 ? host : host.slice(0, colon);
};

/** Localhost names + loopback literals the `Host` header is allowed to carry. */
const LOOPBACK_HOSTS = new Set<string>(["0.0.0.0", "127.0.0.1", "::1", "localhost"]);

/** Headers whose presence means a reverse proxy/tunnel is relaying this request rather than a direct loopback browser. */
const FORWARDING_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded"] as const;

/**
 * Explicit opt-out for the forwarding-header refusal below — set to `"1"` to
 * allow a proxied request through once you've confirmed the forwarding is
 * your own trusted dev tunnel (Codespaces, devcontainers, Gitpod, Cloud
 * Workstations, ngrok, a Docker reverse proxy, …), not an attacker's relay.
 * Does not relax the socket-peer or `Host` checks — only this one.
 */
const ALLOW_FORWARDED_ENV = "LUNORA_STUDIO_ALLOW_FORWARDED";

const forwardedAllowedByEnv = (): boolean => process.env[ALLOW_FORWARDED_ENV] === "1";

/**
 * Per-request transport gate, independent of a host's config-derived bind
 * intent (e.g. Vite's `isNonLoopbackBind`, the CLI's `isLoopback`). In Vite
 * middleware mode the real bind belongs to the embedding server (so the
 * config check measures the wrong thing); here we read the actual socket peer
 * and the `Host` header. Returns a refusal reason, or `undefined` when the
 * connection is loopback-local.
 *
 * `logger`, when supplied, gets a `warnOnce` line for a forwarding-header
 * refusal — naming the specific header seen and the {@link ALLOW_FORWARDED_ENV}
 * escape hatch — so the failure points at its cause in the terminal running
 * the dev server, not just as an opaque 403 in the browser.
 */
const transportRejectionReason = (request: IncomingMessage, logger?: WarnLogger): string | undefined => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `socket` is typed required but partial/mocked requests omit it
    if (!isLoopbackAddress(request.socket?.remoteAddress ?? undefined)) {
        return "Lunora studio is only available on loopback connections in dev.";
    }

    // Defend against DNS rebinding: a public DNS name resolving to loopback
    // still arrives with that name in `Host`. Only a localhost/loopback Host is
    // allowed. An absent Host (HTTP/1.0) is permitted — there is nothing to rebind.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `headers` is typed required but partial/mocked requests omit it
    const host = hostnameOf(headerValue(request.headers?.host));

    if (host !== undefined && !LOOPBACK_HOSTS.has(host)) {
        return "Lunora studio rejects a non-localhost Host header in dev.";
    }

    // A direct loopback browser never sets forwarding headers; their presence
    // means a reverse proxy/tunnel is relaying a (possibly remote) client, which
    // must not receive the inlined admin token. Refuse rather than trust Host —
    // unless the developer has explicitly opted in via ALLOW_FORWARDED_ENV.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `headers` is typed required but partial/mocked requests omit it
    const forwardingHeader = FORWARDING_HEADERS.find((name) => request.headers?.[name] !== undefined);

    if (forwardingHeader !== undefined && !forwardedAllowedByEnv()) {
        logger?.warnOnce?.(
            `[lunora] studio: refusing a request carrying the "${forwardingHeader}" header — this dev server is being reached through a proxy/tunnel ` +
                `(Codespaces, devcontainers, Gitpod, Cloud Workstations, ngrok, and Docker reverse proxies all add this). ` +
                `If this is YOUR trusted dev tunnel, set ${ALLOW_FORWARDED_ENV}=1 to allow it.`,
        );

        return (
            `Lunora studio refuses a proxied request in dev (saw the "${forwardingHeader}" header). ` +
            `If you're intentionally running behind a trusted dev tunnel/proxy (e.g. Codespaces, devcontainers, Gitpod, ngrok), ` +
            `set ${ALLOW_FORWARDED_ENV}=1 to allow it.`
        );
    }

    return undefined;
};

export { ALLOW_FORWARDED_ENV, headerValue, isLoopbackAddress, transportRejectionReason };
