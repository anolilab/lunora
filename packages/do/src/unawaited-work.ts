/**
 * Counts the I/O an action starts through its `ctx` and reports what is still
 * running when the handler returns.
 *
 * On Workers a promise nobody awaited may be cancelled once the response is
 * sent, silently: a `ctx.runMutation` that never commits, a `ctx.storage.put`
 * that never lands. Locally it usually finishes anyway, so the bug only shows in
 * production. This makes it visible at the moment it happens.
 *
 * Nothing is awaited on the handler's behalf, and a call it never awaits still
 * rejects unhandled when it fails, exactly as it would without the watch.
 */

/** `ctx` members that return a promise and are wrapped directly. */
const CALL_KINDS = ["fetch", "runAction", "runMutation", "runQuery"] as const;

/**
 * `ctx` members that are Lunora-owned objects of promise-returning methods.
 *
 * The pass-through platform bindings (`aiSearch`, `browser`, `images`, …) and `db` are left alone: a
 * runtime binding is brand-checked by native code the handler may hand it to, and `db` carries identity
 * the engine keys on, so a proxy standing in for either could break a call that works today.
 */
const FACADE_KINDS = ["ai", "live", "notify", "push", "queues", "scheduler", "storage", "topics"] as const;

/** Facades whose members are themselves producers (`ctx.queues.<name>.send`, `ctx.topics.<name>.publish`). */
const NESTED_FACADE_KINDS: ReadonlySet<string> = new Set(["queues", "topics"]);

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
    (typeof value === "object" || typeof value === "function") && value !== null && typeof (value as { then?: unknown }).then === "function";

/**
 * Wrap `ctx`'s I/O members in place and return `finish`, which puts the
 * originals back and lists what is still pending (`ctx.storage.put ×2`, …).
 *
 * The facades are swapped back rather than left proxied: deferred deletes and
 * schedules are keyed on the facade object's identity, and the dispatch drains
 * them after the handler returns.
 */
const watchPendingWork = (context: Record<string, unknown>): (() => string[]) => {
    const pending = new Map<string, number>();
    const originals = new Map<string, unknown>();

    const track = (kind: string, value: unknown): unknown => {
        if (!isThenable(value)) {
            return value;
        }

        pending.set(kind, (pending.get(kind) ?? 0) + 1);

        const settle = (): void => {
            pending.set(kind, (pending.get(kind) ?? 1) - 1);
        };

        // A native promise is handed back as a pass-through `then`: the caller's
        // promise settles exactly as the original did, and one the handler never
        // awaits still rejects unhandled. Watching the original from the side would
        // mark it handled and swallow that rejection.
        if (Object.getPrototypeOf(value) === Promise.prototype) {
            return (value as Promise<unknown>).then(
                (result) => {
                    settle();

                    return result;
                },
                (error: unknown) => {
                    settle();

                    throw error;
                },
            );
        }

        // Any other thenable may carry members of its own (an upload handle, a
        // cancellable request), so it is returned untouched and watched instead.
        Promise.resolve(value).then(settle).catch(settle);

        return value;
    };

    for (const name of CALL_KINDS) {
        const original = context[name];

        if (typeof original === "function") {
            originals.set(name, original);
            context[name] = function watched(this: unknown, ...args: unknown[]): unknown {
                return track(`ctx.${name}`, Reflect.apply(original, this, args));
            };
        }
    }

    // One proxy per facade, so `ctx.notify.push` stays the very object `ctx.push` is.
    const watched = new Map<object, object>();

    const watchFacade = (label: string, facade: object, nested = false): object => {
        const existing = watched.get(facade);

        if (existing !== undefined) {
            return existing;
        }

        const proxy = new Proxy(facade, {
            get: (target, property) => {
                const member: unknown = Reflect.get(target, property);

                if (typeof member === "object" && member !== null && watched.has(member)) {
                    return watched.get(member);
                }

                if (nested && typeof property === "string" && typeof member === "object" && member !== null && !isThenable(member)) {
                    return watchFacade(`${label}.${property}`, member);
                }

                if (typeof member !== "function" || typeof property !== "string") {
                    return member;
                }

                // Bound to the facade itself, not the proxy: a class-backed facade's
                // private fields only resolve on the real instance.
                return (...args: unknown[]): unknown => {
                    const result: unknown = Reflect.apply(member, target, args);

                    // `storage.bucket(name)` hands back a sub-facade whose methods are
                    // the I/O, so it is watched the same way.
                    if (property === "bucket" && typeof result === "object" && result !== null && !isThenable(result)) {
                        return watchFacade(`${label}.bucket`, result);
                    }

                    return track(`${label}.${property}`, result);
                };
            },
        });

        watched.set(facade, proxy);

        return proxy;
    };

    for (const name of FACADE_KINDS) {
        const original = context[name];

        if (typeof original === "object" && original !== null) {
            originals.set(name, original);
            context[name] = watchFacade(`ctx.${name}`, original, NESTED_FACADE_KINDS.has(name));
        }
    }

    return () => {
        for (const [name, original] of originals) {
            context[name] = original;
        }

        return [...pending].filter(([, count]) => count > 0).map(([kind, count]) => (count > 1 ? `${kind} ×${String(count)}` : kind));
    };
};

export default watchPendingWork;
