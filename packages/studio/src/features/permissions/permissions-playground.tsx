import { useLunora } from "@lunora/react";
import type { ChangeEvent, ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

import { ShardInput } from "../../components/shard-input";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
import { useT } from "../../i18n/i18n-context";
import { errorMessage, fireAndForget } from "../../lib/internal";
import type { FunctionDescriptor } from "../../lib/types";
import type { ProbeOutcome } from "./use-run-as-probe";
import useRunAsProbe from "./use-run-as-probe";

interface PermissionsPlaygroundProps {
    /**
     * Functions to expose. When omitted, the playground auto-discovers them via
     * the client's `listFunctions()` (the admin-gated functions endpoint), like
     * the function runner. Supply the list to override discovery.
     */
    readonly functions?: FunctionDescriptor[];

    /**
     * A `{ functionPath }` prefill seed, bumped by the matrix's "Probe this"
     * affordance so a fresh click re-selects even the same function. `nonce`
     * forces the effect to re-run on repeated clicks.
     */
    readonly prefill?: { functionPath: string; nonce: number };

    /**
     * Expose the run control. The probe forges a per-request identity over the
     * admin-gated `runAs` RPC, so the host MUST set this only on a trusted
     * loopback-dev gate (the same `runAsIdentity` gate as the function runner).
     * Off by default — the matrix stays visible, but the probe is disabled.
     */
    readonly runAsIdentity?: boolean;
}

const formatValue = (value: unknown): string => (value === undefined ? "undefined" : JSON.stringify(value, null, 2));

/**
 * The Permissions Playground — pick a registered function and an identity
 * (userId), then run it under that forged identity via the existing admin
 * `runAs` RPC and inspect the allow/deny outcome. It reuses the exact dispatch
 * the function runner uses (the shared {@link useRunAsProbe} hook), so a probe
 * is the truest possible test: the real function runs under RLS as that user.
 *
 * The run control is gated on {@link PermissionsPlaygroundProps.runAsIdentity}
 * (forging an identity is a loopback-only affordance); without it the panel
 * still renders but the run button is disabled.
 */
export const PermissionsPlayground = ({ functions: functionsProp, prefill, runAsIdentity = false }: PermissionsPlaygroundProps = {}): ReactElement => {
    const client = useLunora();
    const t = useT();
    const probe = useRunAsProbe();

    const [discovered, setDiscovered] = useState<FunctionDescriptor[] | null>(null);
    const [discoverError, setDiscoverError] = useState<null | string>(null);

    const functions = functionsProp ?? discovered ?? [];

    const [selectedPath, setSelectedPath] = useState<string>("");
    const [argsText, setArgsText] = useState<string>("{}");
    const [shardKey, setShardKey] = useState<string>("");
    const [runAsUserId, setRunAsUserId] = useState<string>("");
    const [running, setRunning] = useState<boolean>(false);
    const [outcome, setOutcome] = useState<ProbeOutcome | null>(null);
    const [argsError, setArgsError] = useState<null | string>(null);
    // The last prefill nonce applied, so a given matrix "Probe this" click seeds
    // the form at most once even though `prefill` stays referentially set.
    const appliedNonce = useRef<number>(-1);

    useEffect(() => {
        if (functionsProp !== undefined) {
            return undefined;
        }

        let cancelled = false;

        client
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

    // A matrix "Probe this" click seeds the selected function; the bumped nonce
    // makes a repeat click on the same target re-apply. Ref-guarded + deferred via
    // a microtask so the setStates don't run synchronously in the effect (the
    // codebase's URL→selection-sync pattern, see `global-data-browser`).
    useEffect(() => {
        /* eslint-disable react-you-might-not-need-an-effect/no-event-handler -- prop → selection sync: a parent "Probe this" click seeds the function (a value bumped by nonce, applied at most once); there is no user event in this component to hook into. */
        if (prefill === undefined || appliedNonce.current === prefill.nonce) {
            return;
        }

        appliedNonce.current = prefill.nonce;
        const target = prefill.functionPath;

        queueMicrotask(() => {
            setSelectedPath(target);
            setOutcome(null);
        });
        /* eslint-enable react-you-might-not-need-an-effect/no-event-handler */
    }, [prefill]);

    const effectivePath = selectedPath === "" ? (functions[0]?.path ?? "") : selectedPath;

    const run = async (): Promise<void> => {
        if (effectivePath === "") {
            return;
        }

        let parsedArgs: Record<string, unknown>;

        try {
            parsedArgs = argsText.trim() === "" ? {} : (JSON.parse(argsText) as Record<string, unknown>);
        } catch (parseError) {
            setArgsError(t("Invalid JSON args: {message}", { message: (parseError as Error).message }));
            setOutcome(null);

            return;
        }

        setArgsError(null);
        setRunning(true);

        // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower `try` without `catch`; the `finally` must still clear the busy flag on the throw path, and adding a catch just to satisfy the compiler would swallow the error
        try {
            const result = await probe({ args: parsedArgs, functionPath: effectivePath, shardKey: shardKey.trim(), userId: runAsUserId.trim() });

            setOutcome(result);
        } finally {
            setRunning(false);
        }
    };

    const runOnce = (): void => {
        fireAndForget(run());
    };

    const onSelectChange = (event: ChangeEvent<HTMLSelectElement>): void => {
        setSelectedPath(event.target.value);
    };

    const onArgsChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
        setArgsText(event.target.value);
    };

    const onUserIdChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setRunAsUserId(event.target.value);
    };

    return (
        <div className="flex flex-col gap-3" data-testid="lunora-permissions-playground">
            {discoverError !== null && (
                <p className="text-sm text-destructive" data-testid="pp-discover-error" role="alert">
                    {discoverError}
                </p>
            )}

            {!runAsIdentity && (
                <EmptyState
                    description={t("Dev only: runs the selected function as this user over the admin gate so you can test auth and RLS.")}
                    testId="pp-gate"
                    title={t("Set `runAsIdentity` to forge an identity and probe access.")}
                />
            )}

            <div className="flex flex-col gap-3 rounded-md border border-border p-3">
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="pp-function">{t("Function")}</Label>
                    <select
                        aria-label={t("Function")}
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        data-testid="pp-function"
                        id="pp-function"
                        onChange={onSelectChange}
                        value={effectivePath}
                    >
                        {functions.map((descriptor) => (
                            <option key={descriptor.path} value={descriptor.path}>
                                {descriptor.path} ({descriptor.kind})
                            </option>
                        ))}
                    </select>
                </div>

                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="pp-args">{t("Arguments")}</Label>
                    <Textarea
                        aria-label={t("Arguments")}
                        className="font-mono text-xs"
                        data-testid="pp-args"
                        id="pp-args"
                        onChange={onArgsChange}
                        value={argsText}
                    />
                </div>

                <ShardInput onChange={setShardKey} testId="pp-shard" value={shardKey} />

                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="pp-user">{t("Run as (userId)")}</Label>
                    <Input
                        aria-label={t("Identity (userId) to run as")}
                        className="font-mono text-xs"
                        data-testid="pp-user"
                        id="pp-user"
                        onChange={onUserIdChange}
                        placeholder={t("Required — the identity to probe as")}
                        value={runAsUserId}
                    />
                </div>

                <div className="flex items-center gap-2">
                    <Button data-testid="pp-run" disabled={!runAsIdentity || running || effectivePath === ""} onClick={runOnce} type="button">
                        {running ? t("Probing…") : t("Run probe")}
                    </Button>
                    {runAsUserId.trim() !== "" && (
                        <Badge data-testid="pp-as-badge" variant="secondary">
                            {t("as {userId}", { userId: runAsUserId.trim() })}
                        </Badge>
                    )}
                </div>
            </div>

            {argsError !== null && (
                <p className="text-sm text-destructive" data-testid="pp-args-error" role="alert">
                    {argsError}
                </p>
            )}

            {outcome !== null && outcome.kind === "allowed" && (
                <div className="flex flex-col gap-2" data-testid="pp-outcome-allowed">
                    <Badge variant="secondary">{t("Allowed")}</Badge>
                    <pre className="overflow-auto rounded-md border border-border bg-muted/50 p-3 font-mono text-xs" data-testid="pp-result">
                        {formatValue(outcome.value)}
                    </pre>
                </div>
            )}

            {outcome !== null && outcome.kind === "invalid" && (
                <div className="flex flex-col gap-2" data-testid="pp-outcome-invalid">
                    <Badge variant="outline">{t("Not run")}</Badge>
                    <p className="text-sm text-muted-foreground" data-testid="pp-invalid" role="status">
                        {outcome.message}
                    </p>
                </div>
            )}

            {outcome !== null && outcome.kind === "denied" && (
                <div className="flex flex-col gap-2" data-testid="pp-outcome-denied">
                    <Badge variant="destructive">{t("Denied")}</Badge>
                    <pre
                        className="overflow-auto rounded-md border border-border bg-muted/50 p-3 font-mono text-xs text-destructive"
                        data-testid="pp-denied"
                        role="alert"
                    >
                        {outcome.message}
                    </pre>
                </div>
            )}
        </div>
    );
};

export type { PermissionsPlaygroundProps };
