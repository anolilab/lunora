import { ArrowRight, ExternalLink, TriangleAlert } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";

import HatchSpacer from "@/components/sections/hatch-spacer";
import { ClosingCta } from "@/components/sections/langbase";
import type { Example } from "@/data/examples";
import { deployUrl, examples, sourceUrl } from "@/data/examples";
import { Action } from "@/kit/action";
import { Kicker, Shell } from "@/kit/layout";
import { ArticleHeader } from "@/kit/page-header";
import { cn } from "@/lib/utils";

/**
 * `/examples` — the runnable apps in `examples/`.
 *
 * The copy is transcribed from `examples/README.md` and lives in
 * `src/data/examples.ts`; nothing here invents a description or a deploy target.
 * Only five examples carry a Cloudflare deploy button, and three of those five
 * ship no auth — that warning rides on the card rather than being buried in a
 * paragraph, because it is the one thing a reader has to know *before* clicking.
 */

/**
 * The facets, in the order a reader scans them: everything, then the deploy
 * split, then what an example actually uses.
 *
 * The capability facets are the packages in each example's own package.json, so
 * a filter can never promise an example that does not use the thing. Counts are
 * derived rather than written down, for the same reason.
 */
const CAPABILITY_LABEL: Record<string, string> = {
    ai: "AI",
    auth: "Auth",
    "auth-ui": "Auth UI",
    bindings: "Bindings",
    d1: "D1",
    notify: "Notifications",
    payment: "Payments",
    ratelimit: "Rate limiting",
    "react-native": "React Native",
    scheduler: "Scheduler",
    storage: "Storage",
};

type Filter = { kind: "all" } | { kind: "capability"; value: string } | { kind: "deploy"; value: boolean } | { kind: "platform"; value: string };

const matches = (example: Example, filter: Filter): boolean => {
    if (filter.kind === "deploy") {
        return (example.deploy !== undefined) === filter.value;
    }

    if (filter.kind === "platform") {
        return example.platform === filter.value;
    }

    if (filter.kind === "capability") {
        return example.uses.includes(filter.value as Example["uses"][number]);
    }

    return true;
};

const sameFilter = (a: Filter, b: Filter): boolean => a.kind === b.kind && ("value" in a && "value" in b ? a.value === b.value : true);

/** Every capability at least one example uses, most-used first, then alphabetical. */
// `react-native` is the Expo example's platform, not a capability alongside the
// others — listed in both groups it gave the rail two rows with the same label
// and the same single result.
const capabilities = [...new Set(examples.flatMap((example) => example.uses))]
    .filter((capability) => capability !== "react-native")
    .toSorted((a, b) => {
        const used = (capability: string): number => examples.filter((example) => example.uses.includes(capability as Example["uses"][number])).length;

        return used(b) - used(a) || a.localeCompare(b);
    });

const FACET_GROUPS: { facets: { filter: Filter; label: string }[]; title: string }[] = [
    {
        facets: [
            { filter: { kind: "all" }, label: "All" },
            { filter: { kind: "deploy", value: true }, label: "Deployable" },
            { filter: { kind: "deploy", value: false }, label: "Source only" },
        ],
        title: "Show",
    },
    {
        facets: [
            { filter: { kind: "platform" as const, value: "spa" }, label: "React SPA" },
            { filter: { kind: "platform" as const, value: "ssr" }, label: "TanStack Start" },
            { filter: { kind: "platform" as const, value: "native" }, label: "React Native" },
        ],
        title: "Platform",
    },
    {
        facets: capabilities.map((capability) => {
            return { filter: { kind: "capability" as const, value: capability }, label: CAPABILITY_LABEL[capability] ?? capability };
        }),
        title: "Uses",
    },
];

/**
 * Opaque filler for the slot an odd count leaves empty.
 *
 * The grid paints `bg-hairline` and shows it through `gap-px`, so a short final
 * row exposes that colour as a solid slab rather than a 1px rule. One column
 * below `sm` can never be short; two columns above it are short on an odd count.
 */
const Fillers: FC<{ count: number }> = ({ count }) => <div aria-hidden="true" className={cn("hidden bg-canvas", count % 2 === 1 && "sm:block")} />;

/**
 * The card image.
 *
 * None of the examples ships a screenshot, and booting thirteen apps to take
 * one is not a docs build. The generated card is the same renderer the blog
 * uses for postser without art, so the gallery has a picture per row without
 * anything being invented about what the app looks like.
 */
const Preview: FC<{ example: Example }> = ({ example }) => {
    const parameters = new URLSearchParams({ description: example.what, eyebrow: "Example", title: example.dir });

    return (
        <div className="aspect-1200/630 w-full overflow-hidden border-b border-hairline bg-wash">
            <img alt="" className="size-full object-cover" decoding="async" loading="lazy" src={`/api/og?${parameters.toString()}`} />
        </div>
    );
};

const ExampleCell: FC<{ example: Example }> = ({ example }) => (
    <div className="flex h-full flex-col bg-canvas" data-example={example.dir}>
        <Preview example={example} />
        <div className="flex flex-1 flex-col gap-4 p-6">
            <div className="flex items-baseline justify-between gap-3">
                <h3 className="font-mono text-base font-medium tracking-tight text-ink">{example.dir}</h3>
                <Kicker size="micro">{example.deploy ? "Deployable" : "Source"}</Kicker>
            </div>

            <p className="text-sm leading-relaxed text-ink-muted">{example.what}</p>

            <div className="flex flex-col gap-1.5">
                <Kicker size="micro">Shows off</Kicker>
                <p className="text-sm leading-relaxed text-ink-faint">{example.shows}</p>
            </div>

            {example.deploy === "open" ? (
                <p className="flex items-start gap-2 border border-hairline-strong p-3 text-xs leading-relaxed text-accent">
                    <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                    <span>No auth by design — a deployed instance is open to anyone with the URL.</span>
                </p>
            ) : null}

            <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-hairline pt-4">
                {example.deploy ? (
                    <Action href={deployUrl(example.dir)} variant="primary">
                        Deploy
                        <ArrowRight className="size-4" />
                    </Action>
                ) : null}
                <Action href={sourceUrl(example.dir)} variant="ghost">
                    Source
                    <ExternalLink className="size-3.5" />
                </Action>
            </div>
        </div>
    </div>
);

const Examples: FC = () => {
    const [filter, setFilter] = useState<Filter>({ kind: "all" });
    const [query, setQuery] = useState("");

    const needle = query.trim().toLowerCase();
    const found = (example: Example): boolean =>
        needle === "" ||
        example.dir.includes(needle) ||
        example.what.toLowerCase().includes(needle) ||
        example.shows.toLowerCase().includes(needle) ||
        example.uses.some((capability) => capability.includes(needle));

    const shown = examples.filter((example) => matches(example, filter) && found(example));

    return (
        <div className="relative overflow-x-clip bg-canvas" data-theme="dark">
            <ArticleHeader
                actions={
                    <>
                        <Action to="/start" variant="primary">
                            Start a project
                            <ArrowRight className="size-4" />
                        </Action>
                        <Action href="https://github.com/anolilab/lunora/tree/alpha/examples">Browse on GitHub</Action>
                    </>
                }
                breadcrumb={[{ label: "Lunora", to: "/" }, { label: "Examples" }]}
                lead="Thirteen runnable apps, each built around a different part of the framework. Read one to see the pattern, clone it to change it, or deploy the ones with a button straight to your own Cloudflare account."
                meta="Examples"
                title="Read a real one."
            />

            <section data-nav-theme="dark">
                <Shell className="py-20">
                    {/* A rail, not a row of chips: the facets are grouped and the
                        list grows with the packages, so they read down a column
                        and stay in view while the grid scrolls past them. */}
                    <div className="grid gap-10 lg:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] lg:gap-12">
                        <aside className="lg:sticky lg:top-32 lg:self-start">
                            <div className="flex flex-col gap-7">
                                <div className="flex items-center gap-2 border-b border-hairline pb-2">
                                    <span aria-hidden="true" className="font-mono text-[10px] tracking-[0.08em] whitespace-nowrap text-accent uppercase">
                                        filter://
                                    </span>
                                    <input
                                        aria-label="Filter examples by name, description or package"
                                        autoComplete="off"
                                        className="w-full bg-transparent font-mono text-xs text-ink outline-none placeholder:text-ink-faint"
                                        data-1p-ignore=""
                                        data-form-type="other"
                                        data-lpignore="true"
                                        onChange={(event) => {
                                            setQuery(event.target.value);
                                        }}
                                        placeholder="name, package, what it shows"
                                        type="text"
                                        value={query}
                                    />
                                </div>

                                {FACET_GROUPS.map((group) => (
                                    <div className="flex flex-col gap-2" key={group.title}>
                                        <div className="border-b border-hairline pb-2">
                                            <Kicker className="font-bold" size="micro">
                                                {group.title}
                                            </Kicker>
                                        </div>
                                        <ul className="flex flex-wrap gap-x-4 gap-y-1 lg:flex-col lg:gap-0">
                                            {group.facets.map((facet) => {
                                                // Counts follow the search box too: a facet reading 5
                                                // that yields two rows is a lie about the data.
                                                const count = examples.filter((example) => matches(example, facet.filter) && found(example)).length;
                                                const active = sameFilter(filter, facet.filter);

                                                return (
                                                    <li key={facet.label}>
                                                        <button
                                                            className={cn(
                                                                "flex w-full items-center justify-between gap-3 px-2 py-[7px] text-left text-xs transition-colors",
                                                                // The one filled state on the page. Dark ink on the
                                                                // accent, not light: these accents sit mid-lightness,
                                                                // the band where light ink fails and dark ink passes.
                                                                active
                                                                    ? "bg-accent font-medium text-[hsl(240_14%_10%)]"
                                                                    : "text-ink-faint hover:bg-wash hover:text-ink",
                                                                count === 0 && !active && "opacity-40",
                                                            )}
                                                            onClick={() => {
                                                                setFilter(facet.filter);
                                                            }}
                                                            type="button"
                                                        >
                                                            <span>{facet.label}</span>
                                                            <span
                                                                className={cn(
                                                                    "font-mono text-[11px]",
                                                                    active ? "text-[hsl(240_14%_10%)]/70" : "text-ink-faint",
                                                                )}
                                                            >
                                                                {count}
                                                            </span>
                                                        </button>
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    </div>
                                ))}
                            </div>
                        </aside>

                        {/* Cells are opaque direct children of the hairline-painted
                            grid: a wrapper or a translucent cell shows the hairline
                            across its whole face rather than only in the gaps. */}
                        <div className="grid grid-cols-1 gap-px border border-hairline bg-hairline sm:grid-cols-2">
                            {shown.map((example) => (
                                <ExampleCell example={example} key={example.dir} />
                            ))}
                            <Fillers count={shown.length} />
                        </div>
                    </div>

                    <p className="mt-8 text-sm leading-relaxed text-ink-faint">
                        Run any of them locally with <code className="font-mono text-ink-muted">pnpm install</code> then{" "}
                        <code className="font-mono text-ink-muted">pnpm --filter @lunora-example/&lt;name&gt; dev</code>, and open localhost:5173. Examples that
                        need a D1 database, an R2 bucket or a secret say so in their own README; everything else runs offline in Miniflare.
                    </p>
                </Shell>
            </section>

            <HatchSpacer />

            <ClosingCta />
        </div>
    );
};

export default Examples;
