import type { FunctionReference } from "@lunora/client";
import { act, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import useSubscription from "../src/use-subscription";
import { createMockClient } from "./mock-client";

const REF: FunctionReference<"query", { id: string }, string> = { __lunoraRef: "docs:get" };

const View = ({ id }: { id: string }): ReactElement => {
    const { data, error } = useSubscription(REF, { id });

    return <div data-testid="view">{`${id}=>${data ?? "loading"}|err=${error?.message ?? "-"}`}</div>;
};

const isDocument =
    (id: string) =>
    (args: unknown): boolean =>
        (args as { id: string }).id === id;

describe("useSubscription — args change", () => {
    it("does not show the previous args' data under the new args", async () => {
        expect.hasAssertions();

        const mock = createMockClient();
        const view = render(
            <LunoraProvider client={mock.asClient}>
                <View id="1" />
            </LunoraProvider>,
        );

        act(() => {
            mock.emit("docs:get", "doc-1", isDocument("1"));
        });

        expect(screen.getByTestId("view").textContent).toBe("1=>doc-1|err=-");

        view.rerender(
            <LunoraProvider client={mock.asClient}>
                <View id="2" />
            </LunoraProvider>,
        );

        expect(screen.getByTestId("view").textContent).toBe("2=>loading|err=-");

        act(() => {
            mock.emit("docs:get", "doc-2", isDocument("2"));
        });

        expect(screen.getByTestId("view").textContent).toBe("2=>doc-2|err=-");
    });

    it("does not show the previous args' error under the new args", async () => {
        expect.hasAssertions();

        const mock = createMockClient();
        const view = render(
            <LunoraProvider client={mock.asClient}>
                <View id="1" />
            </LunoraProvider>,
        );

        await act(async () => {
            mock.emitError("docs:get", { code: "FORBIDDEN", message: "denied for 1" }, isDocument("1"));
            await Promise.resolve();
        });

        expect(screen.getByTestId("view").textContent).toBe("1=>loading|err=denied for 1");

        view.rerender(
            <LunoraProvider client={mock.asClient}>
                <View id="2" />
            </LunoraProvider>,
        );

        expect(screen.getByTestId("view").textContent).toBe("2=>loading|err=-");
    });
});
