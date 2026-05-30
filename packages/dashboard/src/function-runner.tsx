import type { FunctionReference } from "@cirrus/client";
import { useCirrus } from "@cirrus/react";
import { type ChangeEvent, type ReactElement, useCallback, useEffect, useMemo, useState } from "react";

import { errorMessage } from "./internal.js";
import type { FunctionDescriptor, RunStatus } from "./types.js";

export interface FunctionRunnerProps {
    /**
     * Functions to expose. When omitted, the runner auto-discovers them via the
     * client's `listFunctions()` (the admin-gated `/_cirrus/admin/functions`
     * endpoint), so it works with no wiring when the worker is built with a
     * `functions` registry. Supply the list to override discovery.
     */
    readonly functions?: FunctionDescriptor[];
}

const formatResult = (value: unknown): string => {
    if (value === undefined) {
        return "undefined";
    }

    return JSON.stringify(value, null, 2);
};

/**
 * Interactive runner for the registered functions: pick one, edit its JSON
 * arguments, optionally target a shard, then invoke it against the live
 * {@link useCirrus} client and inspect the result or error.
 *
 * By default the function list is auto-discovered from the worker's
 * `/_cirrus/admin/functions` endpoint; pass an explicit `functions` array to
 * skip discovery (a query/mutation/action's `kind` is compile-time-only, so it
 * must be named).
 */
export function FunctionRunner({ functions: functionsProp }: FunctionRunnerProps = {}): ReactElement {
    const client = useCirrus();

    const [discovered, setDiscovered] = useState<FunctionDescriptor[] | null>(null);
    const [discoverError, setDiscoverError] = useState<null | string>(null);

    // When the host supplies a list we use it verbatim; otherwise fall back to
    // whatever discovery has loaded so far (empty until the effect resolves).
    // Memoised so it stays referentially stable across renders — otherwise the
    // effects/memos below would re-run every render.
    const functions = useMemo(() => functionsProp ?? discovered ?? [], [functionsProp, discovered]);

    const [selectedPath, setSelectedPath] = useState<string>("");
    const [argsText, setArgsText] = useState<string>("{}");
    const [shardKey, setShardKey] = useState<string>("");
    const [status, setStatus] = useState<RunStatus>("idle");
    const [result, setResult] = useState<unknown>(undefined);
    const [error, setError] = useState<null | string>(null);

    useEffect(() => {
        // The host supplied the list — nothing to discover, no cleanup needed.
        if (functionsProp !== undefined) {
            return undefined;
        }

        let cancelled = false;

        void client
            .listFunctions()
            .then((list) => {
                if (!cancelled) {
                    setDiscovered(list);
                }

                return list;
            })
            .catch((error_: unknown) => {
                if (!cancelled) {
                    setDiscoverError(errorMessage(error_));
                }
            });

        return () => {
            cancelled = true;
        };
    }, [client, functionsProp]);

    // The selection defaults to the first function until the user picks one.
    // Derived (not synced via an effect) so there's no extra render and the
    // value is always consistent with the current list.
    const effectivePath = selectedPath === "" ? functions[0]?.path ?? "" : selectedPath;

    const selected = useMemo(() => functions.find((descriptor) => descriptor.path === effectivePath), [functions, effectivePath]);

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
            {discoverError !== null && (
                <p data-testid="function-discover-error" role="alert">
                    {discoverError}
                </p>
            )}

            <select
                aria-label="Function"
                data-testid="function-select"
                onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                    setSelectedPath(event.target.value);
                }}
                value={effectivePath}
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
