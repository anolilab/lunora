"use client";

import type { FC } from "react";
import { useId, useState } from "react";

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
 * Studio is the part of Lunora that is worth looking at, and a paragraph about
 * it is worth less than one screenshot of it. Tabs let the section carry five
 * views at full width instead of shrinking them into a grid of thumbnails
 * nobody can read.
 *
 * Panels are all mounted and toggled with `hidden` rather than swapped, so
 * switching tabs never waits on an image decode. Only the first is eager; the
 * rest load lazily, so the extra panels cost nothing on first paint.
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

    return (
        <Section id="studio" tone="deep">
            <Shell>
                <SectionHeader action={{ label: "Explore Studio", to: "/studio" }} index="04" label="Studio" title="Look at your backend.">
                    <p className="text-body text-ink-muted">
                        A local admin UI ships with every app and runs against your live edge database. No separate deploy, no read-only mirror.
                    </p>
                </SectionHeader>

                <div className="flex flex-wrap gap-px border-b border-hairline bg-hairline" role="tablist">
                    {VIEWS.map((view, index) => (
                        <button
                            aria-controls={`${id}-panel-${String(index)}`}
                            aria-selected={index === active}
                            className={cn(
                                "flex-1 bg-canvas-deep px-5 py-4 text-left font-mono text-kicker uppercase transition-colors",
                                index === active ? "text-accent" : "text-ink-faint hover:text-ink",
                            )}
                            id={`${id}-tab-${String(index)}`}
                            key={view.label}
                            onClick={() => {
                                setActive(index);
                            }}
                            role="tab"
                            type="button"
                        >
                            {view.label}
                        </button>
                    ))}
                </div>

                {VIEWS.map((view, index) => (
                    <div
                        aria-labelledby={`${id}-tab-${String(index)}`}
                        hidden={index !== active}
                        id={`${id}-panel-${String(index)}`}
                        key={view.label}
                        role="tabpanel"
                    >
                        <img
                            alt={`Lunora Studio — ${view.label}`}
                            className="block w-full border-x border-hairline"
                            loading={index === 0 ? "eager" : "lazy"}
                            src={view.image}
                        />
                        <p className="border border-hairline border-t-0 px-5 py-4 text-blurb text-ink-muted">{view.blurb}</p>
                    </div>
                ))}
            </Shell>
        </Section>
    );
};

export default Studio;
