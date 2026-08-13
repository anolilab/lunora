"use client";

import { Check, ChevronDown, Search } from "lucide-react";
import type { FC, ReactNode } from "react";
import { useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { AccentColor } from "@/data/packages";
import { packages } from "@/data/packages";
import { Kicker, Shell } from "@/kit/layout";
import { PageHeader } from "@/kit/page-header";
import type { FeedItem, ReleaseGroup, ReleaseKind } from "@/lib/changelog-source";
import { cn } from "@/lib/utils";

import SupportSection from "../home/sections/support";

/**
 * Release feed: one row per release, version and package pinned in a left rail,
 * the notes beside it.
 *
 * The rail sticks while its own row scrolls, which is what makes a long entry
 * readable — five bullets down the list you can still see which package and
 * version you are reading.
 */

/** Chip order: what a reader looks for first, not alphabetical. */
const KIND_ORDER: ReleaseKind[] = ["feature", "fix", "perf", "refactor", "docs", "chore"];

const KIND_LABEL: Record<ReleaseKind, string> = {
    chore: "chore",
    docs: "docs",
    feature: "feature",
    fix: "fix",
    perf: "perf",
    refactor: "refactor",
};

// The one place colour is spent on this page: the package's own accent fills
// the tag's left cell, so a reader tracking one package can find its rows by
// colour down a long feed. Everything else stays grey.
const ACCENT_FILL: Record<AccentColor, string> = {
    "crimson-energy": "bg-crimson-energy",
    "royal-amethyst": "bg-royal-amethyst",
    "sky-sapphire": "bg-sky-sapphire",
};

const SECTION_LABEL: Record<string, string> = {
    "bug fixes": "Fixed",
    "build system": "Build",
    "code refactoring": "Refactored",
    "continuous integration": "CI",
    dependencies: "Dependencies",
    documentation: "Docs",
    features: "Added",
    "miscellaneous chores": "Chores",
    "performance improvements": "Performance",
    styles: "Styles",
    tests: "Tests",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const formatDate = (iso: string): string => {
    const [year, month, day] = iso.split("-");

    return `${MONTHS[Number(month) - 1]} ${String(Number(day))}, ${year}`;
};

// Bold, code and links are the only inline markdown semantic-release emits, so
// the notes are tokenised rather than run through a markdown pipeline: these
// become React elements, which also means nothing is ever set as raw HTML.
const INLINE = /(\*\*[^*]{1,200}\*\*|`[^`]{1,200}`|\[[^\]]{1,200}\]\([^)]{1,500}\))/;
const LINK = /^\[([^\]]{1,200})\]\(([^)]{1,500})\)$/;

const renderNote = (text: string): ReactNode[] => {
    let offset = 0;

    return text.split(INLINE).map((token) => {
        const key = `${String(offset)}:${token}`;

        offset += token.length;

        if (token.startsWith("**") && token.endsWith("**")) {
            return (
                <strong className="font-medium text-ink" key={key}>
                    {token.slice(2, -2)}
                </strong>
            );
        }

        if (token.startsWith("`") && token.endsWith("`")) {
            return (
                <code className="border border-hairline bg-wash px-1 py-0.5 font-mono text-[0.85em] text-ink-muted" key={key}>
                    {token.slice(1, -1)}
                </code>
            );
        }

        const link = LINK.exec(token);

        if (link) {
            return (
                <a
                    className="font-mono text-[0.9em] text-ink-faint underline underline-offset-2 transition-colors hover:text-ink"
                    href={link[2]}
                    key={key}
                    rel="noreferrer"
                    target="_blank"
                >
                    {link[1]}
                </a>
            );
        }

        return <span key={key}>{token}</span>;
    });
};

/** Slug → category, used only to group the picker's list under headings. */
const CATEGORY_BY_SLUG = new Map(packages.map((pkg) => [pkg.slug, pkg.category]));
const ACCENT_BY_SLUG = new Map(packages.map((pkg) => [pkg.slug, pkg.accentColor]));

/**
 * Package and kind as one joined two-cell tag.
 *
 * The fill is the package's accent with near-black ink on it. These accents sit
 * around 56–68% lightness, which is the band where light ink fails and dark ink
 * passes comfortably — the inverse of the rule that governs ink *over* the
 * shader field, where the ground is dark.
 */
const ReleaseTag: FC<{ kind: ReleaseKind; pkg: string; slug: string }> = ({ kind, pkg, slug }) => (
    <span className="inline-flex items-stretch font-mono text-xs tracking-[0.12em] uppercase">
        <span className={cn("px-2.5 py-1.5 font-medium text-[hsl(240_14%_10%)]", ACCENT_FILL[ACCENT_BY_SLUG.get(slug) ?? "sky-sapphire"])}>{pkg}</span>
        <span className="border border-l-0 border-hairline-strong px-2.5 py-1.5 text-ink-muted">{KIND_LABEL[kind]}</span>
    </span>
);

const ReleaseRow: FC<{ item: Extract<FeedItem, { type: "release" }> }> = ({ item }) => (
    <article className="grid gap-6 border-t border-hairline py-12 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-16">
        <div className="lg:sticky lg:top-32 lg:self-start">
            {/* The package is what a reader scans for first — a release only means
                something once you know which package it belongs to — so it leads
                the rail and the version sits under it. */}
            <ReleaseTag kind={item.kind} pkg={item.pkg} slug={item.key} />
            <h2 className="mt-4 font-mono text-h3 font-semibold tracking-tight text-ink">{item.version}</h2>
        </div>

        <div className="flex flex-col gap-7">
            <div className="flex items-center gap-3">
                <time className="font-mono text-xs tracking-wider text-ink-faint uppercase" dateTime={item.date}>
                    {formatDate(item.date)}
                </time>
                {item.url ? (
                    <a
                        className="font-mono text-xs text-ink-faint underline underline-offset-2 transition-colors hover:text-ink"
                        href={item.url}
                        rel="noreferrer"
                        target="_blank"
                    >
                        diff
                    </a>
                ) : null}
            </div>

            {item.groups.map((group) => (
                <section key={group.name}>
                    <h3 className="font-mono text-[10px] tracking-[0.18em] text-ink-faint uppercase">
                        {SECTION_LABEL[group.name.toLowerCase()] ?? group.name}
                    </h3>
                    <ul className="mt-3 flex flex-col gap-2">
                        {group.items.map((note) => (
                            <li className="flex gap-3 text-sm leading-relaxed text-ink-muted" key={note}>
                                <span aria-hidden="true" className="mt-2 size-1 shrink-0 bg-hairline-strong" />
                                <span>{renderNote(note)}</span>
                            </li>
                        ))}
                    </ul>
                </section>
            ))}
        </div>
    </article>
);

const DepsRow: FC<{ item: Extract<FeedItem, { type: "deps" }> }> = ({ item }) => (
    <div className="grid gap-2 border-t border-hairline py-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-16">
        <span className="font-mono text-xs text-ink-faint">
            {item.days > 1 ? `${formatDate(item.from)} – ${formatDate(item.date)}` : formatDate(item.date)}
        </span>
        <p className="text-sm text-ink-faint">
            Dependency updates only, across <span className="text-ink-muted">{item.packages}</span> packages
            {item.days > 1 ? ` over ${String(item.days)} days` : null}.
        </p>
    </div>
);

const PAGE_SIZE = 30;

const Chip: FC<{ active: boolean; children: ReactNode; onClick: () => void }> = ({ active, children, onClick }) => (
    <button
        className={cn(
            "flex items-center gap-2 border px-3 py-1.5 font-mono text-[11px] tracking-[0.08em] whitespace-nowrap uppercase transition-colors",
            active ? "border-ink bg-ink text-canvas" : "border-hairline text-ink-faint hover:border-hairline-strong hover:text-ink",
        )}
        onClick={onClick}
        type="button"
    >
        {children}
    </button>
);

const matchesNotes = (groups: ReleaseGroup[], query: string): boolean => groups.some((group) => group.items.some((note) => note.toLowerCase().includes(query)));

/**
 * Package filter: a popover checklist rather than a row of chips.
 *
 * 52 packages cannot sit in a bar, and grouping them by category — the first
 * attempt — asked the reader to know which category a package is in before they
 * could find it. Here they are named, searchable, and grouped only as a heading.
 *
 * An empty selection means every package, so the page opens unfiltered and the
 * button reads "All packages" rather than starting with 52 boxes ticked and
 * making "none selected" a state that shows nothing.
 */
const PackagePicker: FC<{
    onChange: (next: string[]) => void;
    options: { category: string; label: string; value: string }[];
    selected: string[];
}> = ({ onChange, options, selected }) => {
    const [query, setQuery] = useState("");
    // Membership is asked once per option per render; a Set answers in constant
    // time where `includes` rescans the whole selection for each of 52 rows.
    const picked = new Set(selected);

    const needle = query.trim().toLowerCase();
    const visible = needle ? options.filter((option) => option.label.toLowerCase().includes(needle)) : options;

    const byCategory = new Map<string, typeof options>();

    for (const option of visible) {
        byCategory.set(option.category, [...(byCategory.get(option.category) ?? []), option]);
    }

    const grouped = [...byCategory].toSorted(([a], [b]) => a.localeCompare(b));

    const toggle = (value: string): void => {
        onChange(picked.has(value) ? selected.filter((item) => item !== value) : [...selected, value]);
    };

    return (
        <Popover>
            <PopoverTrigger asChild>
                <button
                    className={cn(
                        "flex items-center gap-2 border px-3 py-1.5 font-mono text-[11px] tracking-[0.08em] whitespace-nowrap uppercase transition-colors",
                        selected.length > 0 ? "border-ink bg-ink text-canvas" : "border-hairline text-ink-faint hover:border-hairline-strong hover:text-ink",
                    )}
                    type="button"
                >
                    {selected.length > 0 ? `${String(selected.length)} packages` : "All packages"}
                    <ChevronDown className="size-3.5" />
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 rounded-none border-hairline bg-canvas p-0" sideOffset={8}>
                <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
                    <Search className="size-3.5 shrink-0 text-ink-faint" />
                    <input
                        aria-label="Filter packages by name"
                        className="w-full bg-transparent font-mono text-xs text-ink outline-none placeholder:text-ink-faint"
                        onChange={(event) => {
                            setQuery(event.target.value);
                        }}
                        placeholder="Filter packages…"
                        type="text"
                        value={query}
                    />
                    {selected.length > 0 ? (
                        <button
                            className="font-mono text-[10px] tracking-[0.12em] text-ink-faint uppercase transition-colors hover:text-ink"
                            onClick={() => {
                                onChange([]);
                            }}
                            type="button"
                        >
                            Reset
                        </button>
                    ) : null}
                </div>

                <div className="max-h-80 overflow-y-auto py-1">
                    {grouped.map(([category, items]) => (
                        <div key={category}>
                            <p className="px-3 pt-3 pb-1 font-mono text-[10px] tracking-[0.18em] text-ink-faint uppercase">{category}</p>
                            {items.map((option) => {
                                const active = picked.has(option.value);

                                return (
                                    <button
                                        className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left font-mono text-xs text-ink-muted transition-colors hover:bg-wash hover:text-ink"
                                        key={option.value}
                                        onClick={() => {
                                            toggle(option.value);
                                        }}
                                        type="button"
                                    >
                                        <span
                                            className={cn(
                                                "flex size-3.5 shrink-0 items-center justify-center border",
                                                active ? "border-ink bg-ink text-canvas" : "border-hairline-strong",
                                            )}
                                        >
                                            {active ? <Check className="size-2.5" /> : null}
                                        </span>
                                        {option.label}
                                    </button>
                                );
                            })}
                        </div>
                    ))}

                    {grouped.length === 0 ? <p className="px-3 py-6 text-center font-mono text-xs text-ink-faint">No package matches that.</p> : null}
                </div>
            </PopoverContent>
        </Popover>
    );
};

const Changelog: FC<{ feed: FeedItem[] }> = ({ feed }) => {
    // Only packages that actually shipped something are offered — a filter that
    // can only ever return nothing is furniture.
    const packageOptions = ((): { category: string; label: string; value: string }[] => {
        const seen = new Map<string, string>();

        for (const item of feed) {
            if (item.type === "release") {
                seen.set(item.key, item.pkg);
            }
        }

        return [...seen]
            .map(([key, label]) => {
                return { category: CATEGORY_BY_SLUG.get(key) ?? "Other", label, value: key };
            })
            .toSorted((a, b) => a.label.localeCompare(b.label));
    })();

    const presentKinds = new Set(feed.flatMap((item) => (item.type === "release" ? [item.kind] : [])));
    const kinds = KIND_ORDER.filter((kind) => presentKinds.has(kind));

    const [selectedPackages, setSelectedPackages] = useState<string[]>([]);
    const [kind, setKind] = useState<ReleaseKind | undefined>();
    const [search, setSearch] = useState("");
    const [visible, setVisible] = useState(PAGE_SIZE);

    const filtered = ((): FeedItem[] => {
        const query = search.trim().toLowerCase();
        const picked = new Set(selectedPackages);

        return feed.filter((item) => {
            // A dependency roll-up answers for every package at once, so it drops
            // out the moment the reader narrows to one group, kind, or term.
            if (item.type === "deps") {
                return picked.size === 0 && kind === undefined && !query;
            }

            if (picked.size > 0 && !picked.has(item.key)) {
                return false;
            }

            if (kind !== undefined && item.kind !== kind) {
                return false;
            }

            if (!query) {
                return true;
            }

            return item.pkg.toLowerCase().includes(query) || item.version.toLowerCase().includes(query) || matchesNotes(item.groups, query);
        });
    })();

    const shown = filtered.slice(0, visible);
    const releaseCount = feed.filter((item) => item.type === "release").length;
    const releaseShown = filtered.filter((item) => item.type === "release").length;

    return (
        <div className="relative overflow-x-clip bg-canvas" data-theme="dark">
            {/* Same header as the docs overview: an index page, not an article. */}
            <PageHeader align="bottom" panelWidth="wide" size="short">
                <div className="mb-7 flex items-center justify-between gap-4">
                    <Kicker>Releases</Kicker>
                    <Kicker>{String(releaseCount)} releases</Kicker>
                </div>
                <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
                    <h1 className="text-display font-bold text-ink">Changelog</h1>
                    <p className="max-w-sm text-body text-ink-muted">
                        Every release across the Lunora packages, newest first. Lunora is alpha: the API still moves, and this is where it is written down.
                    </p>
                </div>
            </PageHeader>

            {/* The band opens on the same rhythm as the docs overview: `pt-section`
                sits on the section, never on the sticky child — `top` docks that
                child's border box, so padding there becomes a transparent strip
                with release rows scrolling through it. */}
            <section className="pt-section" data-nav-theme="dark">
                {/* Same sticky treatment as the package index: inset to the shell
                    rather than full-bleed, opaque, with its own frame. */}
                <Shell className="sticky top-28 z-40">
                    <div className="flex flex-col gap-3 border border-hairline bg-canvas p-3 lg:flex-row lg:items-center">
                        <PackagePicker
                            onChange={(next) => {
                                setSelectedPackages(next);
                                setVisible(PAGE_SIZE);
                            }}
                            options={packageOptions}
                            selected={selectedPackages}
                        />

                        <div className="flex flex-wrap items-center gap-1.5 lg:ml-2">
                            <Chip
                                active={kind === undefined}
                                onClick={() => {
                                    setKind(undefined);
                                    setVisible(PAGE_SIZE);
                                }}
                            >
                                All
                            </Chip>
                            {kinds.map((name) => (
                                <Chip
                                    active={kind === name}
                                    key={name}
                                    onClick={() => {
                                        setKind(name);
                                        setVisible(PAGE_SIZE);
                                    }}
                                >
                                    {KIND_LABEL[name]}
                                </Chip>
                            ))}
                        </div>
                        <div className="relative sm:ml-auto">
                            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint" />
                            <input
                                aria-label="Search releases"
                                className="w-full border border-hairline bg-wash py-2 pr-4 pl-9 font-mono text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-hairline-strong sm:w-64"
                                onChange={(event) => {
                                    setSearch(event.target.value);
                                    setVisible(PAGE_SIZE);
                                }}
                                placeholder="Search releases…"
                                type="text"
                                value={search}
                            />
                        </div>
                        <span className="hidden font-mono text-[11px] tracking-[0.08em] whitespace-nowrap text-ink-faint xl:inline">
                            {releaseShown} / {releaseCount}
                        </span>
                    </div>
                </Shell>

                <Shell className="pt-6 pb-24">
                    {shown.map((item) =>
                        item.type === "release" ? <ReleaseRow item={item} key={item.id} /> : <DepsRow item={item} key={`deps-${item.date}`} />,
                    )}

                    {shown.length === 0 ? (
                        <div className="flex flex-col items-center gap-4 border-t border-hairline py-20">
                            <p className="text-lg text-ink-faint">No releases match that filter.</p>
                            <button
                                className="text-sm text-ink-muted underline underline-offset-4 transition-colors hover:text-ink"
                                onClick={() => {
                                    setSelectedPackages([]);
                                    setKind(undefined);
                                    setSearch("");
                                }}
                                type="button"
                            >
                                Clear filters
                            </button>
                        </div>
                    ) : null}

                    {visible < filtered.length ? (
                        <div className="flex justify-center border-t border-hairline pt-10">
                            <button
                                className="border border-hairline px-6 py-2.5 font-mono text-xs text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
                                onClick={() => {
                                    setVisible((count) => count + PAGE_SIZE);
                                }}
                                type="button"
                            >
                                Show more ({filtered.length - visible} left)
                            </button>
                        </div>
                    ) : null}
                </Shell>
            </section>

            <SupportSection />
        </div>
    );
};

export default Changelog;
