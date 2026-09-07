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

/**
 * The subset of `LunoraClient` {@link watchVoiceIdentity} needs. Structural so
 * this file stays dependency-free (see the module docblock).
 */
interface VoiceIdentitySource {
    currentIdentity: () => string | null;
    onAuthTokenChange: (listener: (token: string | null) => void) => () => void;
}

/**
 * End a live call when the signed-in identity changes underneath it.
 *
 * A voice socket's credential is fixed at the upgrade: the browser sends its
 * cookie once, and on React Native the client's wrapped `WebSocket` injects the
 * auth header once, at construction. Nothing re-credentials an already-open
 * socket. `LunoraClient` handles the equivalent on its own sockets by closing
 * them so the reconnect carries the new value ({@link file://../packages/client/src/lunora-client.ts}'s
 * `setWsToken`/`setAuthToken`), but that bounce never reached the voice socket —
 * so a sign-out or a user switch mid-call left the session running, and still
 * writing its `agents:*` thread, under the PREVIOUS user's identity.
 *
 * Keyed on the client's identity fingerprint, not the raw token: a routine JWT
 * refresh for the same subject emits a token change and must NOT drop a call in
 * progress. Only a fingerprint move — sign-out, sign-in, switching users — does.
 *
 * There is deliberately no reconnect. The primitive holds per-call state (the
 * live thread, the microphone, the partial transcript) that belongs to the
 * identity that opened it; resuming it under a different one would be the bug,
 * not the fix. The caller tears the call down and surfaces the error, and the
 * app starts a new call when it wants one.
 *
 * Note this is NOT the `?token=` channel the shard socket uses. The voice
 * upgrade has no `LUNORA_WS_BEARER` gate (`@lunora/runtime`'s
 * `handleVoiceUpgrade` authorizes per-`threadKey` via `authorizeShard` plus the
 * resolved identity) and resolves identity from the `authorization`/`cookie`
 * headers only — a query token would be read by nothing on that path.
 *
 * @returns an unsubscribe to call from the primitive's teardown.
 */
const watchVoiceIdentity = (client: VoiceIdentitySource, prefix: string, onIdentityChanged: (error: Error) => void): (() => void) => {
    const opened = client.currentIdentity();

    return client.onAuthTokenChange((): void => {
        if (client.currentIdentity() === opened) {
            return;
        }

        onIdentityChanged(new Error(`${prefix}: the signed-in identity changed during the call — the session was ended; start a new call`));
    });
};

export { agentNameFromReference, voiceCloseError, voiceSocketUrl, watchVoiceIdentity };
