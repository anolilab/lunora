/**
 * Where a registered function carries its `.meta(...)` declaration (or the
 * string `"unloaded"` on a lazy stub). The same `Symbol.for` key as
 * `@lunora/server`'s `PROCEDURE_META`, so the runtime needs no dependency on it.
 */
const PROCEDURE_META: unique symbol = Symbol.for("lunora.procedure.meta");

export default PROCEDURE_META;
