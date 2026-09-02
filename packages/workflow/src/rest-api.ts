/**
 * Read/observe client over the Cloudflare **Workflows REST API**.
 *
 * The Worker `Workflow` binding can only `create`/`get` an instance and read a
 * single instance's status — it exposes no instance list and no per-step detail.
 * The full execution state (every instance, every step with its timing, output,
 * and error) lives in Cloudflare's control plane and is reachable only over the
 * account-scoped REST API: `GET .../workflows/{name}/instances` lists them,
 * `GET .../instances/{id}` returns one with its step array, and
 * `PATCH .../instances/{id}/status` pauses, resumes, or terminates it.
 *
 * Auth mirrors the `@lunora/bindings/analytics` SQL-API client: a Cloudflare account id
 * plus an API token (scoped `Workflows: Read`, or `Edit` for the status PATCH),
 * both sourced from env / `.dev.vars` and sent as a bearer token. The token is a
 * secret — it stays server-side and is never shipped to the browser (the studio
 * reaches this only through the admin-gated runtime proxy).
 *
 * Node-safe (structural types plus an injectable `fetch`) so it unit-tests
 * without the network.
 */
import { LunoraError } from "@lunora/errors";

import type { WorkflowInstanceStatus } from "./types";

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";

/**
 * How much of the upstream body may be spliced into the error MESSAGE.
 *
 * `WORKFLOWS_REST_ERROR` is a catalogued, non-internal code, so `toErrorBody`
 * echoes its `message` verbatim to whoever called the action — an uncapped body
 * puts the Cloudflare API's auth/authorization error text or a multi-KB HTML
 * gateway page on the wire to a browser. The full body is kept on `cause`, which
 * `toErrorBody` never serialises, so a server-side log still has all of it.
 */
const MAX_ERROR_BODY_CHARS = 256;

/** Trim `body` to {@link MAX_ERROR_BODY_CHARS}, marking that it was cut. */
const capErrorBody = (body: string): string => (body.length > MAX_ERROR_BODY_CHARS ? `${body.slice(0, MAX_ERROR_BODY_CHARS)}… (truncated)` : body);

/**
 * The Cloudflare instance statuses as an exhaustive lookup. The `satisfies`
 * assertion against the status union makes adding a member to the union without
 * listing it here a **compile error**, so the set can never silently drift from
 * {@link WorkflowInstanceStatus}.
 */
const KNOWN_STATUSES = {
    complete: true,
    errored: true,
    paused: true,
    queued: true,
    running: true,
    terminated: true,
    unknown: true,
    waiting: true,
    waitingForPause: true,
} satisfies Record<WorkflowInstanceStatus, true>;

/** Coerce an arbitrary value into the {@link WorkflowInstanceStatus} union, defaulting to `"unknown"`. */
const toStatus = (value: unknown): WorkflowInstanceStatus =>
    typeof value === "string" && Object.hasOwn(KNOWN_STATUSES, value) ? (value as WorkflowInstanceStatus) : "unknown";

const asString = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** Read a value as a string, falling back to `""` (avoids `[object Object]` from `String(unknown)`). */
const stringOr = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback);

/** Read a boolean value, or `undefined` when absent/non-boolean. */
const asBoolean = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);

/** Derive a 1-based attempt count from Cloudflare's `attempts` (an array of tries, or already a number). */
const countAttempts = (value: unknown): number | undefined => {
    if (Array.isArray(value)) {
        return value.length;
    }

    return typeof value === "number" ? value : undefined;
};

/** Normalize a Cloudflare instance object (snake_case REST shape) into a {@link WorkflowInstanceSummary}. */
const toSummary = (raw: Record<string, unknown>): WorkflowInstanceSummary => {
    return {
        createdOn: asString(raw["created_on"]),
        endedOn: asString(raw["ended_on"]),
        id: stringOr(raw["id"], ""),
        startedOn: asString(raw["started_on"]),
        status: toStatus(raw["status"]),
    };
};

/** Normalize one Cloudflare `steps[]` entry into a {@link WorkflowStepDetail}. */
const toStep = (raw: Record<string, unknown>): WorkflowStepDetail => {
    return {
        attempts: countAttempts(raw["attempts"]),
        end: asString(raw["end"]),
        error: raw["error"],
        name: stringOr(raw["name"], ""),
        output: raw["output"],
        start: asString(raw["start"]),
        success: asBoolean(raw["success"]),
        type: asString(raw["type"]),
    };
};

/** The lifecycle mutations the REST API exposes via `PATCH .../instances/{id}`. */
export type WorkflowInstanceAction = "pause" | "resume" | "terminate";

/** Configuration for a {@link WorkflowsRestClient}. */
export interface WorkflowsRestConfig {
    /** Cloudflare account id that owns the workflow. */
    accountId: string;
    /** API token with `Workflows: Read` (and `Edit` for status mutation). A secret — never a binding. */
    apiToken: string;
    /** `fetch` implementation. Defaults to the global `fetch`; injected in tests so the path never touches the network. */
    fetch?: typeof globalThis.fetch;
}

/** One row of the instance list — the summary the studio table renders. */
export interface WorkflowInstanceSummary {
    createdOn?: string;
    endedOn?: string;
    id: string;
    startedOn?: string;
    status: WorkflowInstanceStatus;
}

/** One durable step of an instance, normalized from the REST `steps[]` array. */
export interface WorkflowStepDetail {
    /** 1-based attempt count (`> 1` means the step retried). */
    attempts?: number;
    end?: string;
    error?: unknown;
    name: string;
    output?: unknown;
    start?: string;
    success?: boolean;
    /** `step` / `sleep` / `waitForEvent` / … (Cloudflare's step `type`). */
    type?: string;
}

/** A single instance's full detail: its summary plus params/output/error and the step timeline. */
export interface WorkflowInstanceDetail extends WorkflowInstanceSummary {
    error?: unknown;
    output?: unknown;
    params?: unknown;
    steps: WorkflowStepDetail[];
}

/** A page of instances plus the cursor info Cloudflare returns in `result_info`. */
export interface WorkflowInstancePage {
    instances: WorkflowInstanceSummary[];
    page: number;
    perPage: number;
    totalCount?: number;
}

/** Thrown when the REST API responds non-2xx or `success: false`; carries the status plus a capped body preview, with the full body on `cause`. */
export class WorkflowsRestError extends LunoraError {
    public constructor(status: number, body: string) {
        super("WORKFLOWS_REST_ERROR", `Cloudflare Workflows REST API returned ${String(status)}: ${capErrorBody(body)}`, {
            cause: body,
            name: "WorkflowsRestError",
            status,
        });
    }
}

/** The observe client: list instances, read one instance's steps, and (with Edit scope) mutate its status. */
export interface WorkflowsRestClient {
    getInstance: (args: { instanceId: string; workflowName: string }) => Promise<WorkflowInstanceDetail>;
    listInstances: (args: { page?: number; perPage?: number; status?: WorkflowInstanceStatus; workflowName: string }) => Promise<WorkflowInstancePage>;
    setInstanceStatus: (args: { action: WorkflowInstanceAction; instanceId: string; workflowName: string }) => Promise<{ status: WorkflowInstanceStatus }>;
}

/**
 * Build a {@link WorkflowsRestClient}. Each call hits the account-scoped REST
 * endpoint with the bearer token, unwraps Cloudflare's
 * `{ success, errors, result, result_info }` envelope, and normalizes the
 * snake_case payload into the camelCase shapes the studio renders.
 */
export const createWorkflowsRestClient = (config: WorkflowsRestConfig): WorkflowsRestClient => {
    // Bind the global `fetch` to `globalThis` so calling it through this captured
    // reference cannot trip "Illegal invocation" in receiver-strict runtimes
    // (where `fetch` must run with the global as its `this`). An injected
    // `config.fetch` is used as-is — the caller owns its binding.
    const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
    const base = `${API_BASE}/${config.accountId}/workflows`;

    const request = async (path: string, init?: RequestInit): Promise<Record<string, unknown>> => {
        const response = await fetchImpl(`${base}${path}`, {
            ...init,
            headers: { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json" },
        });

        const text = await response.text();
        // Cloudflare always wraps in `{ success, errors, result, ... }`; a non-2xx
        // OR `success: false` is a failure. Parse defensively — an HTML error page
        // from a gateway 5xx is not JSON.
        let body: Record<string, unknown>;

        try {
            body = JSON.parse(text) as Record<string, unknown>;
        } catch {
            throw new WorkflowsRestError(response.status, text);
        }

        if (!response.ok || body["success"] === false) {
            throw new WorkflowsRestError(response.status, text);
        }

        return body;
    };

    return {
        getInstance: async ({ instanceId, workflowName }) => {
            const body = await request(`/${encodeURIComponent(workflowName)}/instances/${encodeURIComponent(instanceId)}`);
            const result = (body["result"] ?? {}) as Record<string, unknown>;
            const steps = Array.isArray(result["steps"]) ? (result["steps"] as Record<string, unknown>[]) : [];

            return {
                ...toSummary(result),
                error: result["error"],
                output: result["output"],
                params: result["params"],
                steps: steps.map((step) => toStep(step)),
            };
        },
        listInstances: async ({ page, perPage, status, workflowName }) => {
            const query = new URLSearchParams();

            if (status !== undefined) {
                query.set("status", status);
            }

            if (page !== undefined) {
                query.set("page", String(page));
            }

            if (perPage !== undefined) {
                query.set("per_page", String(perPage));
            }

            const suffix = query.toString() === "" ? "" : `?${query.toString()}`;
            const body = await request(`/${encodeURIComponent(workflowName)}/instances${suffix}`);
            const result = Array.isArray(body["result"]) ? (body["result"] as Record<string, unknown>[]) : [];
            const info = (body["result_info"] ?? {}) as Record<string, unknown>;

            return {
                instances: result.map((instance) => toSummary(instance)),
                page: typeof info["page"] === "number" ? info["page"] : (page ?? 1),
                perPage: typeof info["per_page"] === "number" ? info["per_page"] : (perPage ?? result.length),
                totalCount: typeof info["total_count"] === "number" ? info["total_count"] : undefined,
            };
        },
        setInstanceStatus: async ({ action, instanceId, workflowName }) => {
            // The lifecycle action lives on the instance's `/status` SUB-resource,
            // not on the instance itself — Cloudflare's API reference:
            // PATCH /accounts/{account_id}/workflows/{workflow_name}/instances/{instance_id}/status
            // (https://developers.cloudflare.com/api/resources/workflows/subresources/instances/subresources/status/methods/edit/).
            // The instance path has no PATCH handler, so pausing/resuming/terminating
            // from the studio reached an endpoint that could never act on it.
            const body = await request(`/${encodeURIComponent(workflowName)}/instances/${encodeURIComponent(instanceId)}/status`, {
                body: JSON.stringify({ status: action }),
                method: "PATCH",
            });
            const result = (body["result"] ?? {}) as Record<string, unknown>;

            return { status: toStatus(result["status"]) };
        },
    };
};
