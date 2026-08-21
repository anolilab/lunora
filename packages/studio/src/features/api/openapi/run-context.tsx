import { LunoraError } from "@lunora/errors";
import { useLunora } from "@lunora/react";
import type { ReactElement, ReactNode } from "react";
import { createContext, use, useState } from "react";

import { useT } from "../../../i18n/i18n-context";
import { adminRef, callOptions, dispatchByKind, errorMessage, fireAndForget } from "../../../lib/internal";
import type { ApiOperation } from "./openapi-model";
import { exampleForSchema } from "./schema-view";

/** Terminal/transient states of a single try-it invocation. */
type RunStatus = "error" | "idle" | "running" | "success";

/** Seed the args editor from the operation's argument schema (empty object when none). */
const seedArgs = (operation: ApiOperation): string => JSON.stringify(exampleForSchema(operation.argsSchema) ?? {}, undefined, 2);

/** The shared run state for one operation, consumed by the request controls and the response panel. */
interface OperationRun {
    argsText: string;
    durationMs: null | number;
    error: null | string;
    operation: ApiOperation;
    response: unknown;
    send: () => void;
    setArgsText: (value: string) => void;
    setShardKey: (value: string) => void;
    shardKey: string;
    status: RunStatus;
}

const OperationRunContext = createContext<null | OperationRun>(null);

/**
 * Dispatch a plain REST route (an `httpRouter()` operation, no `functionPath`)
 * to the worker origin with the admin bearer. A same-origin fetch would be
 * answered by the studio's own server — under `lunora dev` the SPA fallback
 * returns the studio document as a 200 for any non-`/_lunora/*` path — so the
 * request must target the worker explicitly. When `origin` is empty the path
 * is fetched same-origin as before. Exported for tests.
 */
const restDispatch = async (operation: ApiOperation, parsedArgs: unknown, origin: string, adminToken: null | string): Promise<unknown> => {
    const hasBody = operation.method !== "GET" && operation.method !== "HEAD";
    const url = origin === "" ? operation.httpPath : new URL(operation.httpPath, origin).toString();

    const fetchResponse = await fetch(url, {
        body: hasBody ? JSON.stringify(parsedArgs) : undefined,
        headers: {
            ...(hasBody ? { "content-type": "application/json" } : {}),
            ...(adminToken === null || adminToken === "" ? {} : { authorization: `Bearer ${adminToken}` }),
        },
        method: operation.method,
    });

    // Read the body once, then parse — a Response stream can't be read
    // twice, so `.json().catch(() => .text())` would throw on a non-JSON body.
    const text = await fetchResponse.text();

    try {
        return JSON.parse(text) as unknown;
    } catch {
        return text;
    }
};

/**
 * Read the current operation's live run state. Must be used inside an
 * {@link OperationRunProvider} (the reference view wraps the centre + right rail
 * in one, so the request console and the response panel share a single run).
 */
const useOperationRun = (): OperationRun => {
    const value = use(OperationRunContext);

    if (value === null) {
        throw new LunoraError("INTERNAL", "useOperationRun must be used within an OperationRunProvider");
    }

    return value;
};

interface OperationRunProviderProps {
    readonly children: ReactNode;
    readonly operation: ApiOperation;
}

/**
 * Owns the live "try it" state for one operation and shares it with both the
 * request console (centre) and the response panel (right rail). Lunora RPC
 * operations dispatch through the kind-appropriate client method
 * (`query` / `mutation` / `action`) by `functionPath`; a plain REST route falls
 * back to a `fetch` of its path. The provider is keyed on the operation by its
 * consumer, so switching operations remounts it with a freshly-seeded editor and
 * a cleared result — no reset effect.
 *
 * This replaces Scalar's embedded "API Client" modal: no portal, no overlay,
 * just in-panel state, so it can never intercept clicks or freeze the studio.
 */
const OperationRunProvider = ({ children, operation }: OperationRunProviderProps): ReactElement => {
    const t = useT();
    const client = useLunora();

    const [argsText, setArgsText] = useState<string>(() => seedArgs(operation));
    const [shardKey, setShardKey] = useState<string>("");
    const [status, setStatus] = useState<RunStatus>("idle");
    const [response, setResponse] = useState<unknown>(undefined);
    const [error, setError] = useState<null | string>(null);
    const [durationMs, setDurationMs] = useState<null | number>(null);

    const send = async (): Promise<void> => {
        let parsedArgs: unknown;

        try {
            parsedArgs = argsText.trim() === "" ? {} : JSON.parse(argsText);
        } catch (parseError) {
            setStatus("error");
            setResponse(undefined);
            setDurationMs(null);
            setError(t("Invalid JSON args: {message}", { message: errorMessage(parseError) }));

            return;
        }

        setStatus("running");
        setError(null);
        const startedAt = performance.now();

        try {
            const value: unknown = await (operation.functionPath === undefined
                ? restDispatch(operation, parsedArgs, client.url, client.getAuthToken())
                : dispatchByKind(client, operation.kind, adminRef(operation.functionPath), parsedArgs, callOptions(shardKey)));

            setResponse(value);
            setDurationMs(Math.round(performance.now() - startedAt));
            setStatus("success");
        } catch (runError) {
            setResponse(undefined);
            setDurationMs(Math.round(performance.now() - startedAt));
            setError(errorMessage(runError));
            setStatus("error");
        }
    };

    const onSend = (): void => {
        fireAndForget(send());
    };

    const value = { argsText, durationMs, error, operation, response, send: onSend, setArgsText, setShardKey, shardKey, status };

    return <OperationRunContext value={value}>{children}</OperationRunContext>;
};

export { OperationRunProvider, restDispatch, useOperationRun };
