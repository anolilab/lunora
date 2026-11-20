import { describe, expect, it } from "vitest";

import type { CatalogForm, FormSecret } from "../src/catalog/artifact";
import { initialValues, withoutBlanks } from "../src/client/catalog-values";

const sessionKey: FormSecret = { generate: "base64-32", label: "Session key", name: "SESSION_KEY", required: true };
const webhookToken: FormSecret = { label: "Webhook token", name: "WEBHOOK_TOKEN", required: false };

const form: CatalogForm = {
    secrets: [sessionKey, webhookToken],
    vars: [
        { default: "https://example.test", label: "Base URL", name: "BASE_URL", required: true },
        { label: "Greeting", name: "GREETING", required: false },
    ],
};

describe(initialValues, () => {
    it("prefills vars from their default and leaves the rest blank", () => {
        expect(initialValues(form).vars).toStrictEqual({ BASE_URL: "https://example.test", GREETING: "" });
    });

    it("never pre-fills a secret", () => {
        expect(initialValues(form).secrets).toStrictEqual({ SESSION_KEY: "", WEBHOOK_TOKEN: "" });
    });

    it("returns empty maps for an app with no form fields", () => {
        expect(initialValues({ secrets: [], vars: [] })).toStrictEqual({ secrets: {}, vars: {} });
    });
});

describe(withoutBlanks, () => {
    it("drops empty entries and keeps filled ones", () => {
        expect(withoutBlanks({ BASE_URL: "https://example.test", GREETING: "" })).toStrictEqual({ BASE_URL: "https://example.test" });
    });
});
