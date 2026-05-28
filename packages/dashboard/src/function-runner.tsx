import type { FunctionReference } from "@cirrus/client";
import { useCirrus } from "@cirrus/react";
import { type ChangeEvent, type ReactElement, useCallback, useMemo, useState } from "react";

import type { FunctionDescriptor, RunStatus } from "./types.js";

export interface FunctionRunnerProps {
    readonly functions: FunctionDescriptor[];
}

const formatResult = (value: unknown): string => {
    if (value === undefined) {
        return "undefined";
    }

    return JSON.stringify(value, null, 2);
};

/**
 * Interactive runner for a fixed set of registered functions: pick one, edit
 * its JSON arguments, optionally target a shard, then invoke it against the
 * live {@link useCirrus} client and inspect the result or error.
 *
 * Backend-agnostic — the host supplies the {@link FunctionDescriptor} list
 * (a query/mutation/action's `kind` is compile-time-only, so it must be named
 * here) and the component drives the existing client transport. No admin RPC
 * is required.
 */
export function FunctionRunner({ functions }: FunctionRunnerProps): ReactElement {
    const client = useCirrus();

    const [selectedPath, setSelectedPath] = useState<string>(() => functions[0]?.path ?? "");
    const [argsText, setArgsText] = useState<string>("{}");
    const [shardKey, setShardKey] = useState<string>("");
    const [status, setStatus] = useState<RunStatus>("idle");
    const [result, setResult] = useState<unknown>(undefined);
    const [error, setError] = useState<null | string>(null);

    const selected = useMemo(() => functions.find((descriptor) => descriptor.path === selectedPath), [functions, selectedPath]);

    const run = useCallback(async (): Promise<void> => {
        if (!selected) {
            return;
        }

        let parsedArgs: unknown;

        try {
            parsedArgs = argsText.trim() === "" ? {} : JSON.parse(argsText);
        } catch (parseError) {
            setStatus("error");
            setResult(undefined);
            setError(`Invalid JSON args: ${(parseError as Error).message}`);

            return;
        }

        const reference: FunctionReference = { __cirrusRef: selected.path };
        const options = shardKey.trim() === "" ? {} : { shardKey: shardKey.trim() };

        setStatus("running");
        setError(null);

        try {
            let value: unknown;

            switch (selected.kind) {
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

            setResult(value);
            setStatus("success");
        } catch (runError) {
            setResult(undefined);
            setError((runError as Error).message);
            setStatus("error");
        }
    }, [argsText, client, selected, shardKey]);

    return (
        <div data-testid="cirrus-function-runner">
            <select
                aria-label="Function"
                data-testid="function-select"
                onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                    setSelectedPath(event.target.value);
                }}
                value={selectedPath}
            >
                {functions.map((descriptor) => (
                    <option key={descriptor.path} value={descriptor.path}>
                        {descriptor.path} ({descriptor.kind})
                    </option>
                ))}
            </select>

            <textarea
                aria-label="Arguments"
                data-testid="args-input"
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
                    setArgsText(event.target.value);
                }}
                value={argsText}
            />

            <input
                aria-label="Shard key"
                data-testid="shard-input"
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    setShardKey(event.target.value);
                }}
                placeholder="shard key (optional)"
                value={shardKey}
            />

            <button
                data-testid="run-button"
                disabled={status === "running" || selected === undefined}
                onClick={() => {
                    void run();
                }}
                type="button"
            >
                Run
            </button>

            {status === "error" && error !== null && (
                <pre data-testid="error" role="alert">
                    {error}
                </pre>
            )}

            {status === "success" && <pre data-testid="result">{formatResult(result)}</pre>}
        </div>
    );
}
