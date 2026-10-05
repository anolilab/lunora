/**
 * The live deployments the cron fan-out and the platform queue consumer act on,
 * read off the control-plane D1 (admin tokens stay sealed here; each caller
 * unseals the one it uses, in-process).
 */
import type { D1DatabaseLike } from "@lunora/d1";

import { controlPlaneDatabase } from "../d1-store";

export interface LiveDeploymentRow {
    adminToken?: string;
    adminTokenCiphertext?: string;
    adminTokenIv?: string;
    alias?: string;
    cronSpecs?: string[];
    liveAt?: number;
    resourceRef?: string;
    scriptName: string;
    target?: string;
}

/** Read the live deployments; none without the control-plane D1. */
export const readLiveDeployments = async (environment: { DB?: unknown }): Promise<LiveDeploymentRow[]> => {
    if (!environment.DB) {
        return [];
    }

    const { page } = await controlPlaneDatabase(environment.DB as D1DatabaseLike).findMany("deployments", { where: { status: "live" } });

    return page as LiveDeploymentRow[];
};

/** The handle a target addresses a deployment by: `resourceRef`, or the script name on rows that predate it. */
export const resourceRefOf = (row: { resourceRef?: null | string; scriptName: string }): string => row.resourceRef ?? row.scriptName;
