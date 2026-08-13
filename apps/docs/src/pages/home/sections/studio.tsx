"use client";

import { motion, useReducedMotion } from "motion/react";
import type { FC, KeyboardEvent } from "react";
import { useCallback, useId, useRef, useState } from "react";

import dashboardsImg from "@/assets/studio/dark/dashboards.png";
import dataImg from "@/assets/studio/dark/data.png";
import schemaImg from "@/assets/studio/dark/schema.png";
import sqlImg from "@/assets/studio/dark/sql-editor.png";
import timeTravelImg from "@/assets/studio/dark/time-travel.png";
import { Section, SectionHeader, Shell } from "@/kit/layout";
import { cn } from "@/lib/utils";

/**
 * Studio, shown rather than described.
 *
 * Studio is the part of Lunora worth looking at, and a paragraph about it is
 * worth less than one screenshot of it. Tabs carry five views at full width
 * instead of shrinking them into thumbnails nobody can read.
 *
 * Only the active panel is in the DOM. Mounting all five and hiding four does
 * not help: a lazy image inside a `display: none` panel is not fetched until it
 * is shown, so the first visit to each tab still waited on the network. Instead
 * the image is warmed the moment a tab is pointed at or focused, which is
 * reliably earlier than the click that follows it.
 */

const VIEWS = [
    { blurb: "Every table, column, index, and relation, read from your schema.", image: schemaImg, label: "Schema" },
    { blurb: "Browse and edit rows against your live edge database.", image: dataImg, label: "Data" },
    { blurb: "Run SQL against a shard and read the plan back.", image: sqlImg, label: "SQL" },
    { blurb: "Rewind a shard to any moment in the last 30 days.", image: timeTravelImg, label: "Time travel" },
    { blurb: "Requests, traces, metrics, and issues in one place.", image: dashboardsImg, label: "Observability" },
];

const Studio: FC = () => {
    const [active, setActive] = useState(0);
    const id = useId();
    const reduceMotion = useReducedMotion();
    const tabReferences = useRef<(HTMLButtonElement | null)[]>([]);
    // Warmed images, kept in a ref: this drives no rendering, and putting it in
    // state would re-render the section on every hover.
    const warmed = useRef(new Set<number>([0]));

    const warm = useCallback((index: number) => {
        if (warmed.current.has(index)) {
            return;
        }

        warmed.current.add(index);

        const image = new Image();

        image.src = VIEWS[index].image;
    }, []);

    // `role="tablist"` promises arrow-key navigation. Declaring the role without
    // it leaves a keyboard user worse off than plain buttons would have.
    const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        const STEP: Record<string, number | undefined> = { ArrowLeft: -1, ArrowRight: 1 };
        const delta = STEP[event.key];

        if (delta === undefined) {
            return;
        }

        event.preventDefault();

        const next = (active + delta + VIEWS.length) % VIEWS.length;

        setActive(next);
        tabReferences.current[next]?.focus();
    };

    return (
        <Section id="studio" tone="deep">
            <Shell>
                <SectionHeader action={{ label: "Explore Studio", to: "/studio" }} label="Studio" title="Look at your backend.">
                    <p className="text-body text-ink-muted">
                        A local admin UI ships with every app and runs against your live edge database. No separate deploy, no read-only mirror.
                    </p>
                </SectionHeader>
            </Shell>

            {/* The frame spans the container, meeting the page's vertical guide
                lines. Studio is dense and unreadable at the measure of a
                paragraph; the full viewport was the problem being fixed, and
                breaking past the guide lines reads as a mistake now they exist. */}
            <div className="relative mx-auto w-full max-w-shell px-5 lg:px-0">
                {/* Depth without a shadow: the field the header uses, dimmed and
                    sitting behind the frame so it lifts off the canvas. */}
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-8 -top-6 bottom-10 opacity-30 blur-2xl"
                    style={{
                        background:
                            "radial-gradient(60% 60% at 20% 0%, var(--site-accent) 0%, transparent 70%), radial-gradient(60% 60% at 80% 20%, var(--site-accent-2) 0%, transparent 70%)",
                    }}
                />

                {/* One window: the tabs are its tab bar, the capture is its body.
                    Framing the screenshot as the application it is stops it
                    reading as a loose image dropped onto the page. */}
                <div className="relative border border-hairline bg-canvas-deep">
                    <div className="flex items-stretch border-b border-hairline">
                        <div className="flex flex-1 flex-wrap" role="tablist">
                            {VIEWS.map((view, index) => {
                                const selected = index === active;

                                return (
                                    <button
                                        aria-controls={`${id}-panel`}
                                        aria-selected={selected}
                                        className={cn(
                                            "relative flex-1 border-r border-hairline px-5 py-4 text-left font-mono text-kicker uppercase transition-colors last:border-r-0",
                                            selected ? "bg-surface text-accent" : "text-ink-faint hover:bg-hairline hover:text-ink",
                                        )}
                                        id={`${id}-tab-${String(index)}`}
                                        key={view.label}
                                        onClick={() => {
                                            setActive(index);
                                        }}
                                        onFocus={() => {
                                            warm(index);
                                        }}
                                        onKeyDown={onKeyDown}
                                        onPointerEnter={() => {
                                            warm(index);
                                        }}
                                        ref={(node) => {
                                            tabReferences.current[index] = node;
                                        }}
                                        role="tab"
                                        tabIndex={selected ? 0 : -1}
                                        type="button"
                                    >
                                        {view.label}
                                        {selected ? (
                                            <motion.span
                                                className="absolute inset-x-0 -bottom-px h-px bg-accent"
                                                layoutId={`${id}-indicator`}
                                                transition={reduceMotion ? { duration: 0 } : { duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                                            />
                                        ) : null}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* A fixed aspect rather than a max height: the source is 16:10,
                        so 16:9 trims a sliver and reads as framing. The arbitrary
                        cap it replaces cut nearly half the capture away, which is
                        what made it look accidental. */}
                    <motion.div
                        animate={{ opacity: 1 }}
                        aria-labelledby={`${id}-tab-${String(active)}`}
                        className="relative aspect-[16/9] w-full overflow-hidden"
                        id={`${id}-panel`}
                        initial={reduceMotion ? false : { opacity: 0 }}
                        key={active}
                        role="tabpanel"
                        transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
                    >
                        <motion.img
                            alt={`Lunora Studio — ${VIEWS[active].label}`}
                            animate={{ scale: 1 }}
                            className="size-full object-cover object-top"
                            height={1252}
                            initial={reduceMotion ? false : { scale: 1.015 }}
                            src={VIEWS[active].image}
                            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                            width={2048}
                        />
                    </motion.div>
                </div>

                <p className="mt-5 max-w-[52ch] text-blurb text-ink-muted">{VIEWS[active].blurb}</p>
            </div>
        </Section>
    );
};

export default Studio;
