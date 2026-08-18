import type { FunctionReference } from "@lunora/client";
import { describe, expect, it } from "vitest";
import { effectScope, nextTick, watch } from "vue";

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

    // Ref-counted `pending` across overlapping calls lives entirely in
    // `createCallRunner` and is pinned there; what only a Vue test can prove is
    // that the runner's writes actually land in reactive cells a template
    // watches, rather than in plain variables that never notify.
    it("notifies a watcher on data, error and pending", async () => {
        const fake = createFakeClient();
        fake.actionSpy.mockResolvedValueOnce({ code: 0 }).mockRejectedValueOnce(new Error("refused"));

        const scope = effectScope();
        const handle = scope.run(() => fake.provide(() => useAction(runCommand)))!;

        const seenData: unknown[] = [];
        const seenError: (string | undefined)[] = [];
        const seenPending: boolean[] = [];

        scope.run(() => {
            watch(handle.data, (next) => seenData.push(next));
            watch(handle.error, (next) => seenError.push(next?.message));
            watch(handle.pending, (next) => seenPending.push(next));
        });

        await handle.call({ command: "lunora" });
        await nextTick();

        expect(seenData).toStrictEqual([{ code: 0 }]);
        expect(seenPending).toStrictEqual([true, false]);

        await expect(handle.call({ command: "bash" })).rejects.toThrow("refused");

        await nextTick();

        expect(seenError).toStrictEqual(["refused"]);

        scope.stop();
    });

    it("keeps the previous data when a later call fails", async () => {
        const fake = createFakeClient();
        fake.actionSpy.mockResolvedValueOnce({ code: 0 }).mockRejectedValueOnce(new Error("refused"));

        const scope = effectScope();
        const handle = scope.run(() => fake.provide(() => useAction(runCommand)))!;

        await handle.call({ command: "lunora" });

        expect(handle.data.value).toStrictEqual({ code: 0 });

        await expect(handle.call({ command: "bash" })).rejects.toThrow("refused");

        // The adapter-wide contract: a failure sets `error` and leaves the last
        // successful `data` in place, so a transient error does not blank the view.
        expect(handle.error.value?.message).toBe("refused");
        expect(handle.data.value).toStrictEqual({ code: 0 });

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
