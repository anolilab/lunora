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
        expect.assertions(2);

        const mock = createMockClient();

        render(renderRunner(mock));

        const select = screen.getByTestId("function-select") as HTMLSelectElement;

        expect(select.value).toBe("messages:list");
        expect(screen.getAllByRole("option")).toHaveLength(3);
    });

    test("runs the selected query with parsed JSON args and renders the result", async () => {
        expect.assertions(6);

        const mock = createMockClient({ query: () => ({ rows: [1, 2] }) });

        render(renderRunner(mock));

        fireEvent.change(screen.getByTestId("args-input"), { target: { value: '{ "limit": 2 }' } });
        fireEvent.click(screen.getByTestId("run-button"));

        await screen.findByTestId("result");

        expect(mock.query).toHaveBeenCalledTimes(1);

        const [reference, args, options] = mock.query.mock.calls[0] as [{ __cirrusRef: string }, unknown, unknown];

        expect(reference.__cirrusRef).toBe("messages:list");
        expect(args).toEqual({ limit: 2 });
        expect(options).toEqual({});
        expect(screen.getByTestId("result").textContent).toBe(JSON.stringify({ rows: [1, 2] }, null, 2));
        expect(mock.mutation).not.toHaveBeenCalled();
    });

    test("routes to client.mutation when the selected function is a mutation", async () => {
        expect.assertions(2);

        const mock = createMockClient({ mutation: () => ({ ok: true }) });

        render(renderRunner(mock));

        fireEvent.change(screen.getByTestId("function-select"), { target: { value: "messages:send" } });
        fireEvent.click(screen.getByTestId("run-button"));

        await waitFor(() => {
            if (mock.mutation.mock.calls.length === 0) {
                throw new Error("mutation not called yet");
            }
        });

        const [reference] = mock.mutation.mock.calls[0] as [{ __cirrusRef: string }];

        expect(reference.__cirrusRef).toBe("messages:send");
        expect(mock.query).not.toHaveBeenCalled();
    });

    test("forwards a non-empty shard key in the call options", async () => {
        expect.assertions(1);

        const mock = createMockClient({ query: () => null });

        render(renderRunner(mock));

        fireEvent.change(screen.getByTestId("shard-input"), { target: { value: "room-1" } });
        fireEvent.click(screen.getByTestId("run-button"));

        await waitFor(() => {
            if (mock.query.mock.calls.length === 0) {
                throw new Error("query not called yet");
            }
        });

        const call = mock.query.mock.calls[0] as [unknown, unknown, { shardKey?: string }];

        expect(call[2]).toEqual({ shardKey: "room-1" });
    });

    test("reports invalid JSON without calling the client", () => {
        expect.assertions(2);

        const mock = createMockClient();

        render(renderRunner(mock));

        fireEvent.change(screen.getByTestId("args-input"), { target: { value: "{ not json" } });
        fireEvent.click(screen.getByTestId("run-button"));

        expect(screen.getByTestId("error").textContent).toContain("Invalid JSON args");
        expect(mock.query).not.toHaveBeenCalled();
    });

    test("surfaces a thrown server error in the error region", async () => {
        expect.assertions(2);

        const mock = createMockClient({
            query: () => {
                throw new Error("BOOM");
            },
        });

        render(renderRunner(mock));

        fireEvent.click(screen.getByTestId("run-button"));

        await screen.findByTestId("error");

        expect(screen.getByTestId("error").textContent).toBe("BOOM");
        expect(screen.queryByTestId("result")).toBeNull();
    });

    test("auto-discovers functions from the client when none are supplied", async () => {
        expect.assertions(2);

        const mock = createMockClient({ listFunctions: () => functions });

        render(
            <CirrusProvider client={mock.asClient}>
                <FunctionRunner />
            </CirrusProvider>,
        );

        await waitFor(() => {
            if (screen.queryAllByRole("option").length !== 3) {
                throw new Error("functions not discovered yet");
            }
        });

        expect(mock.listFunctions).toHaveBeenCalledWith();
        expect((screen.getByTestId("function-select") as HTMLSelectElement).value).toBe("messages:list");
    });

    test("surfaces a discovery error", async () => {
        expect.assertions(1);

        const mock = createMockClient();

        mock.listFunctions.mockRejectedValueOnce(new Error("ADMIN_FORBIDDEN"));

        render(
            <CirrusProvider client={mock.asClient}>
                <FunctionRunner />
            </CirrusProvider>,
        );

        const discoverError = await screen.findByTestId("function-discover-error");

        expect(discoverError.textContent).toBe("ADMIN_FORBIDDEN");
    });
});
