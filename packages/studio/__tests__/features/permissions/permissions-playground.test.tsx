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

/**
 * Models the server's own `runAs` argument validation: `@lunora/do`'s
 * `admin-rpc-args` rejects a blank `userId` with a 400 BEFORE dispatching
 * anything, so a mock that answers `runAs` unconditionally lets a caller that
 * forges an empty identity look like a working probe.
 */
const runAsServer =
    (answer: () => unknown) =>
    (reference: string, args: unknown): unknown => {
        if (reference !== ADMIN_FUNCTIONS.runAs) {
            throw new Error(`unexpected query: ${reference}`);
        }

        const { userId } = args as { userId?: unknown };

        if (typeof userId !== "string" || userId.trim() === "") {
            throw new Error("runAs: `userId` is required");
        }

        return answer();
    };

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

        const mock = createMockClient({ query: runAsServer(() => [{ _id: "doc_1" }]) });

        render(renderPlayground(mock, true));

        fireEvent.change(screen.getByTestId("pp-user"), { target: { value: "user_1" } });
        fireEvent.click(screen.getByTestId("pp-run"));

        const allowed = await screen.findByTestId("pp-outcome-allowed");

        expect(allowed.textContent).toContain("Allowed");
        expect(screen.getByTestId("pp-result").textContent).toContain("doc_1");
    });

    it("renders the denied outcome when the probe throws", async () => {
        expect.hasAssertions();

        const mock = createMockClient({
            query: runAsServer(() => {
                throw new Error("not authorized");
            }),
        });

        render(renderPlayground(mock, true));

        fireEvent.change(screen.getByTestId("pp-user"), { target: { value: "user_1" } });
        fireEvent.click(screen.getByTestId("pp-run"));

        const denied = await screen.findByTestId("pp-outcome-denied");

        expect(denied.textContent).toContain("Denied");

        await waitFor(() => {
            expect(screen.getByTestId("pp-denied").textContent).toContain("not authorized");
        });
    });

    it("does not dispatch — and never claims Denied — when no identity is supplied", async () => {
        expect.assertions(4);

        const mock = createMockClient({ query: runAsServer(() => [{ _id: "doc_1" }]) });

        render(renderPlayground(mock, true));

        fireEvent.click(screen.getByTestId("pp-run"));

        const invalid = await screen.findByTestId("pp-outcome-invalid");

        // The probe answers "would THIS identity be allowed?" — with no identity
        // there is nothing to answer, so the RPC is never sent and the panel must
        // not render the destructive verdict for a call the server never dispatched.
        expect(invalid.textContent).toContain("Not run");
        expect(screen.queryByTestId("pp-outcome-denied")).toBeNull();
        expect(screen.queryByTestId("pp-outcome-allowed")).toBeNull();
        expect(mock.query).not.toHaveBeenCalled();
    });
});
