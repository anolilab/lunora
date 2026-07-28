import { Add01Icon, ArrowLeft01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLunora, useMutation, useQuery } from "@lunora/react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

import { api } from "../../lunora/_generated/api.js";
import type { PlanId } from "./plan-catalog";
import { isPaidPlan, PLAN_CATALOG, planCard, planPriceId } from "./plan-catalog";
import { Field, FieldForm, FormError } from "./section-ui";
import type { CellId, OrgId } from "./types";

interface OrgSummary {
    _id: OrgId;
    name: string;
    plan: string;
}

interface OrganizationsSheetProps {
    onOpenChange: (open: boolean) => void;
    open: boolean;
    organizations: ReadonlyArray<OrgSummary>;
    orgId: OrgId;
}

/** First letter of a name, for the square monogram logo mark. */
const initialOf = (name: string | undefined): string => name?.trim().charAt(0).toUpperCase() ?? "•";

/** Derive a url-safe slug from a free-text name (mirrors the server's own). */
const slugify = (value: string): string => {
    let out = "";
    let dash = false;

    for (const char of value.toLowerCase()) {
        if ((char >= "a" && char <= "z") || (char >= "0" && char <= "9")) {
            out += char;
            dash = false;
        } else if (!dash && out.length > 0) {
            out += "-";
            dash = true;
        }
    }

    while (out.endsWith("-")) {
        out = out.slice(0, -1);
    }

    return out;
};

/**
 * A right-anchored panel over the current dashboard (no page switch) with two
 * views: a list of the user's organizations to switch between, and a create flow
 * that picks a plan (with a live "what's included" breakdown) and data-residency
 * placement. The full-page `/orgs` picker stays as the deep-linkable fallback.
 *
 * Note: the plan is the org's *nominal* tier — real entitlements still resolve
 * from an active subscription (Billing), so paid tiers are provisioned here but
 * unlocked on the Billing tab.
 */
export const OrganizationsSheet = ({ onOpenChange, open, organizations, orgId }: OrganizationsSheetProps): ReactElement => {
    const navigate = useNavigate();
    const client = useLunora();
    const createOrg = useMutation(api.organizations.create);
    // Only subscribe to the cell catalogue while the sheet is open.
    const cells = useQuery(api.cells.list, open ? {} : "skip");

    const [mode, setMode] = useState<"create" | "list">("list");
    const [name, setName] = useState("");
    const [plan, setPlan] = useState<PlanId>("free");
    const [jurisdiction, setJurisdiction] = useState("any");
    const [cellId, setCellId] = useState("auto");
    const [error, setError] = useState<null | string>(null);

    // Only active cells can take new tenants; the jurisdiction filter narrows them.
    const eligibleCells = (cells ?? []).filter((cell) => cell.status === "active" && (jurisdiction === "any" || cell.jurisdiction === jurisdiction));
    const selected = planCard(plan);

    let submitLabel = "Create organization";

    if (createOrg.pending) {
        submitLabel = "Creating…";
    } else if (isPaidPlan(plan)) {
        submitLabel = "Continue to checkout";
    }

    // Reset to the list view whenever the sheet is dismissed.
    const setOpen = (next: boolean): void => {
        if (!next) {
            setMode("list");
        }

        onOpenChange(next);
    };

    return (
        <Sheet onOpenChange={setOpen} open={open}>
            <SheetContent className="w-full gap-0 sm:max-w-md" side="right">
                {mode === "list" ? (
                    <>
                        <SheetHeader>
                            <SheetTitle>Organizations</SheetTitle>
                            <SheetDescription>Switch between your organizations, or create a new one.</SheetDescription>
                        </SheetHeader>

                        <nav className="flex-1 overflow-y-auto px-4">
                            <ul className="m-0 grid list-none gap-0.5 p-0">
                                {organizations.map((organization) => {
                                    const current = organization._id === orgId;

                                    return (
                                        <li key={organization._id}>
                                            <Link
                                                className={cn(
                                                    "flex items-center gap-3 rounded-md px-2 py-2 text-sm text-foreground no-underline transition-colors hover:bg-accent",
                                                    current && "bg-accent",
                                                )}
                                                onClick={() => {
                                                    setOpen(false);
                                                }}
                                                params={{ organizationId: organization._id }}
                                                to="/orgs/$organizationId/projects"
                                            >
                                                <span className="grid size-7 shrink-0 place-items-center rounded-md bg-foreground text-[11px] font-semibold text-background">
                                                    {initialOf(organization.name)}
                                                </span>
                                                <span className="flex-1 truncate font-medium">{organization.name}</span>
                                                <Badge className="font-mono text-[10px] tracking-[0.06em] uppercase" variant="secondary">
                                                    {organization.plan}
                                                </Badge>
                                                {current ? (
                                                    <HugeiconsIcon className="size-4 shrink-0 text-muted-foreground" icon={Tick02Icon} strokeWidth={2} />
                                                ) : null}
                                            </Link>
                                        </li>
                                    );
                                })}
                            </ul>
                        </nav>

                        <SheetFooter className="border-t">
                            <Button
                                onClick={() => {
                                    setError(null);
                                    setMode("create");
                                }}
                            >
                                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                                Create organization
                            </Button>
                        </SheetFooter>
                    </>
                ) : (
                    <>
                        <SheetHeader>
                            <button
                                className="flex w-fit cursor-pointer items-center gap-1 font-mono text-[11px] tracking-[0.06em] text-muted-foreground uppercase hover:text-foreground"
                                onClick={() => {
                                    setMode("list");
                                }}
                                type="button"
                            >
                                <HugeiconsIcon className="size-3.5" icon={ArrowLeft01Icon} strokeWidth={2} />
                                All organizations
                            </button>
                            <SheetTitle>Create organization</SheetTitle>
                            <SheetDescription>Pick a plan and where it runs.</SheetDescription>
                        </SheetHeader>

                        <div className="flex-1 overflow-y-auto px-4 pb-4">
                            <FieldForm
                                className="max-w-none"
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    setError(null);

                                    void (async () => {
                                        // Step 1 — provision the org. A failure here (e.g. slug clash)
                                        // keeps the form open with the error.
                                        let id: OrgId;

                                        try {
                                            id = await createOrg.mutate({
                                                cellId: cellId === "auto" ? undefined : (cellId as CellId),
                                                jurisdiction: jurisdiction === "any" ? undefined : jurisdiction,
                                                name,
                                                plan,
                                                slug: slugify(name),
                                            });
                                        } catch (error_: unknown) {
                                            setError(error_ instanceof Error ? error_.message : "create failed");

                                            return;
                                        }

                                        // The org now exists — reset and close so a retry never double-creates.
                                        const chosen = plan;

                                        setName("");
                                        setPlan("free");
                                        setJurisdiction("any");
                                        setCellId("auto");
                                        setOpen(false);

                                        const priceId = planPriceId(chosen);

                                        // Free (or a plan with no configured price) lands straight in the org.
                                        if (!isPaidPlan(chosen) || priceId === undefined) {
                                            void navigate({ params: { organizationId: id }, to: "/orgs/$organizationId/projects" });

                                            return;
                                        }

                                        // Step 2 — paid plan: start Creem checkout and hand off to it. If the
                                        // session can't be created (provider not configured, etc.), drop the
                                        // user on the org's Billing tab to complete it there.
                                        try {
                                            const { origin } = globalThis.location;
                                            const { url } = await client.action(api.billing.checkout, {
                                                cancelUrl: `${origin}/orgs/${id}/billing`,
                                                organizationId: id,
                                                priceId,
                                                successUrl: `${origin}/orgs/${id}/projects`,
                                            });

                                            globalThis.location.href = url;
                                        } catch {
                                            void navigate({ params: { organizationId: id }, to: "/orgs/$organizationId/billing" });
                                        }
                                    })();
                                }}
                            >
                                <Field htmlFor="new-org-name" label="Name">
                                    <Input
                                        id="new-org-name"
                                        onChange={(event) => {
                                            setName(event.target.value);
                                        }}
                                        placeholder="Acme Inc"
                                        required
                                        value={name}
                                    />
                                </Field>

                                <div className="grid gap-2">
                                    <p className="font-mono text-[11px] tracking-[0.07em] text-muted-foreground uppercase">Plan</p>
                                    {PLAN_CATALOG.map((card) => {
                                        const active = card.id === plan;

                                        return (
                                            <button
                                                aria-pressed={active}
                                                className={cn(
                                                    "flex flex-col gap-0.5 rounded-md border p-3 text-left transition-colors",
                                                    active ? "border-[var(--aurora-violet)] bg-accent" : "border-border hover:bg-accent",
                                                )}
                                                key={card.id}
                                                onClick={() => {
                                                    setPlan(card.id);
                                                }}
                                                type="button"
                                            >
                                                <span className="flex items-center justify-between">
                                                    <span className="text-sm font-medium">{card.name}</span>
                                                    <span
                                                        className={cn(
                                                            "size-3.5 shrink-0 rounded-full border",
                                                            active ? "border-[var(--aurora-violet)] bg-[var(--aurora-violet)]" : "border-muted-foreground",
                                                        )}
                                                    />
                                                </span>
                                                <span className="text-xs text-muted-foreground">{card.tagline}</span>
                                            </button>
                                        );
                                    })}
                                </div>

                                <div className="grid gap-2">
                                    <p className="font-mono text-[11px] tracking-[0.07em] text-muted-foreground uppercase">What&apos;s included</p>
                                    <ul className="m-0 grid list-none gap-1.5 p-0">
                                        {[...selected.quotas, ...selected.features].map((item) => (
                                            <li className="flex items-start gap-2 text-sm" key={item}>
                                                <HugeiconsIcon
                                                    className="mt-0.5 size-4 shrink-0 text-[var(--aurora-violet)]"
                                                    icon={Tick02Icon}
                                                    strokeWidth={2}
                                                />
                                                <span>{item}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>

                                <Field htmlFor="new-org-jurisdiction" label="Jurisdiction">
                                    <Select
                                        onValueChange={(value) => {
                                            setJurisdiction(value ?? "any");
                                            // A cell pinned to the old jurisdiction no longer applies.
                                            setCellId("auto");
                                        }}
                                        value={jurisdiction}
                                    >
                                        <SelectTrigger id="new-org-jurisdiction">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectGroup>
                                                <SelectItem value="any">Any</SelectItem>
                                                <SelectItem value="eu">EU (data residency)</SelectItem>
                                                <SelectItem value="fedramp">FedRAMP (US gov)</SelectItem>
                                            </SelectGroup>
                                        </SelectContent>
                                    </Select>
                                </Field>

                                <Field htmlFor="new-org-cell" label="Cell">
                                    <Select
                                        onValueChange={(value) => {
                                            setCellId(value ?? "auto");
                                        }}
                                        value={cellId}
                                    >
                                        <SelectTrigger id="new-org-cell">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectGroup>
                                                <SelectItem value="auto">Automatic</SelectItem>
                                                {eligibleCells.map((cell) => (
                                                    <SelectItem key={cell._id} value={cell._id}>
                                                        {cell.name}
                                                        {cell.jurisdiction ? ` · ${cell.jurisdiction.toUpperCase()}` : ""}
                                                    </SelectItem>
                                                ))}
                                            </SelectGroup>
                                        </SelectContent>
                                    </Select>
                                </Field>

                                <Button className="justify-self-start" disabled={createOrg.pending} type="submit">
                                    {submitLabel}
                                </Button>
                                {isPaidPlan(plan) ? (
                                    <p className="text-xs text-muted-foreground">You&apos;ll be redirected to Creem to complete payment.</p>
                                ) : null}
                                <FormError message={error} />
                            </FieldForm>
                        </div>
                    </>
                )}
            </SheetContent>
        </Sheet>
    );
};
