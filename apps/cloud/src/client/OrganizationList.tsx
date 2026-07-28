import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Preloaded, ReturnOf } from "@lunora/client";
import { useMutation, usePreloadedQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

import { api } from "../../lunora/_generated/api.js";
import { COLUMN_LABEL, Field, FormError, StatusBadge } from "./section-ui";
import type { CellId, OrgId } from "./types";

interface OrganizationListProps {
    onSelect: (id: OrgId) => void;
    /** Cells, server-rendered by the `/` route loader. */
    preloadedCells: Preloaded<ReturnOf<typeof api.cells.list>>;
    /** Organizations, server-rendered by the `/` route loader. */
    preloadedOrganizations: Preloaded<ReturnOf<typeof api.organizations.list>>;
}

/** Derive a url-safe slug from a free-text organization name. */
const slugify = (value: string): string => {
    let out = "";
    let lastDash = false;

    for (const char of value.toLowerCase()) {
        const ok = (char >= "a" && char <= "z") || (char >= "0" && char <= "9");

        if (ok) {
            out += char;
            lastDash = false;
        } else if (!lastDash && out.length > 0) {
            out += "-";
            lastDash = true;
        }
    }

    while (out.endsWith("-")) {
        out = out.slice(0, -1);
    }

    return out;
};

/**
 * Organization picker + create form. Listing organizations and the cells they
 * land on both run through live Lunora queries; creating one routes through the
 * `organizations.create` mutation, which requires choosing the cell (account
 * shard) the org's tenants will be provisioned into.
 *
 * Hierarchy: this is the signed-in landing screen and it renders outside the
 * dashboard shell, so it owns its own page frame. The org names are the one thing
 * shown at size — they are what the visitor came to click — over a hairline-ruled
 * list with no card around it. The create panel is the secondary column, bordered
 * and narrow so it reads as supporting. Everything else (the heading itself, the
 * count, slugs, plan, cell status) stays tertiary in the mono ALL-CAPS voice. The
 * single aurora moment is the violet edge marking the hovered/focused row.
 *
 * The list is rendered inline rather than through `AsyncList`: both queries are
 * SSR-preloaded, so `usePreloadedQuery` never hands back `undefined` and there is
 * no loading state to skeleton over — only "empty" and "populated".
 */
export const OrganizationList = ({ onSelect, preloadedCells, preloadedOrganizations }: OrganizationListProps): ReactElement => {
    // Seeded from the SSR render, then live over the WebSocket from mount on.
    const organizations = usePreloadedQuery(preloadedOrganizations);
    const cells = usePreloadedQuery(preloadedCells);
    const createOrg = useMutation(api.organizations.create);

    const [name, setName] = useState("");
    const [slug, setSlug] = useState("");
    // Plain `string`, not `CellId | ""` — Base UI's Select is generic over its value,
    // and a branded union collapses that inference to the empty-string literal. The
    // brand is re-applied at the mutation call.
    const [cellId, setCellId] = useState("");
    const [error, setError] = useState<string | null>(null);

    const effectiveSlug = slug.trim() === "" ? slugify(name) : slug;

    return (
        <div className="min-h-dvh bg-background px-6 py-16 sm:px-10 lg:px-16 lg:py-24">
            <div className="mx-auto grid w-full max-w-6xl gap-16 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-24">
                <main className="min-w-0">
                    <header>
                        <div className="flex items-baseline gap-3">
                            <h1 className={cn(COLUMN_LABEL, "text-muted-foreground")}>Your organizations</h1>
                            <span className="font-mono text-[10px] tracking-[0.09em] text-muted-foreground tabular-nums">
                                {String(organizations.length).padStart(2, "0")}
                            </span>
                        </div>
                        <p className="mt-4 max-w-sm text-sm text-muted-foreground">Pick one to open its control plane.</p>
                    </header>

                    <div className="mt-12">
                        {organizations.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No organizations yet — create your first one.</p>
                        ) : (
                            <ul className="m-0 grid list-none gap-0 border-t border-border p-0">
                                {organizations.map((org) => (
                                    <li key={org._id}>
                                        <button
                                            className="group relative flex w-full cursor-pointer items-center gap-6 border-b border-border py-6 pr-2 pl-4 text-left transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none"
                                            onClick={() => {
                                                onSelect(org._id);
                                            }}
                                            type="button"
                                        >
                                            {/* The screen's one aurora moment: a violet edge on the row under the cursor. */}
                                            <span
                                                aria-hidden
                                                className="absolute inset-y-0 left-0 w-px bg-transparent transition-colors group-hover:bg-[var(--aurora-violet)] group-focus-visible:bg-[var(--aurora-violet)]"
                                            />
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate text-2xl font-light tracking-[-0.02em] sm:text-3xl">{org.name}</span>
                                                <span className="mt-1.5 block font-mono text-[11px] tracking-[0.06em] text-muted-foreground">/{org.slug}</span>
                                            </span>
                                            {/* Plan is categorical, so the neutral tone — in the mono label voice, like the org sheet. */}
                                            <StatusBadge>
                                                <span className="font-mono text-[10px] tracking-[0.06em] uppercase">{org.plan}</span>
                                            </StatusBadge>
                                            <HugeiconsIcon
                                                className="size-4 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-foreground group-focus-visible:text-foreground"
                                                icon={ArrowRight01Icon}
                                                strokeWidth={2}
                                            />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </main>

                <aside className="lg:sticky lg:top-24 lg:self-start">
                    <div className="border border-border p-6">
                        <h2 className={cn(COLUMN_LABEL, "text-muted-foreground")}>New organization</h2>
                        <p className="mt-3 text-sm text-muted-foreground">New organizations start on the free plan — upgrade later from the Billing tab.</p>
                        {cells?.length === 0 ? (
                            <p className="mt-3 text-sm text-muted-foreground">
                                No cells registered yet. Register a cell (account shard) before creating an organization.
                            </p>
                        ) : null}
                        {/* React 19 form action — deliberately not `onSubmit` + `preventDefault`. */}
                        <form
                            action={() => {
                                setError(null);

                                if (!cellId) {
                                    setError("Select a cell");

                                    return;
                                }

                                void (async () => {
                                    try {
                                        const id = await createOrg.mutate({ cellId: cellId as CellId, name, slug: effectiveSlug });
                                        setName("");
                                        setSlug("");
                                        onSelect(id);
                                    } catch (error_: unknown) {
                                        setError(error_ instanceof Error ? error_.message : "create failed");
                                    }
                                })();
                            }}
                            className="mt-6 grid gap-4"
                        >
                            <Field htmlFor="org-name" label="Name">
                                <Input
                                    id="org-name"
                                    onChange={(event) => {
                                        setName(event.target.value);
                                    }}
                                    required
                                    value={name}
                                />
                            </Field>
                            <Field htmlFor="org-slug" label="Slug">
                                <Input
                                    id="org-slug"
                                    onChange={(event) => {
                                        setSlug(event.target.value);
                                    }}
                                    placeholder={slugify(name) || "acme"}
                                    value={slug}
                                />
                            </Field>
                            <Field htmlFor="org-cell" label="Cell">
                                <Select
                                    onValueChange={(value) => {
                                        setCellId(value ?? "");
                                    }}
                                    value={cellId === "" ? null : cellId}
                                >
                                    <SelectTrigger className="w-full" id="org-cell">
                                        <SelectValue placeholder="Select a cell…" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectGroup>
                                            {(cells ?? []).map((cell) => (
                                                <SelectItem key={cell._id} value={cell._id}>
                                                    <span>{cell.name}</span>
                                                    <span className="font-mono text-[10px] tracking-[0.06em] text-muted-foreground uppercase">
                                                        {cell.status}
                                                    </span>
                                                </SelectItem>
                                            ))}
                                        </SelectGroup>
                                    </SelectContent>
                                </Select>
                            </Field>
                            <Button className="justify-self-start" disabled={createOrg.pending} type="submit">
                                {createOrg.pending ? "Creating…" : "Create organization"}
                            </Button>
                            <FormError message={error} />
                        </form>
                    </div>
                </aside>
            </div>
        </div>
    );
};
