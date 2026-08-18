import type { FunctionReference } from "@lunora/client";
import { describe, expect, it } from "vitest";

import { runAction } from "../src/run-action";
import { createFakeClient } from "./fake-client";

const runRef = { __lunoraRef: "commands:run" } as FunctionReference;

describe(runAction, () => {
    it("calls the client's action and resolves with the result", async () => {
        const fake = createFakeClient();
        fake.setActionResult({ code: 0, stdout: "ok" });

        const result = await runAction(runRef, { command: "lunora" }, { client: fake.asClient });

        expect(result).toStrictEqual({ code: 0, stdout: "ok" });
        expect(fake.actionCalls).toHaveLength(1);
        expect(fake.actionCalls[0]?.functionPath).toBe("commands:run");
        expect(fake.actionCalls[0]?.args).toStrictEqual({ command: "lunora" });
    });

    it("forwards shardKey but never passes `client` on to the transport", async () => {
        const fake = createFakeClient();
        fake.setActionResult({ code: 0 });

        await runAction(runRef, { command: "lunora" }, { client: fake.asClient, shardKey: "project-1" });

        // `client` is this function's own option, not the transport's — leaking it
        // through would put a whole LunoraClient on the wire.
        expect(fake.actionCalls[0]?.options).toStrictEqual({ shardKey: "project-1" });
    });

    it("rejects when the action fails, rather than swallowing it", async () => {
        const fake = createFakeClient();
        fake.setActionThrow(new Error("command refused"));

        await expect(runAction(runRef, { command: "bash" }, { client: fake.asClient })).rejects.toThrow("command refused");
    });
});
