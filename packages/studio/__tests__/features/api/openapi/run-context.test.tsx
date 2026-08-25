import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ApiOperation } from "../../../../src/features/api/openapi/openapi-model";
import { OperationRunProvider, useOperationRun } from "../../../../src/features/api/openapi/run-context";
import { createMockClient } from "../../../mock-client";

vi.mock(import("../../../../src/lib/rest-dispatch"), () => {
    return {
        default: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => {
            return { ok: true };
        }),
    };
});

const restDispatchModule = await import("../../../../src/lib/rest-dispatch");
const restDispatch = vi.mocked(restDispatchModule.default);

/** A plain `httpRouter()` route — no `functionPath`, so it dispatches over REST. */
const REST_OPERATION: ApiOperation = {
    httpPath: "/api/health",
    key: "/api/health",
    method: "GET",
    operationId: "health",
    responses: [],
    summary: "health",
    tags: ["ops"],
    title: "health",
};

/** Surfaces the context so a test can drive `send()` and read the status back. */
const Harness = (): ReactElement => {
    const run = useOperationRun();

    return (
        <>
            {/* `send` is already fire-and-forget on the context — it records its
                own failure in `status`/`error` rather than rejecting. */}
            <button onClick={run.send} type="button">
                send
            </button>
            <p>status: {run.status}</p>
        </>
    );
};

const renderRun = (operation: ApiOperation): void => {
    render(
        <LunoraProvider client={createMockClient().asClient}>
            <OperationRunProvider operation={operation}>
                <Harness />
            </OperationRunProvider>
        </LunoraProvider>,
    );
};

describe("operationRunProvider", () => {
    it("dispatches an operation without a functionPath over REST", async () => {
        expect.assertions(2);

        restDispatch.mockClear();
        renderRun(REST_OPERATION);

        fireEvent.click(screen.getByRole("button", { name: "send" }));

        await expect(screen.findByText("status: success")).resolves.toBeDefined();
        // The operation, its parsed args, the worker origin, and the admin bearer
        // — the console must forward all four, or the request goes to the studio's
        // own server unauthenticated and the SPA fallback answers it with HTML.
        expect(restDispatch).toHaveBeenCalledWith(REST_OPERATION, {}, "http://127.0.0.1:8787", "mock-admin-token");
    });
});
