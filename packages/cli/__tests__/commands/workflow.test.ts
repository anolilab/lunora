import { describe, expect, it } from "vitest";

import type { FetchLike } from "../../src/commands/run/handler";
import { runWorkflowCommand } from "../../src/commands/workflow/handler";
import { EXIT_CODE } from "../../src/util/exit-code";
import type { Logger } from "../../src/util/logger";

const silentLogger = (): Logger => {
    return { error: () => {}, info: () => {}, success: () => {}, warn: () => {} };
};

/** A worker answering `status`, recording the RPC envelopes and bearer it was sent. */
const recordingWorker =
    (status: number, calls: { authorization: string | undefined; body: unknown; url: string }[]): FetchLike =>
    async (url, init) => {
        calls.push({ authorization: init?.headers?.authorization, body: JSON.parse(init?.body ?? "{}"), url });

        return {
            json: async () => {
                return {};
            },
            ok: status < 300,
            status,
            text: async () => JSON.stringify({ result: { id: "wf-1", status: "queued" } }),
        };
    };

const base = { logger: silentLogger(), token: "t", url: "http://localhost:8787" };

describe("lunora workflow", () => {
    it("create dispatches the createWorkflowInstance admin op with the id and parsed params", async () => {
        expect.assertions(3);

        const calls: { authorization: string | undefined; body: unknown; url: string }[] = [];
        const result = await runWorkflowCommand({
            ...base,
            exportName: "onboarding",
            fetchImpl: recordingWorker(200, calls),
            id: "user-u1",
            params: '{"userId":"u1"}',
            subcommand: "create",
        });

        expect(result.code).toBe(0);
        expect(calls).toStrictEqual([
            {
                authorization: "Bearer t",
                body: {
                    args: { exportName: "onboarding", id: "user-u1", params: { userId: "u1" } },
                    functionPath: "__lunora_admin__:createWorkflowInstance",
                },
                url: "http://localhost:8787/_lunora/rpc",
            },
        ]);
        expect(result.body).toStrictEqual({ id: "wf-1", status: "queued" });
    });

    it("send-event dispatches the sendWorkflowEvent admin op with the instance id, type and payload", async () => {
        expect.assertions(2);

        const calls: { authorization: string | undefined; body: unknown; url: string }[] = [];
        const result = await runWorkflowCommand({
            ...base,
            exportName: "onboarding",
            fetchImpl: recordingWorker(200, calls),
            id: "user-u1",
            payload: '{"by":"ada"}',
            subcommand: "send-event",
            type: "approved",
        });

        expect(result.code).toBe(0);
        expect(calls[0]?.body).toStrictEqual({
            args: { exportName: "onboarding", id: "user-u1", payload: { by: "ada" }, type: "approved" },
            functionPath: "__lunora_admin__:sendWorkflowEvent",
        });
    });

    it("maps the worker's refusal to a non-zero exit code", async () => {
        expect.assertions(1);

        const result = await runWorkflowCommand({
            ...base,
            exportName: "onboarding",
            fetchImpl: recordingWorker(400, []),
            id: "i",
            subcommand: "send-event",
            type: "nope",
        });

        expect(result.code).not.toBe(0);
    });

    it.each([
        ["create without an export name", { subcommand: "create" }],
        ["create with invalid --params", { exportName: "w", params: "{", subcommand: "create" }],
        ["send-event without an event type", { exportName: "w", id: "i", subcommand: "send-event" }],
        ["send-event with invalid --payload", { exportName: "w", id: "i", payload: "{", subcommand: "send-event", type: "t" }],
        ["an unknown subcommand", { subcommand: "list" }],
    ])("rejects %s without calling the worker", async (_name, input) => {
        expect.assertions(2);

        const calls: { authorization: string | undefined; body: unknown; url: string }[] = [];
        const result = await runWorkflowCommand({ ...base, fetchImpl: recordingWorker(200, calls), ...input });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(calls).toHaveLength(0);
    });
});
