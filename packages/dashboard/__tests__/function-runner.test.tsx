import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, test } from "vitest";

import { FunctionRunner } from "../src/function-runner.js";
import type { FunctionDescriptor } from "../src/index.js";
import { createMockClient, type MockClientHooks } from "./mock-client.js";

const functions: FunctionDescriptor[] = [
    { kind: "query", path: "messages:list" },
    { kind: "mutation", path: "messages:send" },
    { kind: "action", path: "stripe:sync" },
];

const renderRunner = (mock: MockClientHooks): ReactElement => (
    <CirrusProvider client={mock.asClient}>
        <FunctionRunner functions={functions} />
    </CirrusProvider>
);

describe("functionRunner", () => {
    test("defaults to the first function and lists all of them", () => {
        const mock = createMockClient();

        render(renderRunner(mock));

        const select = screen.getByTestId("function-select") as HTMLSelectElement;

        expect(select.value).toBe("messages:list");
        expect(screen.getAllByRole("option")).toHaveLength(3);
    });

    test("runs the selected query with parsed JSON args and renders the result", async () => {
        const mock = createMockClient({ query: () => ({ rows: [1, 2] }) });

        render(renderRunner(mock));

        fireEvent.change(screen.getByTestId("args-input"), { target: { value: '{ "limit": 2 }' } });
        fireEvent.click(screen.getByTestId("run-button"));

        await waitFor(() => {
            expect(screen.getByTestId("result")).toBeDefined();
        });

        expect(mock.query).toHaveBeenCalledTimes(1);

        const [reference, args, options] = mock.query.mock.calls[0] as [{ __cirrusRef: string }, unknown, unknown];

        expect(reference.__cirrusRef).toBe("messages:list");
        expect(args).toEqual({ limit: 2 });
        expect(options).toEqual({});
        expect(screen.getByTestId("result").textContent).toBe(JSON.stringify({ rows: [1, 2] }, null, 2));
        expect(mock.mutation).not.toHaveBeenCalled();
    });

    test("routes to client.mutation when the selected function is a mutation", async () => {
        const mock = createMockClient({ mutation: () => ({ ok: true }) });

        render(renderRunner(mock));

        fireEvent.change(screen.getByTestId("function-select"), { target: { value: "messages:send" } });
        fireEvent.click(screen.getByTestId("run-button"));

        await waitFor(() => {
            expect(mock.mutation).toHaveBeenCalledTimes(1);
        });

        const [reference] = mock.mutation.mock.calls[0] as [{ __cirrusRef: string }];

        expect(reference.__cirrusRef).toBe("messages:send");
        expect(mock.query).not.toHaveBeenCalled();
    });

    test("forwards a non-empty shard key in the call options", async () => {
        const mock = createMockClient({ query: () => null });

        render(renderRunner(mock));

        fireEvent.change(screen.getByTestId("shard-input"), { target: { value: "room-1" } });
        fireEvent.click(screen.getByTestId("run-button"));

        await waitFor(() => {
            expect(mock.query).toHaveBeenCalledTimes(1);
        });

        const call = mock.query.mock.calls[0] as [unknown, unknown, { shardKey?: string }];

        expect(call[2]).toEqual({ shardKey: "room-1" });
    });

    test("reports invalid JSON without calling the client", () => {
        const mock = createMockClient();

        render(renderRunner(mock));

        fireEvent.change(screen.getByTestId("args-input"), { target: { value: "{ not json" } });
        fireEvent.click(screen.getByTestId("run-button"));

        expect(screen.getByTestId("error").textContent).toContain("Invalid JSON args");
        expect(mock.query).not.toHaveBeenCalled();
    });

    test("surfaces a thrown server error in the error region", async () => {
        const mock = createMockClient({
            query: () => {
                throw new Error("BOOM");
            },
        });

        render(renderRunner(mock));

        fireEvent.click(screen.getByTestId("run-button"));

        await waitFor(() => {
            expect(screen.getByTestId("error")).toBeDefined();
        });

        expect(screen.getByTestId("error").textContent).toBe("BOOM");
        expect(screen.queryByTestId("result")).toBeNull();
    });

    test("auto-discovers functions from the client when none are supplied", async () => {
        const mock = createMockClient({ listFunctions: () => functions });

        render(
            <CirrusProvider client={mock.asClient}>
                <FunctionRunner />
            </CirrusProvider>,
        );

        await waitFor(() => {
            expect(screen.getAllByRole("option")).toHaveLength(3);
        });

        expect(mock.listFunctions).toHaveBeenCalledWith();
        expect((screen.getByTestId("function-select") as HTMLSelectElement).value).toBe("messages:list");
    });

    test("surfaces a discovery error", async () => {
        const mock = createMockClient();

        mock.listFunctions.mockRejectedValueOnce(new Error("ADMIN_FORBIDDEN"));

        render(
            <CirrusProvider client={mock.asClient}>
                <FunctionRunner />
            </CirrusProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("function-discover-error").textContent).toBe("ADMIN_FORBIDDEN");
        });
    });
});
