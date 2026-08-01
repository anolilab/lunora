/**
 * The one `args`-shape guard shared by every entry point that accepts
 * caller-supplied procedure arguments — the typed RPC edge (`parseEnvelope`)
 * and the public REST surface (`buildRestRoutes`'s POST-body path +
 * `invokeExposed`, which builds an `RpcEnvelope` directly rather than routing
 * through `parseEnvelope`). `args` flows untrusted to `JSON.stringify` + the
 * shard RPC body, so a non-object value (a bare string/number, `null`, or an
 * array) is rejected here, once, rather than each entry point re-deriving its
 * own version of the same check and drifting from the others.
 */
import { isPlainObject } from "./body-readers";
import { LunoraError } from "./errors";

/**
 * Throw a `400 BAD_REQUEST` unless `args` is a plain, non-null, non-array
 * object. `undefined` is treated as invalid here too — a caller that allows a
 * missing `args` (defaulting it to `{}`) must do so before calling this.
 * `label` names the calling surface in the thrown message; the closed set of
 * callers keeps it a literal union rather than `string`.
 */
const assertArgsObject = (args: unknown, label: "RPC" | "REST"): void => {
    if (!isPlainObject(args)) {
        throw new LunoraError(`${label} \`args\` must be an object`, { code: "BAD_REQUEST", status: 400 });
    }
};

// eslint-disable-next-line import/prefer-default-export -- named export by repo convention (no default exports)
export { assertArgsObject };
