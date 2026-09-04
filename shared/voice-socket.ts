/**
 * Endpoint derivation and close-code handling for the voice-agent primitive each
 * framework adapter ships (`@lunora/react`'s `useVoiceAgent` and its Angular /
 * Solid / Svelte / Vue siblings).
 *
 * These live in one place rather than five because five hand-kept copies is
 * exactly how the endpoint derivation drifted: four of them opened the socket on
 * the HTTP host even when the client was pointed at a separate WebSocket host,
 * and none of them read the close code the server uses to say "your credential
 * lapsed". A real package would create a runtime dependency edge between the
 * adapters for four pure functions, so this is inlined into each bundle instead.
 */

/**
 * The shard socket path `LunoraClient` appends when it derives `wsUrl` from
 * `url`. The voice endpoint is its sibling, so stripping this suffix is what
 * turns a shard WS URL back into the base a voice URL is built on — and it keeps
 * whatever path prefix a reverse proxy put in front of both.
 */
const SHARD_WS_PATH = "/_lunora/ws";

/** The path the runtime routes voice upgrades on (`@lunora/runtime`'s `VOICE_PATH_PREFIX`). */
const VOICE_WS_PATH = "/_lunora/voice/";

/**
 * The close code the server sends when the socket's credential had already
 * lapsed — `shared/identity-header.ts`'s `dropExpiredCredentialSocket`, which
 * both `ShardDO` and `VoiceSessionDO` drop expired sockets through.
 * `LunoraClient` maps the same code to its `onTokenExpired` listeners on the
 * shard socket; a voice call has to read it too, or an expired credential is
 * indistinguishable from the network dropping.
 */
const VOICE_TOKEN_EXPIRED_CLOSE_CODE = 4001;

/** Swap an http(s) origin for its ws(s) equivalent — mirrors the client's own derivation. */
const deriveWebSocketUrl = (url: string): string => {
    if (url.startsWith("https://")) {
        return `wss://${url.slice("https://".length)}`;
    }

    if (url.startsWith("http://")) {
        return `ws://${url.slice("http://".length)}`;
    }

    return url;
};

/**
 * Derive the agent's export name from its voice reference. Codegen emits the
 * member as `agents.<name>Voice` (ref `agents:<name>Voice`), so strip the
 * `agents:` namespace and the `Voice` suffix.
 */
const agentNameFromReference = (reference: string): string => {
    const withoutNamespace = reference.startsWith("agents:") ? reference.slice("agents:".length) : reference;

    return withoutNamespace.endsWith("Voice") ? withoutNamespace.slice(0, -"Voice".length) : withoutNamespace;
};

/**
 * The base the voice endpoint hangs off. `wsUrl` wins when the client has one —
 * an app that points its sockets at a separate host (`LunoraClientOptions.wsUrl`)
 * means it for the voice socket too, and deriving from the HTTP `url` sent voice
 * to the wrong origin.
 *
 * A `wsUrl` in the default shape keeps its path prefix; a fully custom one (a
 * bespoke socket path) contributes only its origin, since its path is the shard
 * endpoint's, not a prefix the voice endpoint shares.
 */
const voiceBaseUrl = (httpUrl: string, wsUrl: string | undefined): string => {
    if (wsUrl === undefined || wsUrl === "") {
        return deriveWebSocketUrl(httpUrl);
    }

    if (wsUrl.endsWith(SHARD_WS_PATH)) {
        return wsUrl.slice(0, -SHARD_WS_PATH.length);
    }

    try {
        return new URL(wsUrl).origin;
    } catch {
        // Not an absolute URL (a relative `wsUrl`, which the client also accepts)
        // — fall back to the HTTP base, which is absolute by construction.
        return deriveWebSocketUrl(httpUrl);
    }
};

/** Build the voice-session WebSocket URL for `agent` on `threadKey`. */
const voiceSocketUrl = (options: { agent: string; httpUrl: string; threadKey: string; wsUrl: string | undefined }): string => {
    const base = voiceBaseUrl(options.httpUrl, options.wsUrl);
    const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
    const search = new URLSearchParams({ threadKey: options.threadKey });

    return `${trimmed}${VOICE_WS_PATH}${encodeURIComponent(options.agent)}?${search.toString()}`;
};

/**
 * The error a close event should surface, or `undefined` for an ordinary close.
 *
 * Only the expired-credential code is translated: every other close is the call
 * ending, which the primitive already reports by returning to `idle`. `event` is
 * `unknown` because the injectable socket seam is not an `EventTarget` and a
 * `close` can arrive with no event at all.
 */
const voiceCloseError = (prefix: string, event: unknown): Error | undefined => {
    const code = (event as { code?: unknown } | null | undefined)?.code;

    if (code !== VOICE_TOKEN_EXPIRED_CLOSE_CODE) {
        return undefined;
    }

    return new Error(`${prefix}: authentication token expired — refresh the credential and start a new call`);
};

export { agentNameFromReference, voiceCloseError, voiceSocketUrl };
