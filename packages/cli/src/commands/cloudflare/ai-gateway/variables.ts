/**
 * The Worker env vars `@lunora/ai` reads, named once for the CLI (`@lunora/cli`
 * does not depend on `@lunora/ai`, so it cannot import that package's constants).
 */

/** Names the AI Gateway `ctx.ai` routes `<provider>/<model>` slugs through. */
export const AI_GATEWAY_ID_VAR = "LUNORA_AI_GATEWAY_ID";

/** Names the account owning the gateway; read only by bring-your-own providers. */
export const AI_GATEWAY_ACCOUNT_ID_VAR = "LUNORA_AI_GATEWAY_ACCOUNT_ID";

/** An AI Gateway auth token, which the Workers AI binding cannot send. */
export const AI_GATEWAY_TOKEN_VAR = "LUNORA_AI_GATEWAY_TOKEN";

/** A self-hosted OpenAI-compatible proxy that replaces the binding and gateway for slugs. */
export const AI_PROXY_URL_VAR = "LUNORA_AI_PROXY_URL";
