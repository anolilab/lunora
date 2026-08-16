import type { FunctionReference } from "@lunora/client";
import { describe, expect, it } from "vitest";
import { effectScope } from "vue";

import { useAction } from "../src/use-action";
import { createFakeClient } from "./fake-client";

const runCommand: FunctionReference = { __lunoraRef: "commands:run" };

describe(useAction, () => {
    it("resolves with the server value, exposing reactive data/pending refs", async () => {
        const fake = createFakeClient();
        fake.actionSpy.mockResolvedValue({ code: 0, stdout: "ok" });

        const scope = effectScope();
        const handle = scope.run(() => fake.provide(() => useAction(runCommand)))!;

        expect(handle.pending.value).toBe(false);
        expect(handle.data.value).toBeUndefined();

        const result = await handle.call({ command: "lunora" }, { shardKey: "project-1" });

        expect(result).toStrictEqual({ code: 0, stdout: "ok" });
        expect(handle.data.value).toStrictEqual({ code: 0, stdout: "ok" });
        expect(handle.error.value).toBeUndefined();
        expect(handle.pending.value).toBe(false);
        expect(fake.actionSpy).toHaveBeenCalledWith(runCommand, { command: "lunora" }, { shardKey: "project-1" });

        scope.stop();
    });

    it("records a normalized error, rejects, and clears pending", async () => {
        const fake = createFakeClient();
        fake.actionSpy.mockRejectedValue("refused");

        const scope = effectScope();
        const handle = scope.run(() => fake.provide(() => useAction(runCommand)))!;

        // A thrown non-Error is normalized, so a template can always read
        // `error.message` rather than branching on what the server threw.
        await expect(handle.call({ command: "bash" })).rejects.toThrow("refused");
        expect(handle.error.value).toBeInstanceOf(Error);
        expect(handle.pending.value).toBe(false);

        scope.stop();
    });

    it("keeps pending true until the last of several overlapping calls settles", async () => {
        const fake = createFakeClient();
        const resolvers: ((value: unknown) => void)[] = [];

        // `mockImplementationOnce` twice rather than one promise-returning
        // implementation: the spy is typed void-returning, so handing it an
        // implementation that returns a promise trips `no-misused-promises`.
        const first = new Promise((resolve) => {
            resolvers.push(resolve);
        });
        const second = new Promise((resolve) => {
            resolvers.push(resolve);
        });

        fake.actionSpy.mockReturnValueOnce(first).mockReturnValueOnce(second);

        const scope = effectScope();
        const handle = scope.run(() => fake.provide(() => useAction(runCommand)))!;

        const both = Promise.all([handle.call({ command: "lunora" }), handle.call({ command: "pnpm" })]);

        expect(handle.pending.value).toBe(true);

        // Settling only the first must NOT clear pending — that is the whole
        // point of ref-counting, and getting it wrong hides a running call.
        resolvers[0]?.({ code: 0 });
        await Promise.resolve();

        expect(handle.pending.value).toBe(true);

        resolvers[1]?.({ code: 0 });
        await both;

        expect(handle.pending.value).toBe(false);

        scope.stop();
    });

    it("reset clears data and error back to idle", async () => {
        const fake = createFakeClient();
        fake.actionSpy.mockResolvedValue({ code: 0 });

        const scope = effectScope();
        const handle = scope.run(() => fake.provide(() => useAction(runCommand)))!;

        await handle.call({ command: "lunora" });

        expect(handle.data.value).toStrictEqual({ code: 0 });

        handle.reset();

        expect(handle.data.value).toBeUndefined();

        scope.stop();
    });
});
