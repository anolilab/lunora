/**
 * One response-header write, inside an `httpAction` handler, whose value is derived
 * from raw request input (`request.headers`, `request.url`/query, `await
 * request.json()`) with no CR/LF sanitizer — the
 * `http_action_response_header_injection` lint input. A `Request`-derived string
 * placed verbatim into a response header lets a caller smuggle `\r\n` and inject
 * extra headers or split the response. Only request-tainted, unguarded sites are
 * recorded — a value routed through `isSafeHeaderValue`, `encodeURIComponent`/
 * `encodeURI`, a numeric coercion, or `btoa` is treated as safe (`String(...)` /
 * `.toString()` are NOT sanitizers). Produced by the codegen feeder; runtime
 * callers don't supply it, so the lint finds nothing there. Structurally identical
 * to `HttpHeaderWriteIR`.
 */
export interface AdvisorHttpHeaderWrite {
    /** The exported binding name of the enclosing handler, or `"<module>"` when mounted inline. */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** The header name being written (`"location"`), or `""` when the key is not a string literal. */
    headerName: string;
    /** 1-based line of the request-tainted header value. */
    line: number;
    /** How the header was written. */
    via: "headers-append" | "headers-ctor" | "headers-set" | "response-init";
}
