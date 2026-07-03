import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags an action's `ctx.fetch(url, …)` whose URL is derived from the handler's
 * `args` — a server-side request forgery (SSRF) vector.
 *
 * `ctx.fetch` is the action-only outbound-request escape hatch, and it applies no
 * host allowlist: whatever URL it is handed, it fetches. When that URL comes from
 * request input (`ctx.fetch(args.url)`, a template embedding `args.*`, or a URL
 * built one hop earlier from `args`), a caller can point the worker at the cloud
 * metadata endpoint (`169.254.169.254`) or an internal service and read the
 * response — classic SSRF. The fix is to validate the URL against an allowlist of
 * expected hosts before fetching, and to reject private / link-local targets.
 *
 * Runs only when the codegen feeder supplies fetch-taint evidence
 * (`context.argumentDerivedFetches`); a runtime caller flags nothing. One finding per
 * arg-derived `ctx.fetch` call.
 */
const actionFetchSsrf: Lint = {
    categories: ["SECURITY"],
    description:
        "An action's `ctx.fetch(url)` fetches a URL derived from the handler's `args`. `ctx.fetch` applies no host allowlist, so request-controlled URLs let a caller reach cloud metadata endpoints or internal services — server-side request forgery.",
    facing: "EXTERNAL",
    level: "ERROR",
    name: "action_fetch_ssrf",
    remediation:
        "Validate the URL against an allowlist of expected hosts before fetching, and reject private, loopback, and link-local addresses (notably `169.254.169.254`). Never pass request input straight to `ctx.fetch`.",
    run: (context) => {
        if (context.argumentDerivedFetches === undefined) {
            return [];
        }

        return context.argumentDerivedFetches.map((fetchCall) =>
            emit(actionFetchSsrf, {
                cacheKey: `action_fetch_ssrf:${fetchCall.file}:${fetchCall.line.toString()}`,
                detail: `\`ctx.fetch\` in \`${fetchCall.exportName}\` (${fetchCall.file}:${fetchCall.line.toString()}) fetches a URL derived from \`args\` — a server-side request forgery vector. Validate the URL against a host allowlist and reject private/link-local targets before fetching.`,
                metadata: { exportName: fetchCall.exportName, file: fetchCall.file, line: fetchCall.line },
            }),
        );
    },
    source: "static",
    title: "Possible SSRF from arg-derived ctx.fetch URL",
};

export default actionFetchSsrf;
