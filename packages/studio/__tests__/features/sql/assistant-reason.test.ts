import { describe, expect, it } from "vitest";

import assistantReasonMessage from "../../../src/features/sql/assistant-reason";
import type { TFunction } from "../../../src/i18n/i18n-context";

/** Identity translator: the message id is the English copy. */
const t: TFunction = (id) => id;

describe(assistantReasonMessage, () => {
    it.each([
        ["unsafe-response", "The model returned a statement that is not read-only, so it was discarded."],
        ["too-long", "The statement is too long to rewrite. Select a shorter part of it."],
        ["empty-response", "The model returned nothing usable."],
        ["ai-error", "The model could not be reached."],
    ] as const)("words %s", (reason, message) => {
        expect.assertions(1);

        expect(assistantReasonMessage(reason, t)).toBe(message);
    });
});
