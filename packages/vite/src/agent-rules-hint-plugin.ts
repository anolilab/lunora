import { AGENT_RULES_HINT, claimAgentRulesHint, detectAgentRules } from "@cirrus/config";
import type { Plugin } from "vite";

import type { ResolvedCirrusPluginOptions } from "./types";

/**
 * Dev-only plugin that nudges the developer to install the Cirrus agent skills
 * ("rules") when they're absent from the project. Mirrors the `cirrus dev`
 * hint so the `vite dev` path surfaces it too — a one-line, non-blocking notice
 * pointing at `cirrus rules install`. Skips silently once the rules are present.
 */
const agentRulesHintPlugin = (options: ResolvedCirrusPluginOptions): Plugin => {
    return {
        apply: "serve",
        configureServer(server) {
            // Defer to `configureServer`'s return hook so the notice prints after
            // Vite's own startup output rather than getting buried above it.
            return () => {
                if (detectAgentRules(options.projectRoot).installed || !claimAgentRulesHint()) {
                    return;
                }

                server.config.logger.warn(`\n  [cirrus] ${AGENT_RULES_HINT}\n`);
            };
        },
        name: "cirrus:agent-rules-hint",
    };
};

export default agentRulesHintPlugin;
