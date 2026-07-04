import { describe, expect, it } from "vitest";

import { buildAgentPrompt, buildMcpConfig } from "../../../src/features/home/connect-agent";

describe("buildMcpConfig", () => {
    it("emits an mcpServers entry wiring npx @lunora/mcp to the given origin", () => {
        expect.assertions(1);

        const config = JSON.parse(buildMcpConfig("https://app.example.com")) as {
            mcpServers: { lunora: { args: string[]; command: string; env: Record<string, string> } };
        };

        expect(config.mcpServers.lunora).toStrictEqual({
            args: ["-y", "@lunora/mcp"],
            command: "npx",
            env: { LUNORA_ADMIN_TOKEN: "<your-admin-token>", LUNORA_URL: "https://app.example.com" },
        });
    });
});

describe("buildAgentPrompt", () => {
    it("names every MCP tool and points at the deployment's OpenAPI endpoint", () => {
        expect.assertions(4);

        const prompt = buildAgentPrompt("https://app.example.com");

        expect(prompt).toContain("connected to the deployment at https://app.example.com");
        expect(prompt).toContain("lunora_list_functions");
        expect(prompt).toContain("lunora_run_action");
        expect(prompt).toContain("https://app.example.com/_lunora/admin/openapi");
    });
});
