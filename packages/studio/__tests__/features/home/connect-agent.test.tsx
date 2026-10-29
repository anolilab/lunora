import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { buildAgentPrompt, buildMcpConfig, ConnectAgentCard } from "../../../src/features/home/connect-agent";
import { createMockClient } from "../../mock-client";

describe("connectAgentCard", () => {
    it("points the copied MCP config at the worker, not the studio's own origin", () => {
        expect.assertions(1);

        const writes: string[] = [];

        vi.stubGlobal("navigator", {
            clipboard: {
                writeText: async (text: string): Promise<void> => {
                    writes.push(text);
                },
            },
        });

        try {
            const mock = createMockClient();

            // A studio served on its own host, pointed at a deployed worker.
            (mock.asClient as unknown as { url: string }).url = "https://api.prod.example/";

            render(
                <LunoraProvider client={mock.asClient}>
                    <ConnectAgentCard />
                </LunoraProvider>,
            );
            fireEvent.click(screen.getByTestId("home-connect-agent-copy-config"));

            expect(JSON.parse(writes[0] ?? "{}")).toMatchObject({ mcpServers: { lunora: { env: { LUNORA_URL: "https://api.prod.example" } } } });
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

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
