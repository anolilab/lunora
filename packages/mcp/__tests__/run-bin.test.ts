import { afterEach, describe, expect, it, vi } from "vitest";

import { BinError, runBin } from "../src/run-bin";

type Connect = () => Promise<undefined>;
type WriteError = (message: string) => void;

describe("runBin", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("throws a BinError(1) and writes to the error sink when LUNORA_URL is missing", async () => {
        expect.assertions(4);

        const connect = vi.fn<Connect>(async () => undefined);
        const writeError = vi.fn<WriteError>();

        await expect(runBin({}, { connect, writeError })).rejects.toBeInstanceOf(BinError);

        expect(connect).not.toHaveBeenCalled();
        expect(writeError).toHaveBeenCalledWith("lunora-mcp: LUNORA_URL environment variable is required\n");
        await expect(runBin({}, { connect, writeError })).rejects.toMatchObject({ code: 1 });
    });

    it("treats an empty-string LUNORA_URL as missing", async () => {
        expect.assertions(2);

        const connect = vi.fn<Connect>(async () => undefined);
        const writeError = vi.fn<WriteError>();

        await expect(runBin({ LUNORA_URL: "" }, { connect, writeError })).rejects.toBeInstanceOf(BinError);

        expect(connect).not.toHaveBeenCalled();
    });

    it("connects with the url and token when LUNORA_URL is present", async () => {
        expect.assertions(1);

        const connect = vi.fn<Connect>(async () => undefined);
        const writeError = vi.fn<WriteError>();

        await runBin({ LUNORA_ADMIN_TOKEN: "admin-token", LUNORA_URL: "https://example.workers.dev" }, { connect, writeError });

        expect(connect).toHaveBeenCalledWith({ agents: [], allowAgents: false, allowWrites: false, token: "admin-token", url: "https://example.workers.dev" });
    });

    it("passes an undefined token through when LUNORA_ADMIN_TOKEN is unset", async () => {
        expect.assertions(2);

        const connect = vi.fn<Connect>(async () => undefined);
        const writeError = vi.fn<WriteError>();

        await runBin({ LUNORA_URL: "https://example.workers.dev" }, { connect, writeError });

        expect(connect).toHaveBeenCalledWith({ agents: [], allowAgents: false, allowWrites: false, token: undefined, url: "https://example.workers.dev" });
        expect(writeError).not.toHaveBeenCalled();
    });

    it("enables writes only when LUNORA_MCP_ALLOW_WRITES is truthy", async () => {
        expect.assertions(1);

        const connect = vi.fn<Connect>(async () => undefined);
        const writeError = vi.fn<WriteError>();

        await runBin({ LUNORA_MCP_ALLOW_WRITES: "true", LUNORA_URL: "https://example.workers.dev" }, { connect, writeError });

        expect(connect).toHaveBeenCalledWith({ agents: [], allowAgents: false, allowWrites: true, token: undefined, url: "https://example.workers.dev" });
    });

    it("exposes agent tools when LUNORA_MCP_ALLOW_AGENTS is truthy and LUNORA_MCP_AGENTS is set", async () => {
        expect.assertions(1);

        const connect = vi.fn<Connect>(async () => undefined);
        const writeError = vi.fn<WriteError>();

        await runBin(
            {
                LUNORA_MCP_AGENT_TIMEOUT_MS: "30000",
                LUNORA_MCP_AGENTS: "support:Support questions;billing:Billing help",
                LUNORA_MCP_ALLOW_AGENTS: "1",
                LUNORA_URL: "https://example.workers.dev",
            },
            { connect, writeError },
        );

        expect(connect).toHaveBeenCalledWith({
            agentMaxWaitMs: 30_000,
            agents: [
                { description: "Support questions", name: "support" },
                { description: "Billing help", name: "billing" },
            ],
            allowAgents: true,
            allowWrites: false,
            token: undefined,
            url: "https://example.workers.dev",
        });
    });

    it("surfaces a startup failure as a BinError(1) and writes the cause", async () => {
        expect.assertions(3);

        const connect = vi.fn<Connect>(async () => {
            throw new Error("boom");
        });
        const writeError = vi.fn<WriteError>();

        await expect(runBin({ LUNORA_URL: "https://example.workers.dev" }, { connect, writeError })).rejects.toMatchObject({
            code: 1,
        });

        expect(writeError).toHaveBeenCalledTimes(1);
        expect(writeError).toHaveBeenCalledWith("lunora-mcp: failed to start — boom\n");
    });

    it("stringifies a non-Error thrown during startup", async () => {
        expect.assertions(1);

        const connect = vi.fn<Connect>(async () => {
            // A non-Error rejection exercises the `String(error)` fallback branch.
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately a non-Error value to cover the String(error) coercion path
            throw "kaboom";
        });
        const writeError = vi.fn<WriteError>();

        await runBin({ LUNORA_URL: "https://example.workers.dev" }, { connect, writeError }).catch(() => undefined);

        expect(writeError).toHaveBeenCalledWith("lunora-mcp: failed to start — kaboom\n");
    });
});
