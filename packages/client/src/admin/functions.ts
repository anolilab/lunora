import { ARCHITECTURE_PATH, CRON_JOBS_PATH, CRON_JOBS_RUN_PATH, FUNCTIONS_PATH, OPENAPI_PATH, OPENRPC_PATH } from "../client-paths";
import type { LunoraClient } from "../lunora-client";
import type { CronJobInfo, FunctionDescriptor } from "../types";
import type { AdminHost } from "./host";

export const listFunctions = async (host: AdminHost): ReturnType<LunoraClient["listFunctions"]> => {
    host.assertOpen();

    const body = (await host.adminFetch(FUNCTIONS_PATH, "GET")) as { functions?: FunctionDescriptor[] };

    return body.functions ?? [];
};

export const getCronJobs = async (host: AdminHost): ReturnType<LunoraClient["getCronJobs"]> => {
    host.assertOpen();

    const body = (await host.adminFetch(CRON_JOBS_PATH, "GET")) as { jobs?: CronJobInfo[] };

    return body.jobs ?? [];
};

export const runCronJob = async (host: AdminHost, name: Parameters<LunoraClient["runCronJob"]>[0]): ReturnType<LunoraClient["runCronJob"]> => {
    host.assertOpen();

    const body = (await host.adminFetch(CRON_JOBS_RUN_PATH, "POST", { name })) as { name?: string; ran?: boolean };

    return { name: body.name ?? name, ran: body.ran === true };
};

export const fetchOpenApi = async (host: AdminHost): ReturnType<LunoraClient["fetchOpenApi"]> => {
    host.assertOpen();

    return (await host.adminFetch(OPENAPI_PATH, "GET")) as Record<string, unknown>;
};

export const fetchArchitecture = async (host: AdminHost): ReturnType<LunoraClient["fetchArchitecture"]> => {
    host.assertOpen();

    return (await host.adminFetch(ARCHITECTURE_PATH, "GET")) as Record<string, unknown>;
};

export const fetchOpenRpc = async (host: AdminHost): ReturnType<LunoraClient["fetchOpenRpc"]> => {
    host.assertOpen();

    return (await host.adminFetch(OPENRPC_PATH, "GET")) as Record<string, unknown>;
};
