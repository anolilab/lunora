import { Analytics01Icon, ServerStack01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

import type { BoxView } from "./boxes";
import {
    BOX_STATUS,
    boxHostname,
    FLEET_STATE,
    formatMegabytes,
    OUTDATED_EXPLANATION,
    RESOURCES_NOTE,
    SINGLE_TRUST_EXPLANATION,
    UNCOLLECTED_TELEMETRY,
} from "./boxes";
import { formatDateTime } from "./format";
import { KeyValueList, KeyValueRow, RelativeTime, Row, RowList, SectionLabel, StatusBadge, StatusDot } from "./section-ui";

interface BoxDetailProps {
    box: BoxView;
    /** Owner/admin, on a connected box: show Diagnose. */
    diagnose: boolean;
    /** The apex hostnames live under; `undefined` until known, when only the slug is shown. */
    domain?: string;
    /** Owner/admin: show rename and revoke. */
    manage: boolean;
    onDiagnose: () => void;
    onRename: () => void;
    onRevoke: () => void;
    /** Names of the projects placed on this box. */
    projects: ReadonlyArray<string>;
}

/** A dash for a value the box has not reported (yet). */
const UNREPORTED = "—";

/** Diagnose / Rename / Revoke, for an owner or admin, on a box not yet revoked. */
const BoxActions = ({ box, diagnose, manage, onDiagnose, onRename, onRevoke }: Omit<BoxDetailProps, "domain" | "projects">): ReactElement | null =>
    manage && box.status !== "revoked" ? (
        <div className="flex items-center gap-1">
            {diagnose ? (
                <Button aria-label={`Diagnose ${box.name}`} onClick={onDiagnose} size="sm" type="button" variant="outline">
                    Diagnose
                </Button>
            ) : null}
            <Button aria-label={`Rename ${box.name}`} onClick={onRename} size="sm" type="button" variant="ghost">
                Rename
            </Button>
            <Button
                aria-label={`Revoke ${box.name}`}
                className="text-destructive hover:text-destructive"
                onClick={onRevoke}
                size="sm"
                type="button"
                variant="ghost"
            >
                Revoke
            </Button>
        </div>
    ) : null;

/** Server tile with its status dot, the name, its hostname, and the status pills. */
const BoxHeader = ({ box, diagnose, domain, manage, onDiagnose, onRename, onRevoke }: Omit<BoxDetailProps, "projects">): ReactElement => {
    const status = BOX_STATUS[box.status];

    return (
        <div className="grid gap-3">
            <div className="flex flex-wrap items-start gap-4">
                <div className="relative grid size-12 shrink-0 place-items-center rounded-xl border border-border bg-card shadow-card">
                    <HugeiconsIcon className="size-6 text-muted-foreground" icon={ServerStack01Icon} strokeWidth={1.75} />
                    <StatusDot className="absolute -right-1 -bottom-1 size-3 ring-2 ring-background" tone={status.tone} />
                </div>
                <div className="grid min-w-0 flex-1 gap-0.5">
                    <h2 className="m-0 truncate text-[22px] font-semibold tracking-[-0.02em]">{box.name}</h2>
                    <code className="font-mono text-[13px] break-all text-muted-foreground">
                        {domain === undefined ? box.slug : boxHostname(box.slug, domain)}
                    </code>
                </div>
                <BoxActions box={box} diagnose={diagnose} manage={manage} onDiagnose={onDiagnose} onRename={onRename} onRevoke={onRevoke} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                <span className="font-mono text-xs text-muted-foreground">
                    {box.lastSeenAt === undefined ? (
                        "never seen"
                    ) : (
                        <>
                            last seen <RelativeTime at={box.lastSeenAt} />
                        </>
                    )}
                </span>
                {box.outdated ? <StatusBadge tone="warning">outdated</StatusBadge> : null}
                {box.singleTrust ? <StatusBadge tone="warning">single trust</StatusBadge> : null}
            </div>
            <p className="m-0 text-[13px] text-muted-foreground">{status.description}</p>
        </div>
    );
};

/** Where the box is and what it carries. */
const BoxSystem = ({ box, projects }: Pick<BoxDetailProps, "box" | "projects">): ReactElement => (
    <section className="grid content-start gap-2.5">
        <SectionLabel>System</SectionLabel>
        <KeyValueList>
            <KeyValueRow label="ipv4">{box.ipv4 ?? UNREPORTED}</KeyValueRow>
            {box.ipv6 ? <KeyValueRow label="ipv6">{box.ipv6}</KeyValueRow> : null}
            <KeyValueRow label="enrolled">{box.enrolledAt === undefined ? UNREPORTED : formatDateTime(box.enrolledAt)}</KeyValueRow>
            <KeyValueRow label="last seen">{box.lastSeenAt === undefined ? "never" : <RelativeTime at={box.lastSeenAt} />}</KeyValueRow>
            <KeyValueRow label="projects">{projects.length === 0 ? <span className="text-muted-foreground">none</span> : projects.join(", ")}</KeyValueRow>
        </KeyValueList>
    </section>
);

/** The agent and the services it runs, as the box reported their versions. */
const BoxAgent = ({ box }: Pick<BoxDetailProps, "box">): ReactElement => (
    <section className="grid content-start gap-2.5">
        <SectionLabel>Agent</SectionLabel>
        <KeyValueList>
            <KeyValueRow label="hostd">{box.versions?.hostd ?? UNREPORTED}</KeyValueRow>
            <KeyValueRow label="celld">
                {box.versions?.celld ?? UNREPORTED}
                {/* `outdated` measures celld against the newest stable release; `false` can
                    also mean no release is known yet, so only the positive finding is shown. */}
                {box.outdated ? <span className="ml-2 text-warning">outdated</span> : null}
            </KeyValueRow>
            <KeyValueRow label="caddy">{box.versions?.caddy ?? UNREPORTED}</KeyValueRow>
        </KeyValueList>
    </section>
);

/** Available memory and free disk, as the agent reported them on connecting. */
const BoxResources = ({ box }: Pick<BoxDetailProps, "box">): ReactElement => (
    <section className="grid content-start gap-2.5">
        <SectionLabel>Resources</SectionLabel>
        <KeyValueList>
            {/* `memMb` is the kernel's MemAvailable: memory free for use, not memory used. */}
            <KeyValueRow label="memory available">{box.resources ? formatMegabytes(box.resources.memMb) : UNREPORTED}</KeyValueRow>
            {/* `diskFreeMb` is measured under hostd's data directory only, not every mount. */}
            <KeyValueRow label="disk free (data dir)">{box.resources ? formatMegabytes(box.resources.diskFreeMb) : UNREPORTED}</KeyValueRow>
        </KeyValueList>
        <p className="m-0 text-xs text-muted-foreground">{RESOURCES_NOTE}</p>
    </section>
);

/** The celld fleets the box runs, as it last reported them. */
const BoxFleets = ({ box }: Pick<BoxDetailProps, "box">): ReactElement => {
    const fleets = box.fleets ?? [];

    return (
        <section className="grid content-start gap-2.5">
            <SectionLabel count={fleets.length}>Fleets</SectionLabel>
            {fleets.length === 0 ? (
                <p className="m-0 text-[13px] text-muted-foreground">No fleets reported yet.</p>
            ) : (
                <RowList>
                    {fleets.map((fleet) => {
                        const state = FLEET_STATE[fleet.state];

                        return (
                            <Row className="flex-wrap gap-2.5 text-[13px]" key={fleet.alias}>
                                <code className="font-mono">{fleet.alias}</code>
                                <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
                                <span className="ml-auto truncate font-mono text-xs text-muted-foreground">{fleet.deploymentId ?? "nothing deployed"}</span>
                            </Row>
                        );
                    })}
                </RowList>
            )}
        </section>
    );
};

/** The findings that need a sentence: outdated, single trust, a DNS failure. */
const BoxFindings = ({ box }: Pick<BoxDetailProps, "box">): ReactElement | null =>
    box.outdated || box.singleTrust || box.dnsError ? (
        <section className="grid gap-2 rounded-xl border border-border bg-muted/20 p-4">
            {box.outdated ? <p className="m-0 text-[13px] text-warning">{OUTDATED_EXPLANATION}</p> : null}
            {box.singleTrust ? <p className="m-0 text-[13px] text-muted-foreground">{SINGLE_TRUST_EXPLANATION}</p> : null}
            {box.dnsError ? (
                <p className="m-0 text-[13px] text-destructive" role="status">
                    DNS: {box.dnsError}
                </p>
            ) : null}
        </section>
    ) : null;

/** The charts this panel would hold, said plainly to be absent: the agent does not collect them. */
const BoxTelemetryEmpty = (): ReactElement => (
    <section className="grid content-start gap-2.5">
        <SectionLabel>Metrics</SectionLabel>
        <Empty className="rounded-xl border border-dashed border-border py-8">
            <EmptyHeader>
                <EmptyMedia variant="icon">
                    <HugeiconsIcon icon={Analytics01Icon} strokeWidth={2} />
                </EmptyMedia>
                <EmptyTitle>No host metrics yet</EmptyTitle>
                <EmptyDescription>
                    The box agent does not collect these today, so there is nothing to chart: {UNCOLLECTED_TELEMETRY.join(", ")}.
                </EmptyDescription>
            </EmptyHeader>
        </Empty>
    </section>
);

/**
 * One box in full, from the fields the control plane really has: status and last
 * seen, the agent's versions and outdated finding, its addresses and projects, the
 * memory/disk reading from its last connect, its fleets — and an explicit empty
 * state where host metrics would go, because the agent does not collect them.
 */
export const BoxDetail = ({ box, diagnose, domain, manage, onDiagnose, onRename, onRevoke, projects }: BoxDetailProps): ReactElement => (
    <div className="grid content-start gap-6">
        <BoxHeader box={box} diagnose={diagnose} domain={domain} manage={manage} onDiagnose={onDiagnose} onRename={onRename} onRevoke={onRevoke} />
        <BoxFindings box={box} />
        <div className="grid items-start gap-6 xl:grid-cols-2">
            <BoxSystem box={box} projects={projects} />
            <BoxAgent box={box} />
            <BoxResources box={box} />
            <BoxFleets box={box} />
        </div>
        <BoxTelemetryEmpty />
    </div>
);
