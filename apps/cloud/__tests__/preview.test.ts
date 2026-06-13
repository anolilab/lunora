import { describe, expect, it } from "vitest";

import { PREVIEW_TTL_MS, previewExpiry, previewScriptName } from "../src/deploy/preview";

describe(previewScriptName, () => {
    it("is deterministic and sanitized", () => {
        expect(previewScriptName("My App", "feat/Cool Thing")).toBe("my-app-pr-feat-cool-thing");
        expect(previewScriptName("My App", "feat/Cool Thing")).toBe(previewScriptName("My App", "feat/Cool Thing"));
    });

    it("strips leading/trailing separators", () => {
        expect(previewScriptName("proj", "/branch/")).toBe("proj-pr-branch");
    });
});

describe(previewExpiry, () => {
    it("adds the default 5-day TTL", () => {
        expect(previewExpiry(1000)).toBe(1000 + PREVIEW_TTL_MS);
    });

    it("honors a custom TTL", () => {
        expect(previewExpiry(1000, 5000)).toBe(6000);
    });
});
