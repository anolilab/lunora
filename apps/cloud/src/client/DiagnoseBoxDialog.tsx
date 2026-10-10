import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import type { DiagnoseReport } from "../boxes/diagnose";
import type { BoxView } from "./boxes";
import { describeDiagnose, formatDiagnoseOutput } from "./boxes";
import { CopyButton, FormError } from "./section-ui";
import type { OrgId } from "./types";

/** Deadline for the diagnose route: the box gets 60 s, plus the round trip. */
const REQUEST_TIMEOUT_MS = 75_000;

/** Run `diagnose` on a box through `POST /v1/boxes/diagnose` — the edge holds the box's session; a mutation cannot reach it. */
const requestDiagnose = async (id: string, organizationId: OrgId): Promise<DiagnoseReport> => {
    // react-doctor-disable-next-line react-doctor/no-fetch-response-used-without-status-check -- `response.ok` IS checked, just after the body is read: reading first is what lets the server's own error message surface instead of a bare status code.
    const response = await fetch("/v1/boxes/diagnose", {
        body: JSON.stringify({ id, organizationId }),
        credentials: "include",
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // A refusal answers `{ error: string }`; a diagnose that ran answers a report, failed or not.
    const payload = (await response.json().catch(() => null)) as null | { error?: unknown; output?: unknown };

    if (!response.ok || !Array.isArray(payload?.output)) {
        throw new Error(typeof payload?.error === "string" ? payload.error : `diagnose failed (${String(response.status)})`);
    }

    return payload as DiagnoseReport;
};

interface DiagnoseBoxDialogProps {
    box: BoxView | null;
    onClose: () => void;
    organizationId: OrgId;
}

/**
 * Run `celld diagnose` (and whatever else `lunora-hostd` collects) on a box and
 * show what it printed. Each run is a job on the customer's machine, so it runs
 * on a click, never on open. Open while `box` is set; the parent remounts it per
 * box, so one box's output never shows under another's name.
 */
export const DiagnoseBoxDialog = ({ box, onClose, organizationId }: DiagnoseBoxDialogProps): ReactElement => {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<null | string>(null);
    const [report, setReport] = useState<DiagnoseReport | null>(null);
    const output = report === null ? "" : formatDiagnoseOutput(report.output);
    let runLabel = "Run diagnose";

    if (pending) {
        runLabel = "Diagnosing…";
    } else if (report) {
        runLabel = "Run again";
    }

    return (
        <Dialog
            onOpenChange={(next) => {
                if (!next) {
                    onClose();
                }
            }}
            open={box !== null}
        >
            <DialogContent className="sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>Diagnose {box?.name ?? "box"}</DialogTitle>
                    <DialogDescription>
                        Runs celld&apos;s diagnostics on the box through its agent and shows the result: fleets, listeners, storage and what failed. It reads
                        the machine&apos;s state; it changes nothing.
                    </DialogDescription>
                </DialogHeader>
                {report ? (
                    <div className="grid gap-3">
                        <p className={`m-0 text-sm ${report.ok ? "" : "text-warning"}`} role="status">
                            {describeDiagnose(report)}
                        </p>
                        {output === "" ? null : (
                            <>
                                <pre className="m-0 max-h-[50vh] overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
                                    <code>{output}</code>
                                </pre>
                                <CopyButton label="Copy output" value={output} />
                            </>
                        )}
                    </div>
                ) : null}
                <FormError message={error} />
                <DialogFooter>
                    <Button onClick={onClose} type="button" variant="ghost">
                        Close
                    </Button>
                    <Button
                        disabled={pending || box === null}
                        onClick={() => {
                            if (box === null) {
                                return;
                            }

                            setError(null);
                            setPending(true);

                            void (async () => {
                                try {
                                    const next = await requestDiagnose(box._id, organizationId);

                                    setReport(next);
                                    setPending(false);
                                } catch (error_: unknown) {
                                    setPending(false);
                                    setError(error_ instanceof Error ? error_.message : "diagnose failed");
                                }
                            })();
                        }}
                        type="button"
                    >
                        {runLabel}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
