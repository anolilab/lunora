import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { PermissionsPlayground } from "../../../src/features/permissions/permissions-playground";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { FunctionDescriptor } from "../../../src/lib/types";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const FUNCTIONS: FunctionDescriptor[] = [{ args: [], kind: "query", path: "listDocuments" }];

const renderPlayground = (mock: MockClientHooks, runAsIdentity: boolean): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <PermissionsPlayground functions={FUNCTIONS} runAsIdentity={runAsIdentity} />
    </LunoraProvider>
);

describe("permissionsPlayground", () => {
    it("disables the run control when runAsIdentity is off", () => {
        expect.assertions(2);

        const mock = createMockClient({});

        render(renderPlayground(mock, false));

        expect(screen.getByTestId("pp-gate")).toBeDefined();
        expect(screen.getByTestId<HTMLButtonElement>("pp-run").disabled).toBe(true);
    });

    it("renders the allowed outcome when the probe resolves", async () => {
        expect.assertions(2);

        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.runAs) {
                    return [{ _id: "doc_1" }];
                }

                throw new Error(`unexpected query: ${reference}`);
            },
        });

        render(renderPlayground(mock, true));

        fireEvent.click(screen.getByTestId("pp-run"));

        const allowed = await screen.findByTestId("pp-outcome-allowed");

        expect(allowed.textContent).toContain("Allowed");
        expect(screen.getByTestId("pp-result").textContent).toContain("doc_1");
    });

    it("renders the denied outcome when the probe throws", async () => {
        expect.hasAssertions();

        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.runAs) {
                    throw new Error("not authorized");
                }

                throw new Error(`unexpected query: ${reference}`);
            },
        });

        render(renderPlayground(mock, true));

        fireEvent.click(screen.getByTestId("pp-run"));

        const denied = await screen.findByTestId("pp-outcome-denied");

        expect(denied.textContent).toContain("Denied");

        await waitFor(() => {
            expect(screen.getByTestId("pp-denied").textContent).toContain("not authorized");
        });
    });
});
