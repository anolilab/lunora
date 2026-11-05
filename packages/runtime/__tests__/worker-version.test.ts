import { describe, expect, it } from "vitest";

import { workerVersionId } from "../../../shared/worker-version";

describe(workerVersionId, () => {
    it("reads the version id, never the tag", () => {
        expect.assertions(1);

        // A tag survives across uploads; only the id changes on every deploy.
        expect(workerVersionId({ CF_VERSION_METADATA: { id: "8ee9-4b4d", tag: "v1.4.0", timestamp: "2026-01-01T00:00:00Z" } })).toBe("8ee9-4b4d");
    });

    it.each([
        ["an undefined env", undefined],
        ["a null env", null],
        ["an env without the binding", {}],
        ["a string-valued binding", { CF_VERSION_METADATA: "8ee9-4b4d" }],
        ["a binding with no id", { CF_VERSION_METADATA: { tag: "v1" } }],
        ["an empty id", { CF_VERSION_METADATA: { id: "" } }],
    ])("is undefined for %s", (_label, env) => {
        expect.assertions(1);

        expect(workerVersionId(env)).toBeUndefined();
    });
});
