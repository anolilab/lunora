import type { Preloaded, ReturnOf } from "@lunora/client";
import { useLunora, useMutation, usePreloadedQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { api } from "../../lunora/_generated/api.js";
import { COLUMN_LABEL, Field, FieldForm, FormError, Row, RowActions, RowList, StatusBadge } from "./section-ui";
import type { OrgId } from "./types";

interface CloudflareCostsSectionProps {
    organizationId: OrgId;
    /** SSR-preloaded connection status. Stays live so connect/disconnect update without a reload. */
    preloaded: Preloaded<ReturnOf<typeof api.cloudflare_billing.status>>;
}

/** The summary action's result — a status plus (on "ok") the normalized cost view. */
type SummaryResult = ReturnOf<typeof api.cloudflare_billing.summary>;

const LOCALE = "en-GB";

/** Minor units (cents) → a currency string, pinned to one locale so SSR/client agree. Falls back for unknown ISO codes. */
const formatMoney = (minor: number, currency: string): string => {
    try {
        return new Intl.NumberFormat(LOCALE, { currency, style: "currency" }).format(minor / 100);
    } catch {
        return `${(minor / 100).toFixed(2)} ${currency}`;
    }
};

/** Human line for each non-ok summary status. */
const STATUS_MESSAGE: Record<string, string> = {
    error: "Couldn’t read Cloudflare billing right now. The Billable Usage API updates daily — try again shortly.",
    unauthorized: "The stored token was rejected. Re-connect with a token that has the Billing Read permission (self-serve accounts only).",
    unconfigured: "Cost data is unavailable because this cell has no encryption key configured, so the stored token cannot be read.",
};

/** The cost breakdown for an "ok" summary: a hero total, the period, and a per-product list. */
const CostOverview = ({ view }: { view: NonNullable<SummaryResult["view"]> }): ReactElement => {
    if (view.products.length === 0) {
        return <p className="text-muted-foreground py-4 text-sm">No billable usage for the current period yet. Cloudflare updates this data daily.</p>;
    }

    return (
        <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-1">
                <span className={`${COLUMN_LABEL} text-muted-foreground`}>Current period{view.periodEnd ? ` — ${view.periodEnd}` : ""}</span>
                <span className="font-mono text-3xl">{formatMoney(view.totalMinor, view.currency)}</span>
            </div>

            <RowList>
                {view.products.map((line) => (
                    <Row key={line.product}>
                        <span className="shrink-0 font-medium">{line.product}</span>
                        {line.quantity === null ? null : (
                            <StatusBadge>
                                {new Intl.NumberFormat(LOCALE).format(line.quantity)}
                                {line.unit ? ` ${line.unit}` : ""}
                            </StatusBadge>
                        )}
                        <RowActions>
                            <span className="font-mono text-sm">{formatMoney(line.costMinor, line.currency)}</span>
                        </RowActions>
                    </Row>
                ))}
            </RowList>
        </div>
    );
};

/** The connected-account cost panel body: loading, the cost breakdown, or a status line. */
const SummaryBody = ({ summary }: { summary: SummaryResult | undefined }): ReactElement => {
    if (summary === undefined) {
        return <p className="text-muted-foreground py-4 text-center font-mono text-xs tracking-[0.09em] uppercase">[Loading…]</p>;
    }

    if (summary.status === "ok" && summary.view) {
        return <CostOverview view={summary.view} />;
    }

    return <p className="text-muted-foreground py-4 text-sm">{STATUS_MESSAGE[summary.status] ?? "No Cloudflare usage to show yet."}</p>;
};

/**
 * Cloudflare costs tab. Shows a BYO org its **real** Cloudflare spend by product
 * for the most recent charge period, read from that account's own
 * [Billable Usage API](https://developers.cloudflare.com/billing/manage/billable-usage/).
 * This is distinct from the Usage tab, which shows the control plane's *estimate*
 * (metered requests/CPU × a fixed cost basis).
 *
 * Connecting stores the account's Billing-Read token via the `/v1/cloudflare-billing`
 * edge route, which encrypts it before it reaches the database — the master key
 * never touches the browser, exactly like the Secrets tab. `status` is a live
 * query (so connect/disconnect reflect immediately); the cost view comes from the
 * `summary` **action** (a `fetch`, not reactive), polled on connect and on manual
 * refresh, and it fails open to a status line rather than an error.
 */
export const CloudflareCostsSection = ({ organizationId, preloaded }: CloudflareCostsSectionProps): ReactElement => {
    const connection = usePreloadedQuery(preloaded);
    const client = useLunora();
    const disconnect = useMutation(api.cloudflare_billing.disconnect);

    const [summary, setSummary] = useState<SummaryResult | undefined>(undefined);
    const [refreshNonce, setRefreshNonce] = useState(0);

    const [accountId, setAccountId] = useState("");
    const [token, setToken] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<null | string>(null);

    const { cloudflareAccountId, connected } = connection;

    // The cost view comes from an action (a fetch, not reactive), so — like
    // `use-metrics-series` — poll it in an effect and write state only in the
    // async callbacks, with an out-of-order guard. Re-runs on connect and on a
    // manual refresh; the `status` live query drives connect/disconnect.
    useEffect(() => {
        let cancelled = false;

        if (connected) {
            void client
                .action(api.cloudflare_billing.summary, { organizationId })
                .then((result) => {
                    if (!cancelled) {
                        setSummary(result);
                    }

                    return result;
                })
                .catch(() => {
                    if (!cancelled) {
                        setSummary({ cloudflareAccountId, status: "error", view: null });
                    }
                });
        }

        return () => {
            cancelled = true;
        };
    }, [client, cloudflareAccountId, connected, organizationId, refreshNonce]);

    return (
        <div className="flex flex-col gap-6">
            <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-4">
                    <div className="flex flex-col gap-1.5">
                        <CardTitle>Cloudflare costs</CardTitle>
                        <CardDescription>
                            The real billable usage on your Cloudflare account, by product, for the current charge period — from the Billable Usage API.
                            Distinct from the Usage tab, which shows the control plane&apos;s estimate.
                        </CardDescription>
                    </div>
                    {connected ? (
                        <Button
                            onClick={() => {
                                setRefreshNonce((value) => value + 1);
                            }}
                            size="sm"
                            variant="outline"
                        >
                            Refresh
                        </Button>
                    ) : null}
                </CardHeader>
            </Card>

            {connected ? (
                <>
                    <Card>
                        <CardHeader>
                            <CardTitle>Connected account</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <Row>
                                <span className={`${COLUMN_LABEL} text-muted-foreground`}>Account</span>
                                <span className="font-mono text-sm">{cloudflareAccountId}</span>
                                <RowActions>
                                    <Button
                                        className="text-destructive hover:text-destructive"
                                        onClick={() => {
                                            void disconnect.mutate({ organizationId });
                                        }}
                                        size="sm"
                                        variant="ghost"
                                    >
                                        Disconnect
                                    </Button>
                                </RowActions>
                            </Row>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardContent className="flex flex-col gap-4 pt-6">
                            <SummaryBody summary={summary} />
                        </CardContent>
                    </Card>
                </>
            ) : (
                <Card>
                    <CardHeader>
                        <CardTitle>Connect your Cloudflare account</CardTitle>
                        <CardDescription>
                            Paste your Cloudflare account ID and an API token with the <span className="font-mono text-xs">Billing Read</span> permission. The
                            token is encrypted before storage — it never reaches the database in plaintext.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <FieldForm
                            action={() => {
                                setError(null);
                                setPending(true);

                                // Promise combinators (not try/finally) so React Compiler can memoize this component.
                                const save = async (): Promise<void> => {
                                    const response = await fetch("/v1/cloudflare-billing", {
                                        body: JSON.stringify({ cloudflareAccountId: accountId, organizationId, token }),
                                        credentials: "include",
                                        headers: { "content-type": "application/json" },
                                        method: "POST",
                                    });

                                    if (!response.ok) {
                                        const payload = (await response.json().catch(() => null)) as { error?: string } | null;

                                        setError(payload?.error ?? `connect failed (${String(response.status)})`);

                                        return;
                                    }

                                    setAccountId("");
                                    setToken("");
                                };

                                void save()
                                    .catch((error_: unknown) => {
                                        setError(error_ instanceof Error ? error_.message : "connect failed");
                                    })
                                    .finally(() => {
                                        setPending(false);
                                    });
                            }}
                        >
                            <Field htmlFor="cf-account-id" label="Cloudflare account ID">
                                <Input
                                    id="cf-account-id"
                                    onChange={(event) => {
                                        setAccountId(event.target.value);
                                    }}
                                    placeholder="your Cloudflare account ID"
                                    required
                                    value={accountId}
                                />
                            </Field>
                            <Field htmlFor="cf-token" label="API token (Billing Read)">
                                <Input
                                    id="cf-token"
                                    onChange={(event) => {
                                        setToken(event.target.value);
                                    }}
                                    placeholder="cloudflare API token"
                                    required
                                    type="password"
                                    value={token}
                                />
                            </Field>
                            <Button className="justify-self-start" disabled={pending} type="submit">
                                {pending ? "Connecting…" : "Connect"}
                            </Button>
                            <FormError message={error} />
                        </FieldForm>
                    </CardContent>
                </Card>
            )}
        </div>
    );
};
