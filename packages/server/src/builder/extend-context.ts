/** Copy one own property onto `copy`: data by value, an accessor as an accessor (never read). */
const copyProperty = (copy: object, descriptor: PropertyDescriptor, key: PropertyKey): void => {
    const isAccessor = descriptor.get !== undefined || descriptor.set !== undefined;

    if (!isAccessor && !Object.hasOwn(copy, key)) {
        Reflect.set(copy, key, descriptor.value);

        return;
    }

    Object.defineProperty(
        copy,
        key,
        isAccessor ? { ...descriptor, configurable: true } : { configurable: true, enumerable: true, value: descriptor.value, writable: true },
    );
};

/**
 * Copy a function context and lay `extension` over it, keeping accessors as accessors.
 *
 * A spread or `Object.assign` READS every getter on the way through, and the context has
 * getters that must stay lazy: `ctx.payments` builds its facade (and runs the app's
 * `config.payment(env)` thunk, which may throw on a missing key) only when read, and
 * `ctx.ip` marks the dispatch as address-dependent for the reactive cache when read. A
 * procedure with `.use()` / `.meta()` that touched neither would otherwise pay for both.
 *
 * Copies own enumerable keys (string and symbol, as a spread does) one at a time. This runs on
 * every dispatch with middleware, and building whole descriptor maps
 * (`Object.getOwnPropertyDescriptors`) was about 3× slower than the spread it replaced. Every
 * copied property is configurable, so an extension key replaces a base key even when the base
 * defined it non-configurable.
 */
const extendContext = (context: unknown, extension: Record<string, unknown>): object => {
    const base: object = typeof context === "object" && context !== null ? context : {};
    const copy = Object.create(Object.getPrototypeOf(base) as object | null) as object;

    for (const source of [base, extension]) {
        for (const key of Reflect.ownKeys(source)) {
            const descriptor = Object.getOwnPropertyDescriptor(source, key);

            if (descriptor?.enumerable) {
                copyProperty(copy, descriptor, key);
            }
        }
    }

    return copy;
};

export default extendContext;
