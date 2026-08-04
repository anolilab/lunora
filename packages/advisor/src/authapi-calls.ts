/**
 * One `ctx.authApi.<method>(...)` call discovered in a function body — the input
 * the `auth_api_call_without_headers` lint consumes. Produced by the codegen
 * feeder; runtime callers don't supply it, so the lint finds nothing there.
 */
export interface AdvisorAuthApiCall {
    /** The exported function performing the call (e.g. `createOrg`). */
    exportName: string;
    /** Source file the call appears in (relative to the lunora dir, no extension). */
    file: string;
    /** True when the call's argument object includes a `headers` property. */
    hasHeaders: boolean;
    /** 1-based line of the call, or `0` when unknown. */
    line: number;
    /** The better-auth method invoked (e.g. `banUser`); empty when not statically known. */
    method: string;
}
