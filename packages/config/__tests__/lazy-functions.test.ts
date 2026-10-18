import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveLazyFunctions } from "../src/codegen-env";

describe("lazy function opt-in", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it.each([
        { flag: undefined, environment: undefined, expected: false },
        { flag: false, environment: undefined, expected: false },
        { flag: true, environment: undefined, expected: true },
        { flag: undefined, environment: "1", expected: true },
        { flag: false, environment: "true", expected: true },
        { flag: false, environment: " TRUE ", expected: true },
        { flag: true, environment: "false", expected: true },
        { flag: true, environment: "0", expected: true },
        { flag: undefined, environment: "false", expected: false },
        { flag: undefined, environment: "0", expected: false },
        { flag: undefined, environment: "yes", expected: false },
    ])("resolves flag=$flag and environment=$environment", ({ flag, environment, expected }) => {
        expect.assertions(1);

        vi.stubEnv("LUNORA_LAZY_FUNCTIONS", environment);

        expect(resolveLazyFunctions(flag)).toBe(expected);
    });
});
