import type { ReturnOf } from "@lunora/client";
import { useLunora, usePreloadedQuery, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { api } from "../../lunora/_generated/api.js";
import { AsyncList } from "./AsyncList";
import { formatNumber } from "./format";
import { COLUMN_LABEL, Field, FieldForm, FormError, Row, RowActions, RowList, StatusBadge } from "./section-ui";
import type { SectionProps } from "./tabs";

/**
 * Subscription lifecycle → the tone its chip carries. `state` arrives as a plain
 * string from the provider sync, so anything unmapped falls back to neutral.
 */
const SUBSCRIPTION_TONE: Record<string, "danger" | "info" | "neutral" | "success" | "warning"> = {
    active: "success",
    canceled: "danger",
    past_due: "warning",
    paused: "warning",
    trialing: "info",
};

/** The three plan quotas, in the order they read as a sentence about capacity. */
const QUOTAS = [
    { key: "projects", label: "Projects" },
    { key: "members", label: "Members" },
    { key: "previewDeployments", label: "Previews" },
] as const;

/**
 * Billing tab (§4). Reads the org's resolved entitlements and webhook-synced
 * subscriptions live, and drives Creem checkout / the hosted billing portal through
 * the `billing.checkout` / `billing.portal` actions (which redirect the browser
 * to the provider). Price ids are environment config; entered here rather than
 * hardcoded in the client.
 *
 * Hierarchy: the current plan is what this screen exists to answer, so the plan
 * name is the one thing rendered at display size — it floats on the card with no
 * box of its own. The quota row beneath it is secondary (mono values under mono
 * caps labels), and everything else — feature chips, subscription rows, the
 * checkout form — is tertiary chrome. Only the subscription state is tinted, and
 * it tints the chip, never the row.
 */
export const BillingSection = ({ organizationId, preloaded }: SectionProps<ReturnOf<typeof api.billing.entitlements>>): ReactElement => {
    const client = useLunora();
    const entitlements = usePreloadedQuery(preloaded);
    const subscriptions = useQuery(api.billing.subscription, { organizationId });

    const [priceId, setPriceId] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const startCheckout = (): void => {
        setError(null);
        setBusy(true);

        void (async () => {
            try {
                const { origin } = globalThis.location;
                const { url } = await client.action(api.billing.checkout, {
                    cancelUrl: `${origin}/?billing=cancel`,
                    organizationId,
                    priceId,
                    successUrl: `${origin}/?billing=success`,
                });
                globalThis.location.href = url;
            } catch (error_: unknown) {
                setError(error_ instanceof Error ? error_.message : "checkout failed");
                setBusy(false);
            }
        })();
    };

    const openPortal = (): void => {
        setError(null);
        setBusy(true);

        void (async () => {
            try {
                const { url } = await client.action(api.billing.portal, { organizationId, returnUrl: globalThis.location.origin });
                globalThis.location.href = url;
            } catch (error_: unknown) {
                setError(error_ instanceof Error ? error_.message : "portal failed");
                setBusy(false);
            }
        })();
    };

    return (
        <div className="flex flex-col gap-6">
            <Card>
                <CardContent className="py-4">
                    {entitlements ? (
                        <div className="flex flex-col gap-8">
                            <div className="flex flex-col gap-2">
                                <span className={`${COLUMN_LABEL} text-muted-foreground`}>Current plan</span>
                                {/* The screen's primary layer — unboxed, at display size. */}
                                <span className="text-4xl leading-none font-light tracking-[-0.02em]">
                                    {entitlements.plans.length > 0 ? entitlements.plans.join(", ") : "free"}
                                </span>
                            </div>

                            <dl className="m-0 flex flex-wrap gap-10">
                                {QUOTAS.map((quota) => (
                                    <div className="flex flex-col gap-1" key={quota.key}>
                                        <dt className={`${COLUMN_LABEL} text-muted-foreground`}>{quota.label}</dt>
                                        <dd className="m-0 font-mono text-base tabular-nums">{formatNumber(entitlements.limits[quota.key])}</dd>
                                    </div>
                                ))}
                            </dl>

                            <div className="flex flex-wrap items-center gap-2">
                                <span className={`${COLUMN_LABEL} text-muted-foreground`}>Features</span>
                                {entitlements.features.length > 0 ? (
                                    entitlements.features.map((feature) => <StatusBadge key={feature}>{feature}</StatusBadge>)
                                ) : (
                                    <span className="text-muted-foreground text-sm">No add-on features on this plan.</span>
                                )}
                            </div>
                        </div>
                    ) : (
                        <p className={`${COLUMN_LABEL} text-muted-foreground`}>[Loading…]</p>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Subscriptions</CardTitle>
                </CardHeader>
                <CardContent>
                    <AsyncList
                        empty="No subscription — this org is on the free plan."
                        render={(rows) => (
                            <RowList>
                                {rows.map((sub) => (
                                    <Row key={sub.priceId + sub.provider}>
                                        <span className="shrink-0 font-mono text-xs">{sub.priceId}</span>
                                        <span className="text-muted-foreground font-mono text-xs">{sub.provider}</span>
                                        <RowActions>
                                            {sub.cancelAtPeriodEnd ? <span className="text-muted-foreground text-xs">cancels at period end</span> : null}
                                            <StatusBadge tone={SUBSCRIPTION_TONE[sub.state] ?? "neutral"}>{sub.state}</StatusBadge>
                                        </RowActions>
                                    </Row>
                                ))}
                            </RowList>
                        )}
                        rows={subscriptions}
                    />
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Manage billing</CardTitle>
                </CardHeader>
                <CardContent>
                    <FieldForm
                        action={() => {
                            startCheckout();
                        }}
                    >
                        <Field htmlFor="billing-price-id" label="Price id">
                            <Input
                                aria-label="Price id"
                                id="billing-price-id"
                                onChange={(event) => {
                                    setPriceId(event.target.value);
                                }}
                                placeholder="prod_… (from your Creem dashboard)"
                                required
                                value={priceId}
                            />
                        </Field>
                        <div className="flex flex-wrap items-center gap-2 justify-self-start">
                            <Button disabled={busy} type="submit">
                                Start checkout
                            </Button>
                            <Button disabled={busy} onClick={openPortal} type="button" variant="ghost">
                                Open billing portal
                            </Button>
                        </div>
                        <FormError message={error} />
                    </FieldForm>
                </CardContent>
            </Card>
        </div>
    );
};
