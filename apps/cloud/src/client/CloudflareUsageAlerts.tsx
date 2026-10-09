import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { api } from "../../lunora/_generated/api.js";
import type { CloudflareAccountView } from "./cloudflare-accounts";
import { COLUMN_LABEL } from "./section-styles";
import { FormError, StatusBadge } from "./section-ui";
import type { OrgId } from "./types";
import type { UsageAlertProduct, UsageAlertsOverview, UsageAlertsResult } from "./usage-alerts";
import {
    applyRequest,
    coveredByOwnPolicy,
    describeProposal,
    FAILURE_COPY,
    initialLimits,
    initialSelection,
    STATE_COPY,
    summarizeResults,
} from "./usage-alerts";

/** What the setup form hands its owner to write. */
export type ApplyUsageAlerts = (request: { products: { id: string; limit: number }[]; recipients: string[] }) => Promise<UsageAlertsResult[]>;

const NO_POLICY_LABEL = "Not covered";

/** `selected` with `id` added, or removed when it was there. */
const toggled = (selected: ReadonlyArray<string>, id: string): string[] =>
    selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id];

/** Which policies already cover a product, as one line. */
const CoverageLine = ({ product }: { product: UsageAlertProduct }): ReactElement => {
    if (product.covered.length === 0) {
        return <StatusBadge tone="warning">{NO_POLICY_LABEL}</StatusBadge>;
    }

    return (
        <span className="flex flex-wrap gap-1">
            {product.covered.map((policy) => (
                <StatusBadge key={policy.policyId} tone={policy.enabled ? "success" : "neutral"}>
                    {policy.managed ? "Lunora-managed" : `Your policy “${policy.name}”`}
                    {policy.limit === null ? "" : ` · ${policy.limit}`}
                    {policy.enabled ? "" : " · off"}
                </StatusBadge>
            ))}
        </span>
    );
};

const ProductRow = ({
    checked,
    limit,
    onLimit,
    onToggle,
    product,
}: {
    checked: boolean;
    limit: string;
    onLimit: (id: string, value: string) => void;
    onToggle: (id: string) => void;
    product: UsageAlertProduct;
}): ReactElement => {
    const inputId = `usage-alert-${product.id}`;

    return (
        <li className="grid gap-1 border-b py-2 last:border-b-0">
            <div className="flex flex-wrap items-center gap-2">
                <input
                    aria-label={`Alert on ${product.description}`}
                    checked={checked}
                    onChange={() => {
                        onToggle(product.id);
                    }}
                    type="checkbox"
                />
                <label className="text-sm font-medium" htmlFor={inputId}>
                    {product.description}
                </label>
                <CoverageLine product={product} />
                <Input
                    className="ml-auto w-44 font-mono text-xs"
                    disabled={!checked}
                    id={inputId}
                    inputMode="numeric"
                    onChange={(event) => {
                        onLimit(product.id, event.target.value);
                    }}
                    placeholder="threshold"
                    value={limit}
                />
            </div>
            <span className="text-xs text-muted-foreground">
                {describeProposal(product)}
                {coveredByOwnPolicy(product) ? " · already covered by a policy of yours, so unticked" : ""}
            </span>
        </li>
    );
};

/** The editable setup: products and thresholds, recipients, and the write. Mounted per loaded overview, so it starts from the proposal. */
const UsageAlertsForm = ({
    onApply,
    products,
    recipients: defaultRecipients,
}: {
    onApply: ApplyUsageAlerts;
    products: UsageAlertsOverview["products"];
    recipients: ReadonlyArray<string>;
}): ReactElement => {
    const [selected, setSelected] = useState<string[]>(() => initialSelection(products));
    const [limits, setLimits] = useState<Record<string, string>>(() => initialLimits(products));
    const [recipients, setRecipients] = useState(() => defaultRecipients.join("\n"));
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<null | string>(null);

    const toggle = (id: string): void => {
        setSelected((current) => toggled(current, id));
    };
    const setLimit = (id: string, value: string): void => {
        setLimits((current) => {
            return { ...current, [id]: value };
        });
    };

    const chosen = new Set(selected);

    const submit = async (): Promise<void> => {
        const request = applyRequest(selected, limits, recipients);

        if ("error" in request) {
            setError(request.error);

            return;
        }

        setPending(true);
        setError(null);

        try {
            await onApply(request);
        } catch (error_) {
            setError(error_ instanceof Error ? error_.message : "Setting up the alerts failed.");
        }

        setPending(false);
    };

    return (
        <form
            className="grid gap-3"
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            <p className="m-0 text-xs text-muted-foreground">
                Thresholds are a billing period&apos;s usage of each product, proposed from what your Lunora Cloud projects in this account used last month.
                Cloudflare counts the whole account, so raise them if other Workers run there.
            </p>
            <ul className="m-0 grid list-none p-0">
                {products.map((product) => (
                    <ProductRow
                        checked={chosen.has(product.id)}
                        key={product.id}
                        limit={limits[product.id] ?? ""}
                        onLimit={setLimit}
                        onToggle={toggle}
                        product={product}
                    />
                ))}
            </ul>
            <label className="grid gap-1 text-sm" htmlFor="usage-alert-recipients">
                <span className={`${COLUMN_LABEL} text-muted-foreground`}>Email recipients</span>
                <textarea
                    className="min-h-16 rounded-md border bg-transparent px-3 py-2 font-mono text-xs"
                    id="usage-alert-recipients"
                    onChange={(event) => {
                        setRecipients(event.target.value);
                    }}
                    value={recipients}
                />
                <span className="text-xs text-muted-foreground">
                    Your organization&apos;s owners and admins by default. Cloudflare has no test send for these emails.
                </span>
            </label>
            {error === null ? null : <FormError message={error} />}
            <div>
                <Button disabled={pending} size="sm" type="submit">
                    {pending ? "Saving in Cloudflare…" : "Create or update alerts in Cloudflare"}
                </Button>
            </div>
        </form>
    );
};

/** The account-wide budget alert, which Cloudflare offers only in its dashboard. */
const BudgetAlertNote = ({ href }: { href: string }): ReactElement => (
    <p className="m-0 text-xs text-muted-foreground">
        Also add an account-wide budget alert: Cloudflare offers it only in its dashboard, not its API, so Lunora Cloud cannot create or check it.{" "}
        <a className="underline underline-offset-2" href={href} rel="noreferrer" target="_blank">
            Open Billing
        </a>{" "}
        → Billable Usage → Create budget alert.
    </p>
);

/** The outcome of the last setup, per failed product. */
const Outcome = ({ results }: { results: ReadonlyArray<UsageAlertsResult> }): ReactElement => (
    <div className="grid gap-1 text-sm">
        <span>{summarizeResults(results)}</span>
        {results
            .filter((result) => result.action === "failed")
            .map((result) => (
                <span className="text-xs text-destructive" key={result.productId}>
                    {result.productId}: {result.kind === null ? "" : FAILURE_COPY[result.kind]} {result.message}
                </span>
            ))}
    </div>
);

/** A loaded overview: its state line or the form, then the budget-alert note. */
export const UsageAlertsView = ({
    onApply,
    overview,
    recipients,
}: {
    onApply: ApplyUsageAlerts;
    overview: UsageAlertsOverview;
    /** The organization's owners' and admins' addresses, or none when they could not be looked up. */
    recipients: ReadonlyArray<string>;
}): ReactElement => (
    <div className="grid gap-3">
        {overview.state === "ready" ? (
            <UsageAlertsForm onApply={onApply} products={overview.products} recipients={recipients} />
        ) : (
            <p className="m-0 text-sm text-muted-foreground">
                {STATE_COPY[overview.state]}
                {overview.message === null ? null : <span className="block font-mono text-xs">Cloudflare said: {overview.message}</span>}
            </p>
        )}
        <BudgetAlertNote href={overview.dashboard.budgetAlert} />
    </div>
);

type Loaded = { overview: UsageAlertsOverview; recipients: string[]; status: "loaded" } | { status: "error" } | { status: "idle" } | { status: "loading" };

/** Deadline for the recipients lookup. */
const REQUEST_TIMEOUT_MS = 15_000;

/** The `recipients` of the lookup's answer, keeping only strings. */
const recipientsOf = (payload: unknown): string[] => {
    const list = (payload as null | { recipients?: unknown })?.recipients;

    return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
};

/**
 * The organization's owners' and admins' addresses (`POST
 * /v1/cloudflare-accounts/alert-recipients`), or none when the lookup fails —
 * the form then starts empty and the addresses are typed in.
 */
const requestRecipients = async (organizationId: OrgId): Promise<string[]> => {
    try {
        const response = await fetch("/v1/cloudflare-accounts/alert-recipients", {
            body: JSON.stringify({ organizationId }),
            credentials: "include",
            headers: { "content-type": "application/json" },
            method: "POST",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
            return [];
        }

        return recipientsOf(await response.json());
    } catch {
        return [];
    }
};

/**
 * Cloudflare's own usage alerts on one connected account (owners/admins). Read
 * on demand rather than on mount — each read is two calls to the customer's
 * Notifications API — and re-read after a setup, so the coverage shown is what
 * Cloudflare now holds.
 */
export const CloudflareUsageAlerts = ({ account, organizationId }: { account: CloudflareAccountView; organizationId: OrgId }): ReactElement => {
    const client = useLunora();
    const [loaded, setLoaded] = useState<Loaded>({ status: "idle" });
    const [outcome, setOutcome] = useState<UsageAlertsResult[] | null>(null);

    const load = async (): Promise<void> => {
        setLoaded({ status: "loading" });

        try {
            const [overview, recipients] = await Promise.all([
                client.action(api.cloudflare_alerts.overview, { id: account._id, organizationId }),
                requestRecipients(organizationId),
            ]);

            setLoaded({ overview, recipients, status: "loaded" });
        } catch {
            setLoaded({ status: "error" });
        }
    };

    const apply: ApplyUsageAlerts = async (request) => {
        const { results } = await client.action(api.cloudflare_alerts.apply, { ...request, id: account._id, organizationId });

        setOutcome(results);
        await load();

        return results;
    };

    let body: ReactElement | null;

    switch (loaded.status) {
        case "error": {
            body = <span className="text-xs text-destructive">Could not read this account&apos;s notifications. Try again.</span>;
            break;
        }
        case "loaded": {
            body = <UsageAlertsView onApply={apply} overview={loaded.overview} recipients={loaded.recipients} />;
            break;
        }
        case "loading": {
            body = <span className="text-xs text-muted-foreground">Reading the account&apos;s notifications from Cloudflare…</span>;
            break;
        }
        default: {
            body = null;
        }
    }

    return (
        <section className="grid gap-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">Usage alerts from Cloudflare itself</span>
                <span className="text-xs text-muted-foreground">sent by Cloudflare, so they keep working even if Lunora Cloud is down</span>
                <Button
                    className="ml-auto"
                    disabled={loaded.status === "loading"}
                    onClick={() => {
                        void load();
                    }}
                    size="sm"
                    type="button"
                    variant="outline"
                >
                    {loaded.status === "idle" ? "Set up Cloudflare usage alerts" : "Refresh"}
                </Button>
            </div>
            <p className="m-0 text-xs text-muted-foreground">
                Cloudflare bills this account directly, so your plan&apos;s spend cap does not apply to projects here. Cloudflare&apos;s Usage Based Billing
                notifications email you when a product passes a threshold well above normal.
            </p>
            {outcome === null ? null : <Outcome results={outcome} />}
            {body}
        </section>
    );
};
