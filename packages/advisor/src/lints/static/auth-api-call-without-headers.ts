import { dedupeCacheKeys } from "../../dedupe-cache-keys";
import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `ctx.authApi.<method>(...)` call whose argument object omits `headers`.
 *
 * `@lunora/auth`'s `withAuthPlugins` middleware attaches the full privileged
 * better-auth API to `ctx.authApi` — `banUser`, `setRole`, impersonation,
 * `createOrganization`, `removeMember`, etc. better-auth authorizes these calls
 * from the caller's session carried in the `headers` you pass. Called
 * **without** `headers`, better-auth treats the invocation as a trusted
 * server-to-server call and **skips session authorization entirely**. So a
 * header-less `ctx.authApi.banUser({ body })` runs with full privileges
 * regardless of who the caller is — an authorization bypass.
 *
 * This lint runs when the codegen feeder has supplied call evidence
 * (`context.authApiCalls` present); a runtime caller with no evidence flags
 * nothing rather than raising false alarms.
 */
const authApiCallWithoutHeaders: Lint = {
    categories: ["SECURITY"],
    description:
        "A `ctx.authApi.<method>(...)` call omits `headers` — better-auth skips session authorization and runs the call with full server-to-server privileges, regardless of the caller's identity.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "auth_api_call_without_headers",
    remediation:
        "Pass the inbound `headers` from the incoming request into every `ctx.authApi.*` call: `ctx.authApi.<method>({ body, headers: request.headers })`. See the `withAuthPlugins` middleware doc for details.",
    run: (context) => {
        // No authApi call evidence supplied → nothing to assert (mirrors inserts guard).
        if (context.authApiCalls === undefined) {
            return [];
        }

        // Two header-less calls to the same method on the same physical source
        // line (e.g. `Promise.all([ctx.authApi.banUser({...}),
        // ctx.authApi.banUser({...})])`) would otherwise share an identical
        // cacheKey and collapse to one dismissible finding, hiding the second
        // call site — the shared `dedupeCacheKeys` pass suffixes the repeats.
        return dedupeCacheKeys(
            context.authApiCalls
                .filter((call) => !call.hasHeaders)
                .map((call) =>
                    emit(authApiCallWithoutHeaders, {
                        cacheKey: `auth_api_call_without_headers:${call.file}:${call.line.toString()}:${call.method}`,
                        detail: `\`ctx.authApi.${call.method || "<method>"}(…)\` in ${call.exportName} (${call.file}:${call.line.toString()}) is called without \`headers\` — better-auth skips session authorization, so this runs with full privileges. Pass the inbound \`headers\`.`,
                        metadata: { exportName: call.exportName, file: call.file, line: call.line, method: call.method },
                    }),
                ),
        );
    },
    source: "static",
    title: "Privileged ctx.authApi call missing headers",
};

export default authApiCallWithoutHeaders;
