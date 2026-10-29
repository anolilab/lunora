import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import projectRootFor from "../../src/util/project-root";

describe("projectRootFor", () => {
    it("is the working directory when no root is given", () => {
        expect.assertions(1);

        expect(projectRootFor("/work/app", undefined)).toBe("/work/app");
    });

    it("resolves a relative root against the working directory", () => {
        expect.assertions(1);

        expect(projectRootFor("/work", "apps/site")).toBe(resolve("/work", "apps/site"));
    });

    it("keeps an absolute root as it is", () => {
        expect.assertions(1);

        expect(projectRootFor("/work", "/elsewhere/app")).toBe("/elsewhere/app");
    });
});
