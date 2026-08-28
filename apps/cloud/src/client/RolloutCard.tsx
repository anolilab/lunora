import { useMutation } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { api } from "../../lunora/_generated/api.js";
import { COLUMN_LABEL } from "./section-styles";
import { FormError, StatusBadge } from "./section-ui";
import type { OrgId, ProjectId } from "./types";

/**
 * Staged rollout control for a project.
 *
 * Blue/green promotes a release all at once. A rollout serves the candidate to a
 * share of traffic first, so a regression is found by a fraction of users rather
 * than everyone — the Traffic tab's per-deployment error rate is what the shares
 * below are meant to be watched against.
 *
 * The split is deterministic and monotonic: raising the percentage only adds
 * clients, so advancing never moves anyone back to the old build.
 */

/** The steps offered. Deliberately coarse — a canary is a judgement call, not a dial. */
const STEPS = [5, 10, 25, 50, 75] as const;

export const RolloutCard = ({
    candidateScriptName,
    candidateId,
    organizationId,
    percent,
    projectId,
}: {
    /** The deployment being rolled out, when one is selected in the table. */
    candidateId?: string;
    /** Script name of the release currently taking a share, when a rollout is live. */
    candidateScriptName?: string;
    organizationId: OrgId;
    /** Current share, when a rollout is in progress. */
    percent?: number;
    projectId: ProjectId;
}): ReactElement | null => {
    const setRollout = useMutation(api.deployments.setRollout);
    const promote = useMutation(api.deployments.promoteRollout);
    const abort = useMutation(api.deployments.abortRollout);
    const [error, setError] = useState<null | string>(null);

    const active = candidateScriptName !== undefined && percent !== undefined;

    // Nothing to offer: no rollout running and no candidate selected to start one.
    if (!active && candidateId === undefined) {
        return null;
    }

    const run = (action: () => Promise<unknown>): void => {
        setError(null);

        void (async () => {
            try {
                await action();
            } catch (error_: unknown) {
                setError(error_ instanceof Error ? error_.message : "could not update the rollout");
            }
        })();
    };

    const pending = setRollout.pending || promote.pending || abort.pending;

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    Staged rollout
                    {active ? <StatusBadge tone="warning">{percent}% live</StatusBadge> : <StatusBadge tone="neutral">off</StatusBadge>}
                </CardTitle>
                <CardDescription>
                    {active
                        ? `${candidateScriptName} is serving ${String(percent)}% of traffic. Watch its error rate on the Traffic tab, then promote or abort.`
                        : "Serve the selected release to a share of traffic before it takes over. Raising the share never moves anyone back."}
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                {active ? (
                    <div aria-label={`${String(percent)} percent of traffic on the candidate`} className="bg-muted h-1.5 w-full overflow-hidden" role="img">
                        <div className="bg-foreground h-full" style={{ width: `${String(percent)}%` }} />
                    </div>
                ) : null}

                <div className="flex flex-col gap-2">
                    <span className={`${COLUMN_LABEL} text-muted-foreground`}>{active ? "Change share" : "Start at"}</span>
                    <div className="flex flex-wrap gap-2">
                        {STEPS.map((step) => (
                            <Button
                                disabled={pending || candidateId === undefined || step === percent}
                                key={step}
                                onClick={() => {
                                    if (candidateId !== undefined) {
                                        run(() => setRollout.mutate({ id: candidateId as never, organizationId, percent: step }));
                                    }
                                }}
                                size="sm"
                                variant={step === percent ? "default" : "outline"}
                            >
                                {step}%
                            </Button>
                        ))}
                    </div>
                </div>

                <FormError message={error} />

                {active ? (
                    <div className="flex flex-wrap gap-2">
                        <Button
                            disabled={pending}
                            onClick={() => {
                                run(() => promote.mutate({ organizationId, projectId }));
                            }}
                        >
                            {promote.pending ? "Promoting…" : "Promote to 100%"}
                        </Button>
                        <Button
                            className="text-destructive hover:text-destructive"
                            disabled={pending}
                            onClick={() => {
                                run(() => abort.mutate({ organizationId, projectId }));
                            }}
                            variant="ghost"
                        >
                            Abort
                        </Button>
                    </div>
                ) : null}

                <p className="text-muted-foreground text-xs">
                    Traffic is split by client, so one caller stays on one version instead of flipping between builds. Aborting returns every request to the
                    active release and leaves the candidate deployed.
                </p>
            </CardContent>
        </Card>
    );
};
