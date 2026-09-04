import { describe, expect, it } from "vitest";

import { runTaskList } from "../../src/util/tui-prompts";

describe("runTaskList", () => {
    it("stops starting tasks once the run is cancelled", async () => {
        expect.assertions(2);

        // Ctrl-C unmounts the Ink app and throws `PromptCancelledError` straight
        // away, but the task chain it started keeps going. `lunora init` reacts
        // by removing the partially-created project — and the orphaned chain
        // then re-runs `copyTemplate` and re-creates the whole thing, over a
        // "removed the partially-created project" line the user just read.
        const ran: string[] = [];
        const cancelled = { value: false };

        const tasks = [
            {
                label: "fetch",
                run: async () => {
                    ran.push("fetch");
                    cancelled.value = true;
                },
            },
            {
                label: "copy",
                run: async () => {
                    ran.push("copy");
                },
            },
        ];

        const { failure } = await runTaskList(
            tasks,
            () => {},
            () => cancelled.value,
        );

        expect(ran).toStrictEqual(["fetch"]);
        expect(failure).toBeUndefined();
    });

    it("runs every task in order when nothing cancels", async () => {
        expect.assertions(1);

        const ran: string[] = [];
        const tasks = ["a", "b", "c"].map((label) => {
            return {
                label,
                run: async () => {
                    ran.push(label);
                },
            };
        });

        await runTaskList(
            tasks,
            () => {},
            () => false,
        );

        expect(ran).toStrictEqual(["a", "b", "c"]);
    });
});
