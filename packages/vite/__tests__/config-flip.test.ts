import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import configFlipRegenerates from "../src/config-flip";

const projectRoot = resolve("/app");

describe(configFlipRegenerates, () => {
    it("does not regenerate when the value did not flip", () => {
        expect.assertions(1);

        expect(configFlipRegenerates({ baselineSettled: true, file: resolve(projectRoot, "lunora", "x.ts"), flipped: false, projectRoot })).toBe(false);
    });

    it("regenerates on a flip from a nearer config, which the restart does not cover", () => {
        expect.assertions(1);

        expect(configFlipRegenerates({ baselineSettled: true, file: resolve(projectRoot, "src", "lunora.config.ts"), flipped: true, projectRoot })).toBe(true);
    });

    it("leaves a flip from the project-root config to the restart once the baseline has settled", () => {
        expect.assertions(2);

        expect(configFlipRegenerates({ baselineSettled: true, file: resolve(projectRoot, "lunora.config.ts"), flipped: true, projectRoot })).toBe(false);
        expect(configFlipRegenerates({ baselineSettled: true, file: resolve(projectRoot, "lunora.config.mts"), flipped: true, projectRoot })).toBe(false);
    });

    it("regenerates on a flip from the project-root config during startup, when no restart follows", () => {
        expect.assertions(1);

        expect(configFlipRegenerates({ baselineSettled: false, file: resolve(projectRoot, "lunora.config.ts"), flipped: true, projectRoot })).toBe(true);
    });
});
