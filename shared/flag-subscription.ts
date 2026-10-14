/**
 * The one definition of Lunora's client-side feature-flag channel, shared by
 * every framework adapter (`@lunora/react`, `@lunora/vue`, `@lunora/solid`,
 * `@lunora/svelte`, `@lunora/angular`).
 *
 * There must be exactly ONE copy rather than five byte-similar preambles: the
 * reserved path, the wire-arg shape, the kind mapping and — above all — the
 * fail-open semantics are a single contract, and five copies is five places to
 * miss the next change to it. That is not hypothetical: the SSR guard was added
 * to two of the adapters and missed in a third on the same day, by three
 * authors editing the same duplicated function.
 *
 * What stays at the call site is only what is genuinely per-framework: the SSR
 * guard (`@lunora/vue` and `@lunora/svelte` gate on `shared/is-browser`,
 * `@lunora/angular` on Angular's `PLATFORM_ID`; React and Solid need none
 * because their effects never run during a server render) and how the resolved
 * value is written back into that framework's reactive primitive.
 *
 * Like the repo's other `shared/` helpers this is deliberately **not** a
 * package: consumers import it by relative path and the bundler (packem/rollup)
 * inlines it — no runtime dependency edge between the adapters. Keep it
 * genuinely zero-dependency (relative/built-in imports only) or inlining
 * breaks; that is why the two `@lunora/client` shapes it needs are mirrored
 * structurally below instead of imported. Consumers must drop
 * `outDir`/`rootDir` from their `tsconfig.json` (a set `rootDir` raises TS6059
 * for this out-of-package file under `tsc --noEmit`).
 */

/**
 * The reserved runtime path the generated flag-subscription read override
 * answers. Any `__lunora_flags__:` path routes there (the suffix is free), and
 * the studio's admin reads use `__lunora_admin__:listFlags`; this is the
 * client-facing reactive channel. Unlike a normal query, a flag read never
 * issues an HTTP fetch — the reserved prefix isn't a registered function, so an
 * HTTP RPC would 404. It rides Lunora's WebSocket only, seeded on subscribe.
 *
 * The channel is public and unauthenticated, so it carries **no** client-supplied
 * targeting context: the server evaluates every flag under the socket's own
 * verified identity (`defineFlags({ identify })`). Putting a caller-supplied
 * context on this wire would let any subscriber spoof targeting attributes
 * (`{ plan: "premium" }`) to unlock a flag gated on them. Context-dependent
 * evaluation belongs in a server function, via `ctx.flags.*`.
 */
const FLAGS_EVAL_PATH = "__lunora_flags__:eval";

/** The value kinds a flag resolves to — OpenFeature's boolean / number / string / structured (JSON) flags. */
type FlagValue = boolean | number | string | { [key: string]: unknown } | unknown[] | null;

/** Wire args the generated flag-subscription read override reads: the key, its value kind, and the fallback. */
interface FlagSubscribeArgs extends Record<string, unknown> {
    default: unknown;
    key: string;
    type: "boolean" | "number" | "object" | "string";
}

/** Map a default value to the OpenFeature flag kind the server evaluates it as. */
const flagKind = (value: unknown): FlagSubscribeArgs["type"] => {
    const kind = typeof value;

    if (kind === "boolean" || kind === "number" || kind === "string") {
        return kind;
    }

    return "object";
};

/**
 * Structural mirror of `@lunora/client`'s
 * `FunctionReference<"query", FlagSubscribeArgs, FlagValue>` — re-declared
 * rather than imported because `shared/` carries no package imports (see the
 * file header). It is compared structurally at every call site, so a drift in
 * the client's reference shape surfaces there as a type error.
 */
interface FlagsReference {
    readonly __lunoraPhantom?: { args: FlagSubscribeArgs; kind: "query"; returns: FlagValue };
    readonly __lunoraRef: string;
}

/** The single capability {@link subscribeFlag} needs from a `LunoraClient`. */
interface FlagClient {
    subscribe: (reference: FlagsReference, args: FlagSubscribeArgs, callback: (value: FlagValue) => void, options: { onError?: () => void }) => () => void;
}

/** A typed reference to the reserved flags channel so `client.subscribe` infers its args/return. */
const flagsReference: FlagsReference = { __lunoraRef: FLAGS_EVAL_PATH };

/** What identifies one flag read on the wire. */
interface FlagSubscription<T extends FlagValue> {
    /** Held until the first evaluation lands, and re-applied on any failure (see {@link subscribeFlag}). */
    default: T;
    key: string;
}

/**
 * Open one flag subscription, pushing each evaluation into `set`, and return its
 * unsubscribe.
 *
 * **Fails open, in both directions.** A flag read has no error channel: if the
 * attach throws (a closed client) the subscription simply never opens, and if
 * the provider starts failing mid-session the server-pushed error resolves
 * `default` rather than freezing on the last resolved value. Either way the
 * caller ends up showing the default — the same contract as server-side
 * `ctx.flags`. Both halves live here so a future change to that contract is one
 * edit rather than ten.
 *
 * The caller owns its own SSR guard and reactive write-back; see the file
 * header.
 */
const subscribeFlag = <T extends FlagValue>(client: FlagClient, args: FlagSubscription<T>, set: (value: T) => void): (() => void) => {
    try {
        return client.subscribe(
            flagsReference,
            { default: args.default, key: args.key, type: flagKind(args.default) },
            (next) => {
                set(next as T);
            },
            {
                onError: () => {
                    set(args.default);
                },
            },
        );
    } catch {
        // The attach threw (e.g. the client is closed). Keep the default.
        return () => {};
    }
};

export type { FlagSubscription, FlagValue };
export { flagKind, subscribeFlag };
