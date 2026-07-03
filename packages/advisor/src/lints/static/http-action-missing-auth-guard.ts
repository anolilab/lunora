import emit from "../../finding";
import type { Lint } from "../../types";

/** Human-readable surface name for a finding's prose. */
const surfaceLabel = (kind: "httpAction" | "httpRoute", method?: string): string =>
    kind === "httpRoute" && method ? `\`httpRoute\` ${method} handler` : "`httpAction` handler";

/**
 * Flags an `httpAction`/`httpRoute` handler that performs a side effect
 * (`ctx.runMutation` / `ctx.runAction` / a `ctx.db` write) but never reads
 * `ctx.auth`.
 *
 * Unlike `query`/`mutation`/`action` procedures — which run under a resolved
 * identity and RLS — a raw HTTP handler is reached directly from the public
 * internet with no framework-supplied auth step. `HttpActionCtx` still exposes
 * `ctx.auth` (`getIdentity()` / `userId`), but nothing forces the handler to
 * consult it. A handler that mutates state or dispatches an action without ever
 * touching `ctx.auth` is an unauthenticated write endpoint: any anonymous caller
 * can drive the side effect, and the downstream `runMutation`/`runAction`/`db`
 * write runs with whatever ambient authority the handler carries — bypassing the
 * identity/RLS checks the rest of the app relies on. Distinct from
 * `admin_route_without_guard`, which covers Studio/admin-path routes.
 *
 * Runs only when the codegen feeder supplies HTTP-handler evidence
 * (`context.httpActionGuards`); a runtime caller flags nothing. The feeder only
 * records handlers that already perform a side effect and whose `ctx` binding was
 * statically resolvable (a named-function or wrapped handler is skipped,
 * fail-safe), so this lint just filters to those that never read `ctx.auth`. One
 * finding per handler.
 */
const httpActionMissingAuthGuard: Lint = {
    categories: ["SECURITY"],
    description:
        "An `httpAction`/`httpRoute` handler performs a side effect (`ctx.runMutation`/`ctx.runAction`/a `ctx.db` write) but never reads `ctx.auth` — an unauthenticated HTTP endpoint driving a state change, bypassing the identity/RLS checks that guard the rest of the app.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "http_action_missing_auth_guard",
    remediation:
        "Read `ctx.auth` in the handler before the side effect — call `await ctx.auth.getIdentity()` (or check `ctx.auth.userId`) and reject unauthenticated/unauthorized requests, or forward through a `mutation`/`action` whose RLS policies enforce access. If the endpoint is intentionally public (e.g. a signed webhook), verify the provider signature before the write.",
    run: (context) => {
        if (context.httpActionGuards === undefined) {
            return [];
        }

        return context.httpActionGuards
            .filter((row) => !row.readsAuth)
            .map((row) => {
                const surface = surfaceLabel(row.kind, row.method);

                return emit(httpActionMissingAuthGuard, {
                    cacheKey: `http_action_missing_auth_guard:${row.file}:${row.line.toString()}`,
                    detail: `${surface} \`${row.exportName}\` (${row.file}:${row.line.toString()}) calls \`ctx.${row.sideEffect}\` but never reads \`ctx.auth\` — an anonymous caller can drive this write. Authenticate the request before the side effect.`,
                    metadata: {
                        exportName: row.exportName,
                        file: row.file,
                        kind: row.kind,
                        line: row.line,
                        sideEffect: row.sideEffect,
                        ...(row.method ? { method: row.method } : {}),
                    },
                });
            });
    },
    source: "static",
    title: "Unauthenticated HTTP handler performs a side effect",
};

export default httpActionMissingAuthGuard;
