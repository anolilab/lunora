import { ArrowRight, Check, Minus, X } from "lucide-react";
import type { FC, ReactNode } from "react";

import { Action } from "@/kit/action";
import { Kicker, Section, SectionHeader, Shell } from "@/kit/layout";
import { cn } from "@/lib/utils";
import { COMPARISONS } from "@/pages/compare/data";

/**
 * A condensed version of the comparison table, on the landing page.
 *
 * Rows are read from `pages/compare/data.ts` rather than restated here, so the
 * landing page cannot drift away from the verified comparison it links to.
 * Only the criteria a reader weighs before clicking through are shown; the full
 * matrix stays on /compare.
 */

// The criteria that actually decide adoption. The rest (data model, maturity)
// need the nuance of the full page and read as spin when compressed to a cell.
const CRITERIA = [
    "End-to-end TypeScript types",
    "Reactive queries by default",
    "Edge / global by default",
    "Self-host with no servers to run",
    "≈$0 at idle, no forced pause",
];

const RIVALS = ["convex", "supabase", "firebase"] as const;

/**
 * Accent marks the subject column only. Colouring every vendor's "yes" the
 * same turned the table into a field of cyan and buried whose column it is.
 */
const icon = (tone: string | undefined, subject: boolean): ReactNode => {
    if (tone === "yes") {
        return <Check className={cn("size-3.5", subject ? "text-accent" : "text-ink-muted")} />;
    }

    if (tone === "no") {
        return <X className="size-3.5 text-ink-faint" />;
    }

    return <Minus className="size-3.5 text-ink-faint" />;
};

const CompareBand: FC = () => {
    const rivals = RIVALS.map((slug) => COMPARISONS[slug]).filter(Boolean);

    return (
        <Section id="compare">
            <Shell>
                <SectionHeader
                    index="06"
                    label="Compare"
                    note="The full matrix, including where they win, is on the comparison pages."
                    title="Where Lunora differs"
                >
                    <p className="text-body text-ink-muted">
                        Same reactive, typed model as the best of them. The difference is where it runs and who sends the bill.
                    </p>
                </SectionHeader>

                {/* A table, not a grid of cards: these are values compared across
                    a shared axis, which is the one thing a table does better. */}
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[44rem] border-collapse text-left">
                        <thead>
                            <tr className="border-b border-hairline">
                                <th className="py-4 pr-6" scope="col">
                                    <Kicker>Capability</Kicker>
                                </th>
                                <th className="py-4 pr-6" scope="col">
                                    <Kicker tone="accent">Lunora</Kicker>
                                </th>
                                {rivals.map((rival) => (
                                    <th className="py-4 pr-6" key={rival.slug} scope="col">
                                        <Kicker>{rival.name}</Kicker>
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {CRITERIA.map((criterion) => {
                                const lunora = rivals[0]?.rows.find((row) => row.criterion === criterion)?.lunora;

                                return (
                                    <tr className="border-b border-hairline last:border-b-0" key={criterion}>
                                        <th className="py-4 pr-6 text-blurb font-normal text-ink" scope="row">
                                            {criterion}
                                        </th>
                                        <td className="py-4 pr-6">
                                            <span className="flex items-center gap-2 text-blurb text-ink">
                                                {icon(lunora?.tone, true)}
                                                {lunora?.label}
                                            </span>
                                        </td>
                                        {rivals.map((rival) => {
                                            const cell = rival.rows.find((row) => row.criterion === criterion)?.them;

                                            return (
                                                <td className="py-4 pr-6" key={rival.slug}>
                                                    <span
                                                        className={cn(
                                                            "flex items-center gap-2 text-blurb",
                                                            cell?.tone === "yes" ? "text-ink-muted" : "text-ink-faint",
                                                        )}
                                                    >
                                                        {icon(cell?.tone, false)}
                                                        {cell?.label}
                                                    </span>
                                                </td>
                                            );
                                        })}
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>

                <div className="mt-10">
                    <Action to="/compare">
                        See the full comparison
                        <ArrowRight className="size-4" />
                    </Action>
                </div>
            </Shell>
        </Section>
    );
};

export default CompareBand;
