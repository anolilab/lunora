/**
 * `lunora doctor`'s AI checks — static and offline, like the rest of the preflight.
 *
 * `ctx.ai` runs over the Workers `env.AI` binding, and its `<provider>/<model>`
 * slugs route through the AI Gateway named by `LUNORA_AI_GATEWAY_ID` (else the
 * account's auto-created `default` gateway). These checks read only the wrangler
 * config and the binding inference `doctor` already ran.
 */
import type { WranglerConfig } from "@lunora/config/cloudflare";

import type { Finding } from "./handler";

/** The wrangler keys these checks read that `WranglerConfig` does not type. */
interface WranglerAiShape {
    ai?: { binding?: unknown } | null;
}

const hasVariable = (variables: Record<string, unknown> | undefined, key: string): boolean => {
    const value = variables?.[key];

    return typeof value === "string" && value.trim().length > 0;
};

/**
 * Run the three AI checks against the parsed wrangler config.
 *
 * `ctx.ai` used but no `ai` binding is a WARN (`ai-binding-missing`): every model
 * call fails at runtime. WARN rather than FAIL because usage is inferred from an
 * import, which a type-only import can trip. `LUNORA_AI_GATEWAY_TOKEN` in vars
 * with no gateway id is a WARN (`ai-gateway-token-unused`): the token only rides
 * along with an explicit gateway. `ctx.ai` used with no `LUNORA_AI_GATEWAY_ID`
 * is an INFO (`ai-gateway-default`): slugs go through the account's `default`
 * gateway, which works but is shared by everything on the account. Neither
 * binding nor gateway check fires when `LUNORA_AI_PROXY_URL` is set.
 */
const checkAi = (parsed: WranglerConfig | undefined, usesAi: boolean, findings: Finding[]): void => {
    if (parsed === undefined) {
        return;
    }

    const { vars } = parsed;
    const hasGatewayId = hasVariable(vars, "LUNORA_AI_GATEWAY_ID");
    // A self-hosted proxy replaces both the binding and the gateway for slugs.
    const hasProxy = hasVariable(vars, "LUNORA_AI_PROXY_URL");

    if (usesAi && !hasProxy) {
        const binding = (parsed as WranglerAiShape).ai?.binding;

        if (typeof binding !== "string" || binding.length === 0) {
            findings.push({
                code: "ai-binding-missing",
                fix: 'Run `lunora dev` (it adds the binding), or add `"ai": { "binding": "AI" }` to wrangler.jsonc.',
                level: "warn",
                message: "the project uses ctx.ai (@lunora/ai / env.AI) but wrangler.jsonc declares no `ai` binding — model calls will fail at runtime.",
            });
        }
    }

    if (!hasGatewayId && hasVariable(vars, "LUNORA_AI_GATEWAY_TOKEN")) {
        findings.push({
            code: "ai-gateway-token-unused",
            fix: "Set LUNORA_AI_GATEWAY_ID (`lunora ai gateway`), or remove the token. Keep tokens out of plain-text vars — use `wrangler secret put`.",
            level: "warn",
            message: "LUNORA_AI_GATEWAY_TOKEN is set in wrangler vars but LUNORA_AI_GATEWAY_ID is not, so the token is never sent.",
        });
    }

    if (usesAi && !hasGatewayId && !hasProxy) {
        findings.push({
            code: "ai-gateway-default",
            fix: "Run `lunora ai gateway` to create a gateway for this app and write LUNORA_AI_GATEWAY_ID into wrangler vars.",
            level: "info",
            message: "no LUNORA_AI_GATEWAY_ID in wrangler vars — `<provider>/<model>` slugs route through the account's `default` AI Gateway.",
        });
    }
};

export default checkAi;
