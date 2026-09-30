/**
 * `lunora doctor`'s AI checks — static and offline, like the rest of the preflight.
 *
 * `ctx.ai` runs over the Workers `env.AI` binding, and its `<provider>/<model>`
 * slugs route through the AI Gateway named by `LUNORA_AI_GATEWAY_ID` (else the
 * account's auto-created `default` gateway) — or, when `LUNORA_AI_PROXY_URL` is
 * set, to that self-hosted proxy with no binding at all. These checks read the
 * wrangler config, `.dev.vars`, and the binding inference `doctor` already ran.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DEV_VARS_FILE, parseDevVariableEntries } from "@lunora/config";
import type { WranglerConfig } from "@lunora/config/cloudflare";

import { AI_GATEWAY_ID_VAR, AI_GATEWAY_TOKEN_VAR, AI_PROXY_URL_VAR } from "../ai/variables";
import type { Finding } from "./handler";

/**
 * Every env var name with a non-empty value, wherever the Worker can read it
 * from: top-level `vars`, any `env.<name>.vars`, and `.dev.vars`.
 */
const configuredVariables = (parsed: WranglerConfig, cwd: string): Set<string> => {
    const names = new Set<string>();
    const add = (variables: Record<string, unknown> | undefined): void => {
        for (const [key, value] of Object.entries(variables ?? {})) {
            if (typeof value === "string" && value.trim().length > 0) {
                names.add(key);
            }
        }
    };

    add(parsed.vars);

    for (const environment of Object.values(parsed.env ?? {})) {
        add(environment.vars);
    }

    const devVariablesPath = join(cwd, DEV_VARS_FILE);

    if (existsSync(devVariablesPath)) {
        try {
            add(Object.fromEntries(parseDevVariableEntries(readFileSync(devVariablesPath, "utf8")).map((entry) => [entry.key, entry.value])));
        } catch {
            // Unreadable `.dev.vars`: read as unset here, like `checkDevVariables` does.
        }
    }

    return names;
};

/**
 * Run the three AI checks. All of them only apply to a project that uses `ctx.ai`.
 *
 * No `ai` binding is a WARN (`ai-binding-missing`): every model call fails at
 * runtime. WARN rather than FAIL because usage is inferred from an import, which
 * a type-only import can trip.
 *
 * `LUNORA_AI_GATEWAY_TOKEN` set is a WARN (`ai-gateway-token-unused`): the
 * Workers AI binding has no field to send it, so `ctx.ai` never does — the same
 * condition `@lunora/ai` warns about at runtime.
 *
 * No `LUNORA_AI_GATEWAY_ID` is an INFO (`ai-gateway-default`): slugs go through
 * the account's `default` gateway, which works but is shared by everything on
 * the account.
 *
 * `LUNORA_AI_PROXY_URL` replaces both the binding and the gateway for slugs, so
 * it silences the first and last.
 */
const checkAi = (parsed: WranglerConfig | undefined, cwd: string, usesAi: boolean, findings: Finding[]): void => {
    if (parsed === undefined || !usesAi) {
        return;
    }

    const variables = configuredVariables(parsed, cwd);
    const hasProxy = variables.has(AI_PROXY_URL_VAR);
    const binding = parsed.ai?.binding;

    if (!hasProxy && (typeof binding !== "string" || binding.length === 0)) {
        findings.push({
            code: "ai-binding-missing",
            fix: `Run \`lunora dev\` (it adds the binding), add \`"ai": { "binding": "AI" }\` to wrangler.jsonc, or set ${AI_PROXY_URL_VAR} to an OpenAI-compatible proxy.`,
            level: "warn",
            message: "the project uses ctx.ai (@lunora/ai / env.AI) but wrangler.jsonc declares no `ai` binding — model calls will fail at runtime.",
        });
    }

    if (variables.has(AI_GATEWAY_TOKEN_VAR)) {
        findings.push({
            code: "ai-gateway-token-unused",
            fix: "Make the gateway unauthenticated for ctx.ai, or remove the token. A bring-your-own AI SDK provider built with `resolveAiGateway` does send it.",
            level: "warn",
            message: `${AI_GATEWAY_TOKEN_VAR} is set, but ctx.ai's Workers AI binding cannot send a gateway token — it is ignored on that path.`,
        });
    }

    if (!hasProxy && !variables.has(AI_GATEWAY_ID_VAR)) {
        findings.push({
            code: "ai-gateway-default",
            fix: `Run \`lunora ai gateway\` to create a gateway for this app and write ${AI_GATEWAY_ID_VAR} into wrangler vars.`,
            level: "info",
            message: `no ${AI_GATEWAY_ID_VAR} in vars or ${DEV_VARS_FILE} — \`<provider>/<model>\` slugs route through the account's \`default\` AI Gateway.`,
        });
    }
};

export default checkAi;
