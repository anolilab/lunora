import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { useT } from "../../i18n/i18n-context";
import { copyToClipboard, resolveOrigin } from "../../lib/internal";

/**
 * The MCP tools `@lunora/mcp` exposes, paired with a one-line summary. This is
 * the same surface the server registers, reproduced here purely to describe it
 * in the copy-able agent prompt — the two write tools are only live when
 * `LUNORA_MCP_ALLOW_WRITES` is set, which the summaries call out.
 */
const MCP_TOOLS: ReadonlyArray<{ readonly name: string; readonly summary: string }> = [
    { name: "lunora_list_functions", summary: "list every query, mutation, and action with its path" },
    { name: "lunora_list_tables", summary: "list the schema's tables" },
    { name: "lunora_get_function_schema", summary: "read a function's argument JSON Schema before calling it" },
    { name: "lunora_run_query", summary: "run a read-only query" },
    { name: "lunora_run_mutation", summary: "run a mutation — writes; only when LUNORA_MCP_ALLOW_WRITES is set" },
    { name: "lunora_run_action", summary: "run an action — writes/effects; only when LUNORA_MCP_ALLOW_WRITES is set" },
];

/**
 * The ready-to-paste MCP client config (Claude Desktop / Cursor `mcpServers`
 * shape) for this deployment: the `@lunora/mcp` stdio server (run via `npx`)
 * wired to this origin. `LUNORA_ADMIN_TOKEN` is a placeholder the operator fills
 * in — the studio never has the raw admin token to embed.
 */
const buildMcpConfig = (origin: string): string =>
    JSON.stringify(
        {
            mcpServers: {
                lunora: {
                    args: ["-y", "@lunora/mcp"],
                    command: "npx",
                    env: { LUNORA_ADMIN_TOKEN: "<your-admin-token>", LUNORA_URL: origin },
                },
            },
        },
        null,
        2,
    );

/**
 * A natural-language brief handing an agent this deployment: what the connected
 * MCP server is, the tools it can call, and where the full HTTP API is
 * documented. Mirrors the "point your agent at this" affordance, for agents
 * driven by a prompt rather than a config file.
 */
const buildAgentPrompt = (origin: string): string => {
    const tools = MCP_TOOLS.map((tool) => `- ${tool.name} — ${tool.summary}`).join("\n");

    return [
        `You have a Lunora MCP server connected to the deployment at ${origin}.`,
        "It exposes this backend's functions and schema so you can inspect and operate it:",
        tools,
        "",
        `Start by calling lunora_list_functions and lunora_list_tables to learn what exists, then lunora_get_function_schema before any run call. The full HTTP API is also documented at ${origin}/_lunora/admin/openapi (that endpoint needs the same admin token the MCP server is configured with).`,
    ].join("\n");
};

/** How long the copy buttons show their "Copied" acknowledgement before reverting. */
const COPIED_RESET_MS = 1500;

type CopyTarget = "config" | "prompt";

/**
 * The "Connect an AI agent" card — a one-click handoff of this deployment to an
 * AI agent over MCP. Shows the `@lunora/mcp` stdio command and copies either the
 * MCP client config (for config-driven clients like Claude Desktop / Cursor) or
 * a natural-language agent prompt, both pre-filled with this deployment's origin.
 */
const ConnectAgentCard = (): ReactElement => {
    const t = useT();
    const origin = resolveOrigin();
    const [copied, setCopied] = useState<CopyTarget | null>(null);

    // Clear the "Copied" acknowledgement a moment after a copy so it reads as
    // transient feedback, tying the timer's whole lifecycle to `copied` (the
    // same effect-based reset the storage file browser uses) rather than
    // hand-managing a ref.
    useEffect(() => {
        if (copied === null) {
            return undefined;
        }

        const timer = globalThis.setTimeout(() => {
            setCopied(null);
        }, COPIED_RESET_MS);

        return () => {
            globalThis.clearTimeout(timer);
        };
    }, [copied]);

    const copy = (target: CopyTarget, text: string): void => {
        if (!copyToClipboard(text)) {
            // No clipboard (insecure context / SSR) — don't flash a false "Copied".
            return;
        }

        setCopied(target);
    };

    const onCopyConfig = (): void => {
        copy("config", buildMcpConfig(origin));
    };

    const onCopyPrompt = (): void => {
        copy("prompt", buildAgentPrompt(origin));
    };

    return (
        <Card className="gap-0 py-0" data-testid="home-connect-agent">
            <div className="flex flex-col gap-1.5 p-4">
                <span className="text-sm font-medium text-foreground">{t("Connect an AI agent")}</span>
                <span className="text-xs text-muted-foreground">
                    {t(
                        "Drive this deployment from an AI agent over the Model Context Protocol — it can list functions and tables, read schemas, and run read-only queries. Writes stay off unless you opt in.",
                    )}
                </span>
            </div>
            <div className="flex flex-col gap-3 border-t border-border bg-muted/50 px-4 py-3">
                <code className="font-mono text-xs text-muted-foreground" data-testid="home-connect-agent-command">
                    npx -y @lunora/mcp
                </code>
                <div className="flex flex-wrap gap-2">
                    <Button data-testid="home-connect-agent-copy-config" onClick={onCopyConfig} size="xs" variant="outline">
                        {copied === "config" ? t("Copied") : t("Copy MCP config")}
                    </Button>
                    <Button data-testid="home-connect-agent-copy-prompt" onClick={onCopyPrompt} size="xs" variant="outline">
                        {copied === "prompt" ? t("Copied") : t("Copy agent prompt")}
                    </Button>
                </div>
            </div>
        </Card>
    );
};

export { buildAgentPrompt, buildMcpConfig, ConnectAgentCard };
