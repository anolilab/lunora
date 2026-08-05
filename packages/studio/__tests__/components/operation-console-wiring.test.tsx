import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import ErrorAlert from "../../src/components/error-alert";
import { OperationConsoleProvider, useOperationConsole } from "../../src/components/operation-console-provider";
import OperationConsole from "../../src/features/logs/operation-console";
import { operationLog } from "../../src/lib/operation-log";
import { withOperationRecording } from "../../src/lib/recording-client";

/** Mounts the drawer exactly as `StudioLayout` does, so a click has somewhere to land. */
const Shell = ({ error }: { readonly error: unknown }): ReactElement => {
    const operationConsole = useOperationConsole();

    return (
        <>
            <ErrorAlert error={error} testId="alert" />
            {operationConsole?.open === true && (
                <OperationConsole
                    focusSeq={operationConsole.focusSeq}
                    onClose={operationConsole.close}
                    onShownChange={operationConsole.setShown}
                    shown={operationConsole.shown}
                />
            )}
        </>
    );
};

/**
 * A client stub wrapped by the REAL recording proxy, so these tests exercise the
 * same seam production uses rather than a hand-rolled stand-in.
 */
const recordingClient = (behaviour: {
    fail?: string;
    result?: unknown;
}): { mutation: (reference: unknown, args: unknown, options?: unknown) => Promise<unknown> } =>
    withOperationRecording({
        mutation: () => (behaviour.fail === undefined ? Promise.resolve(behaviour.result) : Promise.reject(new Error(behaviour.fail))),
        query: () => (behaviour.fail === undefined ? Promise.resolve(behaviour.result) : Promise.reject(new Error(behaviour.fail))),
    } as never) as never;

/** Drive a failing admin write through the recording client and hand back the rejection. */
const failingCall = async (message: string): Promise<unknown> => {
    try {
        await recordingClient({ fail: message }).mutation({ __lunoraRef: "__lunora_admin__:writeRow" }, { table: "users" }, {});
    } catch (error: unknown) {
        return error;
    }

    throw new Error("expected the call to reject");
};

describe("operation console wiring", () => {
    beforeEach(() => {
        // The tape is a module singleton shared by every test in this worker.
        operationLog.clear();
    });

    it("turns a failed call's alert into the exact tape entry that produced it", async () => {
        expect.assertions(3);

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

        // A healthy read that must NOT be listed when the console opens from an error.
        await recordingClient({ result: [{ name: "users" }] }).mutation({ __lunoraRef: "__lunora_admin__:listTables" }, {}, {});

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

    it("offers no console affordance when no console is mounted", () => {
        expect.assertions(2);

        // ErrorAlert is mounted standalone by other suites and by hosts embedding
        // a single panel. It must render — and must NOT show a control that
        // cannot work.
        render(<ErrorAlert error={new Error("standalone")} testId="alert" />);

        expect(screen.getByTestId("alert")).toBeDefined();
        expect(screen.queryByTestId("error-show-in-console")).toBeNull();
    });

    it("applies the errors filter even when the drawer is ALREADY open", async () => {
        expect.assertions(2);

        await recordingClient({ result: [] }).mutation({ __lunoraRef: "__lunora_admin__:listTables" }, {}, {});

        const error = await failingCall("denied");

        render(
            <OperationConsoleProvider>
                <Shell error={error} />
            </OperationConsoleProvider>,
        );

        // Open it wide first, the way ⌘/Ctrl+` does…
        fireEvent.click(screen.getByTestId("error-show-in-console"));
        fireEvent.click(screen.getByTestId("oc-filter-errors"));

        expect(screen.getAllByTestId("oc-row").length).toBeGreaterThan(1);

        // …then ask for the error view again from the alert. With the filter
        // seeded into the drawer's own state this silently did nothing, because
        // an already-open drawer never remounts.
        fireEvent.click(screen.getByTestId("error-show-in-console"));

        expect(screen.getAllByTestId("oc-row")).toHaveLength(1);
    });
});
