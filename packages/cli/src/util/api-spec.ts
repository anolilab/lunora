import type { CodegenOptions } from "@lunora/codegen";
import { LunoraError } from "@lunora/errors";

/**
 * The `--api-spec` flag's accepted values, mirroring `@lunora/codegen`'s
 * `CodegenOptions["apiSpec"]`. `"openapi"` (the default) emits `openapi.json`;
 * `"openrpc"` emits `openrpc.json`; `"both"` emits both; `"none"` emits neither.
 */
type ApiSpec = NonNullable<CodegenOptions["apiSpec"]>;

const API_SPEC_VALUES: ReadonlyArray<ApiSpec> = ["both", "none", "openapi", "openrpc"];

/** Human-readable list of the accepted `--api-spec` values for help/error text. */
const API_SPEC_HELP: string = API_SPEC_VALUES.join(" | ");

/**
 * Parse the raw `--api-spec` flag value into a {@link ApiSpec}. Returns
 * `undefined` when the flag is absent (the caller then lets codegen apply its
 * `"openapi"` default), and throws on an unrecognized value so a typo fails loud
 * rather than silently emitting the default spec.
 */
const parseApiSpec = (value: unknown): ApiSpec | undefined => {
    if (typeof value !== "string" || value.length === 0) {
        return undefined;
    }

    if ((API_SPEC_VALUES as ReadonlyArray<string>).includes(value)) {
        return value as ApiSpec;
    }

    throw new LunoraError("INTERNAL", `invalid --api-spec "${value}" — expected one of: ${API_SPEC_HELP}`);
};

export type { ApiSpec };
export { API_SPEC_HELP, API_SPEC_VALUES, parseApiSpec };
