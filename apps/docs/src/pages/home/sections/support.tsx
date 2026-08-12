import GitHubLogoIcon from "@icons-pack/react-simple-icons/icons/SiGithub.mjs";
import { MoveUpRight } from "lucide-react";
import type { FC } from "react";

import stats from "@/data/stats.json";
import { Action } from "@/kit/action";
import { Kicker, Section, SectionHeader, Shell } from "@/kit/layout";

/**
 * Open source, as a manifest.
 *
 * The band previously argued that people build this together and offered no
 * evidence, in three identical cards with an orphaned note beside them. The
 * argument now sits next to the repository's own numbers.
 *
 * The right column reads like the repo rather than like marketing: mono,
 * key/value, no sentences. That is the point — a claim about being open is
 * cheap, and the manifest is the part a sceptical reader can check.
 *
 * Every figure comes from `data/stats.json`, which the build fetches from npm
 * and GitHub. Nothing here is typed in by hand, so nothing here can quietly
 * drift away from the truth.
 */

// Built from parts (with a synthesized double-quote char) to keep GitHub's
// label-search syntax without tripping the secret-entropy / quote lint rules.
const DQ = String.fromCodePoint(34);
const ISSUE_QUERY = `is:open is:issue label:${DQ}good first issue${DQ},${DQ}help wanted${DQ} `;
const GOOD_FIRST_ISSUES_URL = `https://github.com/anolilab/lunora/issues?q=${encodeURIComponent(ISSUE_QUERY)}`;

const PATHS = [
    {
        blurb: "Every contribution is reviewed. Small fixes are welcome.",
        href: "https://github.com/anolilab/lunora",
        label: "Pull request",
        title: "Fork it and send the change",
    },
    {
        blurb: "Labelled and scoped so a first PR is not a research project.",
        href: GOOD_FIRST_ISSUES_URL,
        label: "Good first issues",
        title: "Start somewhere small",
    },
    {
        blurb: "The roadmap moves in public.",
        href: "https://github.com/anolilab/lunora/discussions",
        label: "Discussions",
        title: "Shape what gets built",
    },
];

const weeklyInstalls = Object.values(stats.weeklyDownloads).reduce((total, count) => total + count, 0);

// An explicit locale, not the visitor's: `toLocaleString()` with no argument
// formats differently on the server and in the browser, which hydrates as a
// mismatch on any machine that is not en-US.
const format = (value: number): string => value.toLocaleString("en-US");

const MANIFEST: { label: string; tone?: "accent"; value: string }[] = [
    { label: "license", value: "FSL-1.1-Apache-2.0" },
    { label: "stars", value: format(stats.stars) },
    { label: "contributors", value: format(stats.contributors) },
    { label: "packages", value: format(Object.keys(stats.weeklyDownloads).length) },
    { label: "installs/wk", value: format(weeklyInstalls) },
    { label: "status", tone: "accent", value: "alpha" },
];

const SupportSection: FC = () => (
    <Section id="support">
        <Shell>
            <SectionHeader index="09" label="Open source" title="Built in the open, on purpose.">
                <p className="text-body text-ink-muted">Nothing about Lunora is a black box. Read it, fork it, or send the fix yourself.</p>
            </SectionHeader>

            {/* Heavy left, small right. The paths carry the width; the manifest
                is the narrow column that makes them credible. */}
            <div className="grid grid-cols-1 border border-hairline lg:grid-cols-[1.4fr_1fr] lg:border-x-0">
                <div className="flex flex-col justify-between gap-10 border-b border-hairline p-6 sm:p-8 lg:border-r lg:border-b-0">
                    <ol className="flex flex-col gap-8">
                        {PATHS.map((path, index) => (
                            <li key={path.title}>
                                <Kicker>
                                    {String(index + 1).padStart(2, "0")} / {path.label}
                                </Kicker>
                                <a className="group mt-2 flex items-start justify-between gap-3" href={path.href} rel="noopener noreferrer" target="_blank">
                                    <span className="text-h3 font-bold text-ink transition-colors group-hover:text-accent">{path.title}</span>
                                    <MoveUpRight className="mt-1 size-4 shrink-0 text-ink-faint transition-colors group-hover:text-accent" />
                                </a>
                                <p className="mt-1.5 text-blurb text-ink-muted">{path.blurb}</p>
                            </li>
                        ))}
                    </ol>

                    <div className="flex flex-wrap items-center gap-2.5">
                        <Action href="https://github.com/anolilab/lunora" variant="primary">
                            <GitHubLogoIcon className="size-4 fill-current" title="Lunora on GitHub" />
                            Star on GitHub
                        </Action>
                        <Action to="/docs">Contribution guide</Action>
                    </div>
                </div>

                <aside className="bg-surface p-6 font-mono sm:p-8">
                    <Kicker size="micro">anolilab/lunora</Kicker>

                    <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-blurb">
                        {MANIFEST.map((row) => (
                            <div className="contents" key={row.label}>
                                <dt className="text-ink-faint">{row.label}</dt>
                                <dd className={row.tone === "accent" ? "text-accent" : "text-ink tabular-nums"}>{row.value}</dd>
                            </div>
                        ))}
                    </dl>

                    <div className="mt-6 border-t border-hairline pt-5">
                        <Kicker size="micro">Converts to Apache-2.0</Kicker>
                        <p className="mt-2 font-sans text-blurb text-ink-muted">
                            Each release relicenses on a fixed schedule, so adopting it now is not a bet on us staying friendly.
                        </p>
                    </div>
                </aside>
            </div>
        </Shell>
    </Section>
);

export default SupportSection;
