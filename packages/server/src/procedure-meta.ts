import { LunoraError } from "@lunora/errors";

/**
 * Where a registered function carries its `.meta(...)` declaration.
 *
 * A symbol so it cannot collide with a field of the dispatch shape, and
 * `Symbol.for` so two bundled copies of `@lunora/server` agree on it. ENUMERABLE
 * on purpose: object spread copies enumerable own symbols, so a wrapper that
 * re-tags a function (`{ ...fn, visibility }`) keeps its meta — a non-enumerable
 * stamp would vanish there without a word. `JSON.stringify` still skips it.
 */
const PROCEDURE_META: unique symbol = Symbol.for("lunora.procedure.meta");

/**
 * The value a lazily registered stub carries when its function declares a
 * `.meta(...)` codegen could not copy as a literal. Only loading the module
 * produces it, so {@link procedureMeta} refuses to answer rather than report
 * "no meta" for a function that has some.
 */
const UNLOADED_META = "unloaded" as const;

/**
 * The `.meta(...)` declaration of a registered function — the same frozen object
 * its middleware reads as `ctx.meta` — or `undefined` when it declares none.
 *
 * The supported way for tooling (an authorization audit, a docs generator) to
 * read a procedure's metadata: iterate the generated `LUNORA_FUNCTIONS` table, or
 * pass an imported function, and ask this. Throws for a lazily registered
 * function whose meta exists but is only available once its module loads.
 */
const procedureMeta = (registered: unknown): Readonly<Record<string, unknown>> | undefined => {
    if (registered === null || typeof registered !== "object") {
        return undefined;
    }

    const meta = (registered as Record<PropertyKey, unknown>)[PROCEDURE_META];

    if (meta === UNLOADED_META) {
        throw new LunoraError(
            "PROCEDURE_META_UNLOADED",
            "This function is registered lazily and its .meta(...) is not a literal codegen could copy, so it is only readable after the module loads. Load the function first, or declare its meta as a literal.",
        );
    }

    return meta === undefined ? undefined : (meta as Readonly<Record<string, unknown>>);
};

export { PROCEDURE_META, procedureMeta, UNLOADED_META };
