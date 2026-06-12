import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { FunctionRunner } from "../src/function-runner";
import type { FunctionDescriptor } from "../src/index";
import type { MockClientHooks } from "./mock-client";
import { createMockClient } from "./mock-client";

const functions: FunctionDescriptor[] = [
    { kind: "query", path: "messages:list" },
    { kind: "mutation", path: "messages:send" },
    { kind: "action", path: "stripe:sync" },
];

// Hoisted to module scope so the `functions` JSX prop isn't a fresh array each render.
const FUNCTIONS_WITH_ARGS: FunctionDescriptor[] = [
    {
        args: [
            { kind: "id", name: "channelId", optional: false, table: "channels" },
            { kind: "string", name: "text", optional: false },
            { kind: "number", name: "limit", optional: true },
        ],
        kind: "mutation",
        path: "messages:send",
    },
];

const renderRunner = (mock: MockClientHooks): ReactElement => (
    <CirrusProvider client={mock.asClient}>
        <FunctionRunner functions={functions} />
    </CirrusProvider>
);

describe("functionRunner", () => {
    it("defaults to the first function and lists all of them", () => {
        expect.assertions(2);

        const mock = createMockClient();

        render(renderRunner(mock));

        const select = screen.getByTestId<HTMLSelectElement>("function-select");

        expect(select.value).toBe("messages:list");
        expect(screen.getAllByRole("option")).toHaveLength(3);
    });

    it("shows the selected function's signature and prefills a required-args template", () => {
        expect.assertions(3);

        render(
            <CirrusProvider client={createMockClient().asClient}>
                <FunctionRunner functions={FUNCTIONS_WITH_ARGS} />
            </CirrusProvider>,
        );

        expect(screen.getByTestId("function-signature").textContent).toBe("(channelId: id<channels>, text: string, limit?: number)");

        fireEvent.click(screen.getByTestId("prefill-button"));

        // Prefill drops the optional `limit` and seeds placeholders by kind.
        const argsInput = screen.getByTestId<HTMLTextAreaElement>("args-input");

        expect(JSON.parse(argsInput.value)).toStrictEqual({ channelId: "", text: "" });
        expect(argsInput.value).not.toContain("limit");
    });

    it("runs the selected query with parsed JSON args and renders the result", async () => {
        expect.assertions(6);

        const mock = createMockClient({
            query: () => {
                return { rows: [1, 2] };
            },
        });

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

    it("routes to client.mutation when the selected function is a mutation", async () => {
        expect.assertions(2);

        const mock = createMockClient({
            mutation: () => {
                return { ok: true };
            },
        });

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

    it("forwards a non-empty shard key in the call options", async () => {
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

    it("reports invalid JSON without calling the client", () => {
        expect.assertions(2);

        const mock = createMockClient();

        render(renderRunner(mock));

        fireEvent.change(screen.getByTestId("args-input"), { target: { value: "{ not json" } });
        fireEvent.click(screen.getByTestId("run-button"));

        expect(screen.getByTestId("error").textContent).toContain("Invalid JSON args");
        expect(mock.query).not.toHaveBeenCalled();
    });

    it("surfaces a thrown server error in the error region", async () => {
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

    it("auto-discovers functions from the client when none are supplied", async () => {
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
        expect(screen.getByTestId<HTMLSelectElement>("function-select").value).toBe("messages:list");
    });

    it("surfaces a discovery error", async () => {
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

    it("hides the history list until a run has happened", () => {
        expect.assertions(1);

        const mock = createMockClient();

        render(renderRunner(mock));

        expect(screen.queryByTestId("fn-history")).toBeNull();
    });

    it("appends a history entry after a successful run", async () => {
        expect.assertions(3);

        const mock = createMockClient({
            query: () => {
                return { rows: [1] };
            },
        });

        render(renderRunner(mock));

        fireEvent.click(screen.getByTestId("run-button"));

        await screen.findByTestId("fn-history");

        const rows = screen.getAllByTestId("fn-history-row");

        expect(rows).toHaveLength(1);
        expect(rows[0]?.textContent).toContain("messages:list (query)");
        expect(screen.getByTestId("fn-history-status-0").textContent).toBe("✓");
    });

    it("marks a failed run with an error indicator in history", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            query: () => {
                throw new Error("BOOM");
            },
        });

        render(renderRunner(mock));

        fireEvent.click(screen.getByTestId("run-button"));

        const indicator = await screen.findByTestId("fn-history-status-0");

        expect(indicator.textContent).toBe("✗");
    });

    it("prepends newest runs and caps the history at ten entries", async () => {
        expect.assertions(2);

        const mock = createMockClient({
            mutation: () => {
                return { ok: true };
            },
            query: () => null,
        });

        render(renderRunner(mock));

        // Eleven runs total: ten queries then one mutation, so the newest entry
        // is the mutation and the oldest query has been dropped. The run button
        // disables while a run is in flight, so each run is awaited (via the
        // growing history) before the next click.
        for (let index = 0; index < 10; index += 1) {
            fireEvent.click(screen.getByTestId("run-button"));

            // eslint-disable-next-line no-await-in-loop -- each run must complete before the next click (the run button disables while in-flight)
            await waitFor(() => {
                if (screen.getAllByTestId("fn-history-row").length !== index + 1) {
                    throw new Error("query run not recorded yet");
                }
            });
        }

        fireEvent.change(screen.getByTestId("function-select"), { target: { value: "messages:send" } });
        fireEvent.click(screen.getByTestId("run-button"));

        await screen.findByText("messages:send (mutation)");

        const rows = screen.getAllByTestId("fn-history-row");

        expect(rows).toHaveLength(10);
        expect(rows[0]?.textContent).toContain("messages:send (mutation)");
    });

    it("loading a history entry restores its path, args and shard key", async () => {
        expect.assertions(4);

        const mock = createMockClient({
            mutation: () => {
                return { ok: true };
            },
            query: () => null,
        });

        render(renderRunner(mock));

        // Record a mutation run with custom args + shard, then switch the form
        // away so the load has something to restore.
        fireEvent.change(screen.getByTestId("function-select"), { target: { value: "messages:send" } });
        fireEvent.change(screen.getByTestId("args-input"), { target: { value: '{ "body": "hi" }' } });
        fireEvent.change(screen.getByTestId("shard-input"), { target: { value: "room-7" } });
        fireEvent.click(screen.getByTestId("run-button"));

        await screen.findByTestId("fn-history");

        fireEvent.change(screen.getByTestId("function-select"), { target: { value: "messages:list" } });
        fireEvent.change(screen.getByTestId("args-input"), { target: { value: "{}" } });
        fireEvent.change(screen.getByTestId("shard-input"), { target: { value: "" } });

        fireEvent.click(screen.getByTestId("fn-history-load-0"));

        expect(screen.getByTestId<HTMLSelectElement>("function-select").value).toBe("messages:send");
        expect(screen.getByTestId<HTMLTextAreaElement>("args-input").value).toBe('{ "body": "hi" }');
        expect(screen.getByTestId<HTMLInputElement>("shard-input").value).toBe("room-7");
        expect(screen.getByTestId("fn-history-status-0").textContent).toBe("✓");
    });
});

const ADMIN_RUN_AS = "__cirrus_admin__:runAs";

describe("functionRunner run-as identity", () => {
    it("hides the run-as control by default (off / not dev-gated)", () => {
        expect.assertions(1);

        render(renderRunner(createMockClient()));

        // The dev gate is off, so no identity control is rendered.
        expect(screen.queryByTestId("run-as-field")).toBeNull();
    });

    it("shows the run-as control only when the dev gate is enabled", () => {
        expect.assertions(1);

        render(
            <CirrusProvider client={createMockClient().asClient}>
                <FunctionRunner functions={functions} runAsIdentity />
            </CirrusProvider>,
        );

        // `getByTestId` throws when the element is absent, so reaching the
        // assertion already proves the control rendered.
        expect(screen.getByTestId("run-as-input").getAttribute("placeholder")).toBe("Leave empty to run as admin");
    });

    it("runs with the caller's own identity when the userId is left empty", async () => {
        expect.assertions(2);

        const mock = createMockClient({
            query: () => {
                return { ok: true };
            },
        });

        render(
            <CirrusProvider client={mock.asClient}>
                <FunctionRunner functions={functions} runAsIdentity />
            </CirrusProvider>,
        );

        // Gate on, but no userId entered → the normal query path runs, never runAs.
        fireEvent.click(screen.getByTestId("run-button"));

        await screen.findByTestId("result");

        const [reference] = mock.query.mock.calls[0] as [{ __cirrusRef: string }];

        expect(reference.__cirrusRef).toBe("messages:list");
        expect(mock.query.mock.calls.every(([ref]) => (ref as { __cirrusRef: string }).__cirrusRef !== ADMIN_RUN_AS)).toBe(true);
    });

    it("forwards the chosen identity through the runAs admin RPC", async () => {
        expect.assertions(4);

        const mock = createMockClient({
            query: () => {
                return { ran: "as-user" };
            },
        });

        render(
            <CirrusProvider client={mock.asClient}>
                <FunctionRunner functions={functions} runAsIdentity />
            </CirrusProvider>,
        );

        fireEvent.change(screen.getByTestId("args-input"), { target: { value: '{ "limit": 5 }' } });
        fireEvent.change(screen.getByTestId("run-as-input"), { target: { value: "user_42" } });
        fireEvent.click(screen.getByTestId("run-button"));

        await screen.findByTestId("result");

        const [reference, args] = mock.query.mock.calls[0] as [{ __cirrusRef: string }, { args: unknown; functionPath: string; userId: string }];

        // The call is routed through the admin runAs RPC, carrying the target
        // function path, its args, and the forged userId.
        expect(reference.__cirrusRef).toBe(ADMIN_RUN_AS);
        expect(args.functionPath).toBe("messages:list");
        expect(args.userId).toBe("user_42");
        expect(args.args).toEqual({ limit: 5 });
    });
});
