import { describe, expect, it } from "vitest";

import isDevEnvironment from "../src/environment";

describe(isDevEnvironment, () => {
    it("is true when every set environment var names a dev environment", () => {
        expect.assertions(3);

        // What `lunora dev` writes into `.dev.vars`.
        expect(isDevEnvironment({ WORKER_ENV: "development" })).toBe(true);
        expect(isDevEnvironment({ NODE_ENV: "test" })).toBe(true);
        expect(isDevEnvironment({ CF_ENV: "Local", WORKER_ENV: "development" })).toBe(true);
    });

    it("is false when an empty var sits beside a dev one: an empty value is still set", () => {
        expect.assertions(2);

        expect(isDevEnvironment({ CF_ENV: "", NODE_ENV: "development", WORKER_ENV: "development" })).toBe(false);
        expect(isDevEnvironment({ NODE_ENV: "", WORKER_ENV: "development" })).toBe(false);
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

    it("is false when a non-string var sits beside a dev one", () => {
        expect.assertions(2);

        expect(isDevEnvironment({ ENVIRONMENT: { name: "production" }, WORKER_ENV: "development" })).toBe(false);
        expect(isDevEnvironment({ NODE_ENV: 1, WORKER_ENV: "development" })).toBe(false);
    });
});
