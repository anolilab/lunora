import emit from "../../finding";
import type { Lint } from "../../types";

/** Human-readable phrasing for how the header was written, for a finding's prose. */
const viaLabel = (via: string): string => {
    if (via === "response-init") {
        return "a `Response` init `headers` object";
    }

    if (via === "headers-ctor") {
        return "a `new Headers({...})` initializer";
    }

    return `a \`${via.replace("headers-", "headers.")}(...)\` call`;
};

/**
 * Flags an `httpAction` handler that writes a response-header value derived from
 * raw request input (`request.headers`, `request.url`/query, `await
 * request.json()`) with no CR/LF sanitizer.
 *
 * A `Request`-derived string placed verbatim into a response header lets a caller
 * smuggle carriage-return/line-feed sequences (`\r\n`) into the response — injecting
 * additional headers (`Set-Cookie`, `Location`, CORS) or splitting the response body
 * (HTTP response splitting / header injection). Unlike `query`/`mutation` handlers,
 * a raw `httpAction` builds its own `Response`, so nothing forces the value through
 * the framework's `isSafeHeaderValue` CR/LF guard.
 *
 * Runs only when the codegen feeder supplies header-write evidence
 * (`context.httpHeaderWrites`); a runtime caller flags nothing. The feeder records
 * a site only when its value is request-tainted AND unguarded — a value routed
 * through `isSafeHeaderValue`, `encodeURIComponent`/`encodeURI`, a numeric coercion
 * (`Number`/`parseInt`/`parseFloat`), or `btoa` is treated as safe and never
 * recorded. One finding per unsafe header write.
 */
const httpActionResponseHeaderInjection: Lint = {
    categories: ["SECURITY"],
    description:
        "An `httpAction` handler writes a response-header value derived from raw request input (`request.headers`/URL/query/body) with no CR/LF sanitizer. A `Request`-derived string placed verbatim into a response header lets a caller smuggle `\\r\\n` and inject extra headers or split the response (HTTP response splitting / header injection).",
    facing: "EXTERNAL",
    level: "WARN",
    name: "http_action_response_header_injection",
    remediation:
        "Never place a raw request value into a response header. Route it through a CR/LF guard (`isSafeHeaderValue` from `@lunora/server`, rejecting values containing `\\r`/`\\n`/`\\0`), URL-encode it (`encodeURIComponent`), or coerce it to a number — before writing the header. `String(...)` / `.toString()` do NOT strip CR/LF and are not sufficient.",
    run: (context) => {
        if (context.httpHeaderWrites === undefined) {
            return [];
        }

        return context.httpHeaderWrites.map((row) => {
            const header = row.headerName === "" ? "a response header" : `the \`${row.headerName}\` response header`;

            return emit(httpActionResponseHeaderInjection, {
                cacheKey: `http_action_response_header_injection:${row.file}:${row.line.toString()}`,
                detail: `\`${row.exportName}\` (${row.file}:${row.line.toString()}) writes ${header} from raw request input via ${viaLabel(row.via)} with no CR/LF guard — a caller can smuggle \`\\r\\n\` to inject headers or split the response. Route the value through \`isSafeHeaderValue\` or \`encodeURIComponent\` first.`,
                metadata: {
                    exportName: row.exportName,
                    file: row.file,
                    headerName: row.headerName,
                    line: row.line,
                    via: row.via,
                },
            });
        });
    },
    source: "static",
    title: "Response header written from unsanitized request input",
};

export default httpActionResponseHeaderInjection;
