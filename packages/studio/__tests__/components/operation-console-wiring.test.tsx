import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { ErrorAlert } from "../../src/components/error-alert";
import { OperationConsoleProvider, useOperationConsole } from "../../src/components/operation-console-provider";
import { OperationConsole } from "../../src/features/logs/operation-console";
import { recordedCall } from "../../src/lib/internal";
import { operationLog } from "../../src/lib/operation-log";

/** Mounts the drawer exactly as `StudioLayout` does, so a click has somewhere to land. */
const Shell = ({ error }: { readonly error: unknown }): ReactElement => {
    const { close, errorsOnly, focusSeq, open } = useOperationConsole();

    return (
        <>
            <ErrorAlert error={error} testId="alert" />
            {open && <OperationConsole errorsOnly={errorsOnly} focusSeq={focusSeq} onClose={close} />}
        </>
    );
};

/** Drive a failing admin call through the real recorder and hand back the rejection. */
const failingCall = async (message: string): Promise<unknown> => {
    try {
        await recordedCall("__lunora_admin__:writeRow", { table: "users" }, "", () => Promise.reject(new Error(message)));
    } catch (error: unknown) {
        return error;
    }

    throw new Error("expected the call to reject");
};

describe("operation console wiring", () => {
    it("turns a failed call's alert into the exact tape entry that produced it", async () => {
        expect.assertions(3);

        operationLog.clear();

        const error = await failingCall("row is locked");

        render(
            <OperationConsoleProvider>
                <Shell error={error} />
            </OperationConsoleProvider>,
        );

        // The console is closed until the operator asks for it.
        expect(screen.queryByTestId("lunora-operation-console")).toBeNull();

        fireEvent.click(screen.getByTestId("error-show-in-console"));

        expect(screen.getByTestId("lunora-operation-console")).toBeDefined();
        // Opened on the failure itself — the summary carries the table, and the
        // message is the one the call rejected with.
        expect(screen.getByTestId("oc-error").textContent).toBe("row is locked");
    });

    it("opens filtered to errors, so a busy tape does not bury the failure", async () => {
        expect.assertions(2);

        operationLog.clear();

        // A healthy read that must NOT be listed when the console opens from an error.
        await recordedCall("__lunora_admin__:listTables", {}, "", () => Promise.resolve([{ name: "users" }]));

        const error = await failingCall("denied");

        render(
            <OperationConsoleProvider>
                <Shell error={error} />
            </OperationConsoleProvider>,
        );

        fireEvent.click(screen.getByTestId("error-show-in-console"));

        const rows = screen.getAllByTestId("oc-row");

        expect(rows).toHaveLength(1);
        expect(rows[0]?.textContent).toContain("writeRow");
    });

    it("renders inertly with no provider, so an error surface never throws", () => {
        expect.assertions(2);

        // ErrorAlert is mounted in isolation by other suites; a debugging
        // affordance must never be the reason an error component crashes.
        render(<ErrorAlert error={new Error("standalone")} testId="alert" />);

        expect(screen.getByTestId("alert")).toBeDefined();

        fireEvent.click(screen.getByTestId("error-show-in-console"));

        expect(screen.queryByTestId("lunora-operation-console")).toBeNull();
    });
});
