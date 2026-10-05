import type { ReturnOf } from "@lunora/client";
import { useLunora, usePreloadedQuery } from "@lunora/react";
import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { api } from "../../lunora/_generated/api.js";
import type { CloudflareAccountView } from "./cloudflare-accounts";
import { accountTitle } from "./cloudflare-accounts";
import { formatNumber } from "./format";
import { COLUMN_LABEL } from "./section-styles";
import { Row, RowActions, RowList, StatusBadge } from "./section-ui";
import type { SectionProps } from "./tabs";
import type { OrgId } from "./types";

/** The costs action's result — a status plus (on "ok") the normalized cost view. */
type SummaryResult = ReturnOf<typeof api.cloudflare_accounts.costs>;

const LOCALE = "en-GB";

/**
 * One `Intl.NumberFormat` per currency, kept for the module's lifetime.
 * Constructing one is the expensive part (it resolves locale data); formatting
 * with it is cheap. A Cloudflare bill names one or two currencies, so this
 * caches a handful of instances instead of building one per rendered row.
 * `null` records a currency the runtime rejected, so the fallback path is taken
 * without re-throwing on every render.
 */
const moneyFormatters = new Map<string, Intl.NumberFormat | null>();

/** Minor units (cents) → a currency string, pinned to one locale so SSR/client agree. Falls back for unknown ISO codes. */
const formatMoney = (minor: number, currency: string): string => {
    if (!moneyFormatters.has(currency)) {
        try {
            moneyFormatters.set(currency, new Intl.NumberFormat(LOCALE, { currency, style: "currency" }));
        } catch {
            moneyFormatters.set(currency, null);
        }
    }

    return moneyFormatters.get(currency)?.format(minor / 100) ?? `${(minor / 100).toFixed(2)} ${currency}`;
};

/** Human line for each non-ok summary status. */
const STATUS_MESSAGE: Record<string, string> = {
    error: "Couldn’t read Cloudflare billing right now. The Billable Usage API updates daily — try again shortly.",
    "no-permission": "This account's token was not granted Billing: Read. Rotate it on the Cloudflare accounts tab with that permission to see its costs.",
    unauthorized: "Cloudflare refused the token for the Billable Usage API. Rotate it with Billing: Read (self-serve accounts only).",
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
                                {formatNumber(line.quantity)}
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
 * One connected account's costs. The view comes from the `costs` **action** (a
 * `fetch`, not reactive), so — like `use-metrics-series` — it is read in an
 * effect that writes state only in its async callbacks, with an out-of-order
 * guard; it re-runs on a manual refresh.
 */
const AccountCosts = ({ account, organizationId, refresh }: { account: CloudflareAccountView; organizationId: OrgId; refresh: number }): ReactElement => {
    const client = useLunora();
    const [summary, setSummary] = useState<SummaryResult | undefined>(undefined);

    useEffect(() => {
        let cancelled = false;

        void client
            .action(api.cloudflare_accounts.costs, { id: account._id, organizationId })
            .then((result) => {
                if (!cancelled) {
                    setSummary(result);
                }

                return result;
            })
            .catch(() => {
                if (!cancelled) {
                    setSummary({ status: "error", view: null });
                }
            });

        return () => {
            cancelled = true;
        };
    }, [account._id, client, organizationId, refresh]);

    return (
        <Card>
            <CardHeader>
                <CardTitle>{accountTitle(account)}</CardTitle>
                <CardDescription>
                    <span className="font-mono text-xs">{account.accountId}</span>
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                <SummaryBody summary={summary} />
            </CardContent>
        </Card>
    );
};

/**
 * Cloudflare costs tab. Shows an organization the **real** Cloudflare spend of
 * each Cloudflare account it connected, by product, for the most recent charge
 * period, read from that account's own
 * [Billable Usage API](https://developers.cloudflare.com/billing/manage/billable-usage/).
 * This is distinct from the Usage tab, which shows the control plane's
 * estimate* (metered requests/CPU × a fixed cost basis).
 *
 * There is no second connection here: an account is connected once, on the
 * Cloudflare accounts tab, and its token is read here when it was granted
 * Billing: Read (`cloudflareAccounts.costs`). The list is the live
 * `cloudflareAccounts.list` query, so connecting, rotating or disconnecting
 * there shows here without a reload.
 */
export const CloudflareCostsSection = ({ organizationId, preloaded }: SectionProps<ReturnOf<typeof api.cloudflare_accounts.list>>): ReactElement => {
    const accounts = usePreloadedQuery(preloaded);
    const [refresh, setRefresh] = useState(0);

    return (
        <div className="flex flex-col gap-6">
            <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-4">
                    <div className="flex flex-col gap-1.5">
                        <CardTitle>Cloudflare costs</CardTitle>
                        <CardDescription>
                            The real billable usage on each Cloudflare account your organization connected, by product, for the current charge period — from the
                            Billable Usage API. Distinct from the Usage tab, which shows the control plane&apos;s estimate.
                        </CardDescription>
                    </div>
                    {accounts !== undefined && accounts.length > 0 ? (
                        <Button
                            onClick={() => {
                                setRefresh((value) => value + 1);
                            }}
                            size="sm"
                            variant="outline"
                        >
                            Refresh
                        </Button>
                    ) : null}
                </CardHeader>
            </Card>

            {accounts?.length === 0 ? (
                <Card>
                    <CardContent className="pt-6">
                        <p className="m-0 text-sm text-muted-foreground">
                            No Cloudflare account is connected.{" "}
                            <Link className="underline-offset-2 hover:underline" params={{ organizationId }} to="/orgs/$organizationId/cloudflare-accounts">
                                Connect one on the Cloudflare accounts tab
                            </Link>{" "}
                            with a token that also holds <span className="font-mono text-xs">Billing: Read</span>.
                        </p>
                    </CardContent>
                </Card>
            ) : null}

            {(accounts ?? []).map((account) => (
                <AccountCosts account={account} key={account._id} organizationId={organizationId} refresh={refresh} />
            ))}
        </div>
    );
};
