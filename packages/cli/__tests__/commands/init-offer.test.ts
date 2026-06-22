import { describe, expect, it, vi } from "vitest";

import type { StackFeature } from "../../src/commands/init/offer-extras";
import { offerRegistryExtras } from "../../src/commands/init/offer-extras";
import type { Logger } from "../../src/util/logger";

const makeLogger = (): { lines: string[]; logger: Logger } => {
    const lines: string[] = [];
    const push =
        (prefix: string) =>
        (message: string): number =>
            lines.push(`${prefix}${message}`);

    return { lines, logger: { error: push("error: "), info: push("info: "), success: push("success: "), warn: push("warn: ") } };
};

describe("offerRegistryExtras", () => {
    it("prints a later-setup hint and applies nothing when non-interactive", async () => {
        expect.assertions(2);

        const apply = vi.fn<(names: ReadonlyArray<string>) => Promise<boolean>>(async () => true);
        const { lines, logger } = makeLogger();

        await offerRegistryExtras({ apply, interactive: false, logger, multiSelect: async () => ["auth", "email"], select: async () => "auth" });

        expect(apply).not.toHaveBeenCalled();
        expect(lines.join("\n")).toMatch(/lunora add/);
    });

    it("applies the chosen auth provider and then email when both are selected", async () => {
        expect.assertions(1);

        const applied: string[][] = [];

        await offerRegistryExtras({
            apply: async (names) => {
                applied.push([...names]);

                return true;
            },
            interactive: true,
            logger: makeLogger().logger,
            multiSelect: async () => ["auth", "email"],
            select: async () => "auth-clerk",
        });

        expect(applied).toStrictEqual([["auth-clerk"], ["mail"]]);
    });

    it("applies only email when only email is selected", async () => {
        expect.assertions(1);

        const applied: string[][] = [];

        await offerRegistryExtras({
            apply: async (names) => {
                applied.push([...names]);

                return true;
            },
            interactive: true,
            logger: makeLogger().logger,
            multiSelect: async () => ["email"],
            select: async () => "auth",
        });

        expect(applied).toStrictEqual([["mail"]]);
    });

    it("applies non-auth/email features as their registry item directly, in selection order", async () => {
        expect.assertions(1);

        const applied: string[][] = [];

        await offerRegistryExtras({
            apply: async (names) => {
                applied.push([...names]);

                return true;
            },
            interactive: true,
            logger: makeLogger().logger,
            multiSelect: async () => ["storage", "ratelimit", "crons", "presence", "backup"],
            select: async () => "auth",
        });

        // No sub-prompt for these — the picked value IS the registry item name.
        expect(applied).toStrictEqual([["storage"], ["ratelimit"], ["crons"], ["presence"], ["backup"]]);
    });

    it("applies nothing when the multi-select returns an empty selection", async () => {
        expect.assertions(1);

        const apply = vi.fn<(names: ReadonlyArray<string>) => Promise<boolean>>(async () => true);

        await offerRegistryExtras({
            apply,
            interactive: true,
            logger: makeLogger().logger,
            multiSelect: async () => [] as StackFeature[],
            select: async () => "auth",
        });

        expect(apply).not.toHaveBeenCalled();
    });

    it("falls back to the default auth item when the provider select returns undefined", async () => {
        expect.assertions(1);

        const applied: string[][] = [];

        await offerRegistryExtras({
            apply: async (names) => {
                applied.push([...names]);

                return true;
            },
            interactive: true,
            logger: makeLogger().logger,
            multiSelect: async () => ["auth"],
            select: async () => undefined,
        });

        expect(applied).toStrictEqual([["auth"]]);
    });
});
