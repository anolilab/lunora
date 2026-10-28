import type { DeploymentPauseStatus } from "@lunora/client";
import type { ReactElement } from "react";
import { useState } from "react";

import { useClientQuery } from "../hooks/use-admin-query";
import { useAutoRefresh } from "../hooks/use-auto-refresh";
import useStudioClient from "../hooks/use-studio-client";
import { useT } from "../i18n/i18n-context";
import { errorMessage, fireAndForget, formatTimestamp } from "../lib/internal";
import { ConfirmButton } from "./confirm-button";
import { Input } from "./ui/input";

/** One cache entry for the banner and the toggle, so flipping one re-renders both. */
const PAUSE_QUERY_KEY = ["lunora-deployment-pause"] as const;

const usePauseState = (): { refetch: () => void; state: DeploymentPauseStatus | undefined } => {
    const client = useStudioClient();
    // A worker older than the pause route answers 404: read that as "cannot pause", not an error banner.
    const query = useClientQuery(PAUSE_QUERY_KEY, async () =>
        client.getDeploymentPause().catch((): DeploymentPauseStatus => {
            return { paused: false, supported: false };
        }),
    );

    useAutoRefresh(() => query.poll(), true);

    return {
        refetch: () => {
            query.refetch();
        },
        state: query.data,
    };
};

/**
 * Shown across the top of Studio while the deployment is paused, on every page,
 * so nobody debugs a wall of 503s without seeing why. Carries the way out.
 */
export const DeploymentPauseBanner = (): ReactElement | null => {
    const client = useStudioClient();
    const t = useT();
    const { refetch, state } = usePauseState();
    const [error, setError] = useState<string | undefined>(undefined);

    if (state?.paused !== true) {
        return null;
    }

    const resume = async (): Promise<void> => {
        try {
            await client.setDeploymentPause(false);
            setError(undefined);
            refetch();
        } catch (error_) {
            setError(errorMessage(error_));
        }
    };

    return (
        <div
            className="flex shrink-0 items-center gap-3 border-b border-destructive/30 bg-destructive/10 px-6 py-2 text-[12px] text-foreground"
            data-testid="deployment-paused-banner"
            role="alert"
        >
            <strong>{t("Deployment paused")}</strong>
            {state.pausedAt !== undefined && <span className="text-muted-foreground tabular-nums">{formatTimestamp(state.pausedAt, "")}</span>}
            {state.reason !== undefined && <span data-testid="deployment-paused-reason">{state.reason}</span>}
            <span className="text-muted-foreground">
                {t("Function calls get 503, scheduled jobs are held, cron ticks are skipped and queue batches are retried later.")}
            </span>
            {error !== undefined && <span className="text-destructive">{error}</span>}
            <span className="ml-auto">
                <ConfirmButton
                    confirmLabel={t("Resume deployment?")}
                    onConfirm={() => {
                        fireAndForget(resume());
                    }}
                    testId="deployment-resume"
                >
                    {t("Resume")}
                </ConfirmButton>
            </span>
        </div>
    );
};

/** The pause switch, for the Schedule tab. Hidden on a worker that cannot pause. */
export const DeploymentPauseToggle = (): ReactElement | null => {
    const client = useStudioClient();
    const t = useT();
    const { refetch, state } = usePauseState();
    const [reason, setReason] = useState("");
    const [error, setError] = useState<string | undefined>(undefined);

    if (state?.supported !== true) {
        return null;
    }

    const set = async (paused: boolean): Promise<void> => {
        try {
            await client.setDeploymentPause(paused, paused && reason !== "" ? reason : undefined);
            setError(undefined);
            refetch();
        } catch (error_) {
            setError(errorMessage(error_));
        }
    };

    return (
        <div className="flex items-center gap-2" data-testid="deployment-pause-toggle">
            <span className="text-sm text-muted-foreground" data-testid="deployment-pause-state">
                {state.paused ? t("Deployment paused") : t("Deployment running")}
            </span>
            {!state.paused && (
                <Input
                    aria-label={t("Reason (optional)")}
                    className="h-8 w-56"
                    data-testid="deployment-pause-reason"
                    onChange={(event) => {
                        setReason(event.target.value);
                    }}
                    placeholder={t("Reason (optional)")}
                    value={reason}
                />
            )}
            <ConfirmButton
                confirmLabel={state.paused ? t("Resume deployment?") : t("Pause deployment?")}
                onConfirm={() => {
                    fireAndForget(set(!state.paused));
                }}
                testId={state.paused ? "deployment-toggle-resume" : "deployment-toggle-pause"}
            >
                {state.paused ? t("Resume") : t("Pause")}
            </ConfirmButton>
            {error !== undefined && (
                <span className="text-xs text-destructive" role="alert">
                    {error}
                </span>
            )}
        </div>
    );
};
