import { describe, expect, it } from "vitest";

import isDevEnvironment from "../src/environment";

describe(isDevEnvironment, () => {
    it("is true when an environment var names a dev environment", () => {
        expect.assertions(3);

        expect(isDevEnvironment({ WORKER_ENV: "development" })).toBe(true);
        expect(isDevEnvironment({ NODE_ENV: "test" })).toBe(true);
        expect(isDevEnvironment({ CF_ENV: "Local" })).toBe(true);
    });

    it("fails closed: no environment var, or a production one, is production", () => {
        expect.assertions(3);

        expect(isDevEnvironment({})).toBe(false);
        expect(isDevEnvironment({ ENVIRONMENT: "production" })).toBe(false);
        expect(isDevEnvironment({ WORKER_ENV: 1 })).toBe(false);
    });
});
