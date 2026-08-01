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
 */
import type { IncomingMessage } from "node:http";

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

/**
 * Per-request transport gate, independent of a host's config-derived bind
 * intent (e.g. Vite's `isNonLoopbackBind`, the CLI's `isLoopback`). In Vite
 * middleware mode the real bind belongs to the embedding server (so the
 * config check measures the wrong thing); here we read the actual socket peer
 * and the `Host` header. Returns a refusal reason, or `undefined` when the
 * connection is loopback-local.
 */
const transportRejectionReason = (request: IncomingMessage): string | undefined => {
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
    // must not receive the inlined admin token. Refuse rather than trust Host.
    const FORWARDING_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded"] as const;

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `headers` is typed required but partial/mocked requests omit it
    if (FORWARDING_HEADERS.some((name) => request.headers?.[name] !== undefined)) {
        return "Lunora studio refuses a proxied (X-Forwarded-*) request in dev.";
    }

    return undefined;
};

export { headerValue, isLoopbackAddress, transportRejectionReason };
