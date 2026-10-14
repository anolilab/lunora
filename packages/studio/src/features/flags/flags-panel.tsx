import type { ReactElement } from "react";
import { useState } from "react";

import ErrorAlert from "../../components/error-alert";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Label } from "../../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Textarea } from "../../components/ui/textarea";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useT } from "../../i18n/i18n-context";
import type { FlagEvaluation, FlagsResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";

interface FlagsPanelProps {
    /** Shard the live evaluation targets. Empty string → the root shard. */
    readonly initialShardKey?: string;
}

/** A parse error from the targeting-context editor — one of the catalogued, translatable messages. */
type ContextError = "Targeting context is not valid JSON." | "Targeting context must be a JSON object.";

/** Parse the targeting-context editor's text into a plain object, or `undefined` when blank/invalid. */
const parseContext = (raw: string): { context: Record<string, unknown> | undefined; error: ContextError | null } => {
    const trimmed = raw.trim();

    if (trimmed.length === 0) {
        return { context: undefined, error: null };
    }

    try {
        const parsed = JSON.parse(trimmed) as unknown;

        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return { context: undefined, error: "Targeting context must be a JSON object." };
        }

        return { context: parsed as Record<string, unknown>, error: null };
    } catch {
        return { context: undefined, error: "Targeting context is not valid JSON." };
    }
};

/** Example targeting context shown in the editor. Hoisted so the JSX attribute isn't a flagged inline string literal. */
const CONTEXT_PLACEHOLDER = '{ "targetingKey": "user-123", "plan": "premium" }';

/** Render a flag's resolved value as a compact, monospace string. */
const formatValue = (evaluation: FlagEvaluation): string => {
    if (evaluation.type === "object") {
        return JSON.stringify(evaluation.value);
    }

    return String(evaluation.value);
};

/**
 * The Flags inspector — lists the deployment's statically-discovered feature
 * flags (`ctx.flags.<type>("key")` reads) and their live evaluation under an
 * editable targeting context. Flags evaluate through whatever OpenFeature
 * provider the app wired in `lunora/flags.ts`; the studio renders read-only
 * inspection (the source of truth — e.g. Cloudflare Flagship — owns editing).
 * The values stream over the live admin subscription, so editing the targeting
 * context (or a provider-side change) re-evaluates without a manual refresh.
 */
const FlagsPanel = ({ initialShardKey = "" }: FlagsPanelProps): ReactElement => {
    const t = useT();

    const [contextText, setContextText] = useState("");
    const { context, error: contextError } = parseContext(contextText);

    // Only the successfully-parsed context is part of the query key, so an
    // in-progress / malformed edit keeps the last good evaluation on screen.
    //
    // Not memoized: `useAdminQuery` hashes the key deeply (TanStack) and keys its
    // subscription effect on a JSON signature, so a fresh object per render costs
    // nothing — and the manual memo here was the one thing stopping React Compiler
    // from optimizing this component at all.
    const args = context === undefined ? {} : { context };

    const { data, error, errorSource, liveError } = useAdminQuery<FlagsResult>(ADMIN_FUNCTIONS.listFlags, args, { live: true, shardKey: initialShardKey });

    const loaded = data !== undefined;
    const configured = data?.configured ?? false;
    const flags = Array.isArray(data?.flags) ? [...data.flags].toSorted((a, b) => a.key.localeCompare(b.key)) : [];

    let body: ReactElement;

    if (loaded && !configured) {
        body = (
            <EmptyState
                description={t(
                    "No @lunora/flags provider is wired in this deployment. Add lunora/flags.ts with defineFlags({ provider }) to gate code paths on feature flags.",
                )}
                testId="flags-unconfigured"
                title={t("No flags provider configured")}
            />
        );
    } else if (loaded && flags.length === 0) {
        body = (
            <EmptyState
                description={t(
                    'A flags provider is configured, but no handler reads a flag yet. Call ctx.flags.boolean("key", false) in a query, mutation, or action.',
                )}
                testId="flags-empty"
                title={t("No flags read")}
            />
        );
    } else {
        body = (
            <Card className="overflow-hidden py-0">
                <CardContent className="px-0">
                    <Table data-testid="flags-table">
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t("Key")}</TableHead>
                                <TableHead>{t("Type")}</TableHead>
                                <TableHead>{t("Value")}</TableHead>
                                <TableHead>{t("Reason")}</TableHead>
                                <TableHead>{t("Variant")}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {flags.map((flag) => (
                                <TableRow data-testid={`flags-row-${flag.key}`} key={flag.key}>
                                    <TableCell className="font-mono text-xs">{flag.key}</TableCell>
                                    <TableCell className="font-mono text-xs text-muted-foreground">{flag.type}</TableCell>
                                    <TableCell className="font-mono text-xs">{formatValue(flag)}</TableCell>
                                    <TableCell>
                                        {flag.errorCode === undefined ? (
                                            <span className="font-mono text-xs text-muted-foreground">{flag.reason ?? "—"}</span>
                                        ) : (
                                            <Badge data-testid={`flags-error-${flag.key}`} variant="destructive">
                                                {flag.errorCode}
                                            </Badge>
                                        )}
                                    </TableCell>
                                    <TableCell className="font-mono text-xs text-muted-foreground">{flag.variant ?? "—"}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        );
    }

    return (
        <div className="flex flex-col gap-6" data-testid="lunora-flags-panel">
            {error !== null && <ErrorAlert error={errorSource} testId="flags-error" />}

            <p className="text-sm text-muted-foreground">
                {t(
                    'Feature flags are read in code with ctx.flags.<type>("key", default). They evaluate through the OpenFeature provider configured in lunora/flags.ts; edit the targeting context below to see how each flag resolves for a given audience.',
                )}
            </p>

            <div className="flex flex-col gap-2">
                <Label htmlFor="flags-targeting-context">{t("Targeting context (JSON)")}</Label>
                <Textarea
                    className="font-mono text-xs"
                    data-testid="flags-context-input"
                    id="flags-targeting-context"
                    onChange={(event): void => {
                        setContextText(event.target.value);
                    }}
                    placeholder={CONTEXT_PLACEHOLDER}
                    rows={3}
                    value={contextText}
                />
                {contextError !== null && (
                    <p className="text-xs text-destructive" data-testid="flags-context-error" role="alert">
                        {t(contextError)}
                    </p>
                )}
                {liveError !== undefined && (
                    <p className="text-xs text-amber-600 dark:text-amber-500" data-testid="flags-live-error" role="alert">
                        {t("Live updates unavailable; showing the last evaluation.")}
                    </p>
                )}
            </div>

            {body}
        </div>
    );
};

export default FlagsPanel;
