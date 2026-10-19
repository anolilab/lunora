import { describe, expect, it } from "vitest";

import isDevEnvironment from "../src/environment";

describe(isDevEnvironment, () => {
    it("is true when every set environment var names a dev environment", () => {
        expect.assertions(4);

        // What `lunora dev` writes into `.dev.vars`.
        expect(isDevEnvironment({ WORKER_ENV: "development" })).toBe(true);
        expect(isDevEnvironment({ NODE_ENV: "test" })).toBe(true);
        expect(isDevEnvironment({ CF_ENV: "Local", WORKER_ENV: "development" })).toBe(true);
        // An empty var counts as unset.
        expect(isDevEnvironment({ NODE_ENV: "", WORKER_ENV: "development" })).toBe(true);
    });

    it("fails closed: no environment var, or a production one, is production", () => {
        expect.assertions(3);

        expect(isDevEnvironment({})).toBe(false);
        expect(isDevEnvironment({ ENVIRONMENT: "production" })).toBe(false);
        expect(isDevEnvironment({ WORKER_ENV: 1 })).toBe(false);
    });

    it("is false when a production var sits beside a leftover dev one", () => {
        expect.assertions(1);

        expect(isDevEnvironment({ ENVIRONMENT: "production", NODE_ENV: "development" })).toBe(false);
    });
});
