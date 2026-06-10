import { useCirrus } from "@cirrus/react";
import type { ReactElement, ReactNode } from "react";
import { createContext, use, useCallback, useMemo, useState } from "react";

import { useT } from "../i18n-context";
import { adminRef, callOptions, errorMessage, fireAndForget } from "../internal";
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
 * Read the current operation's live run state. Must be used inside an
 * {@link OperationRunProvider} (the reference view wraps the centre + right rail
 * in one, so the request console and the response panel share a single run).
 */
const useOperationRun = (): OperationRun => {
    const value = use(OperationRunContext);

    if (value === null) {
        throw new Error("useOperationRun must be used within an OperationRunProvider");
    }

    return value;
};

interface OperationRunProviderProps {
    readonly children: ReactNode;
    readonly operation: ApiOperation;
}

/**
 * Owns the live "try it" state for one operation and shares it with both the
 * request console (centre) and the response panel (right rail). Cirrus RPC
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
    const client = useCirrus();

    const [argsText, setArgsText] = useState<string>(() => seedArgs(operation));
    const [shardKey, setShardKey] = useState<string>("");
    const [status, setStatus] = useState<RunStatus>("idle");
    const [response, setResponse] = useState<unknown>(undefined);
    const [error, setError] = useState<null | string>(null);
    const [durationMs, setDurationMs] = useState<null | number>(null);

    const send = useCallback(async (): Promise<void> => {
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
            let value: unknown;

            if (operation.functionPath === undefined) {
                // Plain REST route: best-effort fetch of the path with a JSON body.
                const hasBody = operation.method !== "GET" && operation.method !== "HEAD";
                const fetchResponse = await fetch(operation.httpPath, {
                    body: hasBody ? JSON.stringify(parsedArgs) : undefined,
                    headers: hasBody ? { "content-type": "application/json" } : undefined,
                    method: operation.method,
                });

                value = await fetchResponse.json().catch(() => fetchResponse.text());
            } else {
                const reference = adminRef(operation.functionPath);
                const options = callOptions(shardKey);

                switch (operation.kind) {
                    case "action": {
                        value = await client.action(reference, parsedArgs, options);

                        break;
                    }
                    case "mutation": {
                        value = await client.mutation(reference, parsedArgs, options);

                        break;
                    }
                    default: {
                        value = await client.query(reference, parsedArgs, options);
                    }
                }
            }

            setResponse(value);
            setDurationMs(Math.round(performance.now() - startedAt));
            setStatus("success");
        } catch (runError) {
            setResponse(undefined);
            setDurationMs(Math.round(performance.now() - startedAt));
            setError(errorMessage(runError));
            setStatus("error");
        }
    }, [argsText, client, operation, shardKey, t]);

    const onSend = useCallback((): void => {
        fireAndForget(send());
    }, [send]);

    const value = useMemo<OperationRun>(() => {
        return { argsText, durationMs, error, operation, response, send: onSend, setArgsText, setShardKey, shardKey, status };
    }, [argsText, durationMs, error, operation, response, onSend, shardKey, status]);

    return <OperationRunContext value={value}>{children}</OperationRunContext>;
};

export { OperationRunProvider, useOperationRun };
