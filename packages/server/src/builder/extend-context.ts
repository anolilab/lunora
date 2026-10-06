/**
 * Copy a function context and lay `extension` over it, keeping accessors as accessors.
 *
 * A spread or `Object.assign` READS every getter on the way through, and the context has
 * getters that must stay lazy: `ctx.payments` builds its facade (and runs the app's
 * `config.payment(env)` thunk, which may throw on a missing key) only when read, and
 * `ctx.ip` marks the dispatch as address-dependent for the reactive cache when read. A
 * procedure with `.use()` / `.meta()` that touched neither would otherwise pay for both.
 */
const extendContext = (context: unknown, extension: Record<string, unknown>): object => {
    const base: object = typeof context === "object" && context !== null ? context : {};

    // One merged descriptor map, so an extension key replaces a base key outright, even one the
    // base defined non-configurable, rather than being redefined on top of it.
    return Object.create(Object.getPrototypeOf(base) as object | null, {
        ...Object.getOwnPropertyDescriptors(base),
        ...Object.getOwnPropertyDescriptors(extension),
    }) as object;
};

export default extendContext;
