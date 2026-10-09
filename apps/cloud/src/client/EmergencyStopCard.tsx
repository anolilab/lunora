import { useMutation, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";

import { api } from "../../lunora/_generated/api.js";
import { ColumnHeader } from "./ColumnHeader";
import type { HaltStatusView } from "./halt";
import { confirmsHalt, describeHaltReason, emergencyStopActions, HALT_CONFIRMATION, HALT_STATE, haltOnSuspensionCopy } from "./halt";
import { Field, FormError, RelativeTime, StatusBadge } from "./section-ui";
import type { OrgId } from "./types";

const errorMessage = (error: unknown, fallback: string): string => (error instanceof Error ? error.message : fallback);

/** Every halted project, its progress and why it is stopped. */
const HaltTable = ({ halts }: { halts: HaltStatusView["halts"] }): ReactElement => (
    <Table>
        <ColumnHeader labels={["Project", "State", "Why", "Since"]} />
        <TableBody>
            {halts.map((halt) => (
                <TableRow key={halt.alias}>
                    <TableCell className="font-mono text-xs">
                        {halt.alias} <span className="text-muted-foreground">({halt.kind})</span>
                    </TableCell>
                    <TableCell>
                        <span className="flex flex-col gap-1">
                            <StatusBadge tone={HALT_STATE[halt.state].tone}>{HALT_STATE[halt.state].label}</StatusBadge>
                            {halt.lastError === undefined ? null : <span className="text-destructive text-xs">Retrying: {halt.lastError}</span>}
                        </span>
                    </TableCell>
                    <TableCell className="text-sm">{describeHaltReason(halt)}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                        <RelativeTime at={halt.haltedAt ?? halt.requestedAt} />
                    </TableCell>
                </TableRow>
            ))}
        </TableBody>
    </Table>
);

/** Stop every project, behind a typed confirmation. */
const StopControl = ({ disabled, organizationId }: { disabled: boolean; organizationId: OrgId }): ReactElement => {
    const halt = useMutation(api.halts.haltOrganization);
    const [typed, setTyped] = useState("");
    const [error, setError] = useState<null | string>(null);

    const submit = (): void => {
        setError(null);
        void (async () => {
            try {
                await halt.mutate({ organizationId });
                setTyped("");
            } catch (error_: unknown) {
                setError(errorMessage(error_, "could not stop the projects"));
            }
        })();
    };

    return (
        <div className="grid gap-3">
            <Field htmlFor="emergency-stop-confirm" label={`Type ${HALT_CONFIRMATION} to stop every project in this organization`}>
                <Input
                    autoComplete="off"
                    className="max-w-xs font-mono"
                    disabled={disabled}
                    id="emergency-stop-confirm"
                    onChange={(event) => {
                        setTyped(event.target.value);
                    }}
                    placeholder={HALT_CONFIRMATION}
                    value={typed}
                />
            </Field>
            <FormError message={error} />
            <Button
                className="justify-self-start"
                disabled={disabled || !confirmsHalt(typed) || halt.pending}
                onClick={submit}
                type="button"
                variant="destructive"
            >
                {halt.pending ? "Stopping…" : "Stop all projects"}
            </Button>
        </div>
    );
};

/** Resume every stopped project, or say why that waits for the suspension. */
const ResumeControl = ({
    blocked,
    canResume,
    organizationId,
}: {
    blocked: string | undefined;
    canResume: boolean;
    organizationId: OrgId;
}): ReactElement | null => {
    const resume = useMutation(api.halts.resumeOrganization);
    const [error, setError] = useState<null | string>(null);

    if (blocked !== undefined) {
        return <p className="text-muted-foreground text-sm">{blocked}</p>;
    }

    if (!canResume) {
        return null;
    }

    return (
        <div className="grid gap-2">
            <FormError message={error} />
            <Button
                className="justify-self-start"
                disabled={resume.pending}
                onClick={() => {
                    setError(null);
                    void resume.mutate({ organizationId }).catch((error_: unknown) => {
                        setError(errorMessage(error_, "could not resume the projects"));
                    });
                }}
                type="button"
                variant="outline"
            >
                {resume.pending ? "Resuming…" : "Resume all projects"}
            </Button>
        </div>
    );
};

/** The `haltOnSuspension` setting (owners). */
const SuspensionSetting = ({ enabled, organizationId }: { enabled: boolean; organizationId: OrgId }): ReactElement => {
    const save = useMutation(api.halts.setHaltOnSuspension);
    const [error, setError] = useState<null | string>(null);

    return (
        <div className="grid gap-2 border-t pt-4">
            <span className="text-sm font-medium">Stop projects on suspension</span>
            <p className="text-muted-foreground text-sm">{haltOnSuspensionCopy(enabled)}</p>
            <FormError message={error} />
            <Button
                className="justify-self-start"
                disabled={save.pending}
                onClick={() => {
                    setError(null);
                    void save.mutate({ enabled: !enabled, organizationId }).catch((error_: unknown) => {
                        setError(errorMessage(error_, "could not change the setting"));
                    });
                }}
                type="button"
                variant="outline"
            >
                {enabled ? "Turn off" : "Turn on"}
            </Button>
        </div>
    );
};

/**
 * Emergency stop: stop every project of the organization — their code, not
 * just their traffic — keeping all their data, and resume them. Also where the
 * "stop projects on suspension" setting lives, since it is the same switch
 * pulled automatically.
 */
export const EmergencyStopCard = ({ organizationId }: { organizationId: OrgId }): ReactElement => {
    const status = useQuery(api.halts.status, { organizationId });
    const actions = status ? emergencyStopActions(status) : undefined;

    return (
        <Card className="border-destructive/40">
            <CardHeader>
                <CardTitle>Emergency stop</CardTitle>
                <CardDescription>
                    Stops every project&apos;s code — requests, crons, queue consumers and Durable Object alarms — within a minute or two, without deleting any
                    data. Deploys and rollbacks are refused until you resume.
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
                {status === undefined ? <p className="text-muted-foreground text-sm">Loading…</p> : null}
                {status && status.halts.length > 0 ? <HaltTable halts={status.halts} /> : null}
                {status && status.unsupported.length > 0 ? (
                    <p className="text-muted-foreground text-sm">
                        Not covered: {status.unsupported.map((entry) => `${entry.alias} (${entry.reason})`).join("; ")}.
                    </p>
                ) : null}
                {status && actions ? (
                    <>
                        <StopControl disabled={!actions.canHalt} organizationId={organizationId} />
                        <ResumeControl blocked={actions.resumeBlocked} canResume={actions.canResume} organizationId={organizationId} />
                        <SuspensionSetting enabled={status.haltOnSuspension} organizationId={organizationId} />
                    </>
                ) : null}
            </CardContent>
        </Card>
    );
};
