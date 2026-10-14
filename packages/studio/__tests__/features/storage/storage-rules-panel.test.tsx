import { LunoraProvider } from "@lunora/react";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import StorageRulesPanel from "../../../src/features/storage/storage-rules-panel";
import type { StorageRulesResult } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const METADATA: StorageRulesResult = {
    rules: [
        { bucket: "avatars", file: "avatars", on: "read", prefix: "user/", procedure: "uploadAvatar" },
        { bucket: "avatars", file: "avatars", on: "write", prefix: "user/", procedure: "uploadAvatar" },
        { bucket: "exports", file: "exports", on: "delete", procedure: "purgeExport" },
    ],
};

/** A client whose `storageRules` admin query returns the fixed metadata above. */
const createRulesClient = (result: StorageRulesResult = METADATA): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.storageRules) {
                return result;
            }

            throw new Error(`unexpected query: ${reference}`);
        },
    });

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <StorageRulesPanel />
    </LunoraProvider>
);

describe("storageRulesPanel", () => {
    it("lists each rule's bucket, operation, prefix, and declaring procedure", async () => {
        expect.assertions(3);

        render(renderPanel(createRulesClient()));

        const readRow = await screen.findByTestId("storage-rule-avatars-read-user/");

        expect(readRow.textContent).toContain("avatars");
        expect(readRow.textContent).toContain("user/");
        expect(readRow.textContent).toContain("uploadAvatar");
    });

    it("renders a prefix-less rule as governing the whole bucket", async () => {
        expect.assertions(1);

        render(renderPanel(createRulesClient()));

        const deleteRow = await screen.findByTestId("storage-rule-exports-delete-");

        expect(deleteRow.textContent).toContain("(whole bucket)");
    });

    it("shows the empty state when no rules are defined", async () => {
        expect.assertions(1);

        render(renderPanel(createRulesClient({ rules: [] })));

        const empty = await screen.findByTestId("storage-rules-empty");

        expect(empty).toBeDefined();
    });

    it("surfaces an admin error", async () => {
        expect.hasAssertions();

        const mock = createMockClient({
            query: (): unknown => {
                throw new Error("not authorized");
            },
        });

        render(renderPanel(mock));

        await waitFor(() => {
            expect(screen.getByTestId("storage-rules-error").textContent).toContain("not authorized");
        });
    });
});
