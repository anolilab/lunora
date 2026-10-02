import type { ReactElement, ReactNode } from "react";

import { Button } from "@/components/ui/button";

import type { BoxView } from "./boxes";
import { BOX_STATUS, boxHostname, formatMegabytes, OUTDATED_EXPLANATION, SINGLE_TRUST_EXPLANATION } from "./boxes";
import { COLUMN_LABEL } from "./section-styles";
import { RelativeTime, StatusBadge } from "./section-ui";

interface BoxListItemProps {
    box: BoxView;
    /** The apex hostnames live under; `undefined` until known, when only the slug is shown. */
    domain?: string;
    /** Owner/admin: show rename and revoke. */
    manage: boolean;
    onRename: () => void;
    onRevoke: () => void;
    /** Names of the projects placed on this box. */
    projects: ReadonlyArray<string>;
}

/** One label/value pair of the facts grid. */
const Fact = ({ children, label }: { children: ReactNode; label: string }): ReactElement => (
    <div className="grid min-w-0 gap-0.5">
        <dt className={`${COLUMN_LABEL} text-muted-foreground`}>{label}</dt>
        <dd className="m-0 truncate text-sm">{children}</dd>
    </div>
);

/** Name, state chips and — for an owner/admin, on a box not yet revoked — its actions. */
const BoxHeading = ({ box, manage, onRename, onRevoke }: Pick<BoxListItemProps, "box" | "manage" | "onRename" | "onRevoke">): ReactElement => {
    const status = BOX_STATUS[box.status];

    return (
        <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{box.name}</span>
            <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
            {box.outdated ? <StatusBadge tone="warning">outdated</StatusBadge> : null}
            {box.singleTrust ? <StatusBadge tone="warning">single trust</StatusBadge> : null}
            {manage && box.status !== "revoked" ? (
                <span className="ml-auto flex items-center gap-1">
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
                </span>
            ) : null}
        </div>
    );
};

/** What the box runs and has to spare, as last reported. A dash is a value the box has not reported yet. */
const BoxFacts = ({ box, projects }: Pick<BoxListItemProps, "box" | "projects">): ReactElement => (
    <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        <Fact label="hostd">{box.versions?.hostd ?? "—"}</Fact>
        <Fact label="celld">{box.versions?.celld ?? "—"}</Fact>
        <Fact label="Caddy">{box.versions?.caddy ?? "—"}</Fact>
        <Fact label="Last seen">{box.lastSeenAt === undefined ? "never" : <RelativeTime at={box.lastSeenAt} />}</Fact>
        <Fact label="Memory">{box.resources ? formatMegabytes(box.resources.memMb) : "—"}</Fact>
        <Fact label="Disk free">{box.resources ? formatMegabytes(box.resources.diskFreeMb) : "—"}</Fact>
        <Fact label="Address">{box.ipv4 ?? box.ipv6 ?? "—"}</Fact>
        <Fact label="Projects">{projects.length === 0 ? "none" : projects.join(", ")}</Fact>
    </dl>
);

/** The findings that need a sentence: outdated, single trust, a DNS failure. */
const BoxFindings = ({ box }: Pick<BoxListItemProps, "box">): ReactElement => (
    <>
        {box.outdated ? <p className="m-0 text-sm text-warning">{OUTDATED_EXPLANATION}</p> : null}
        {box.singleTrust ? <p className="m-0 text-sm text-muted-foreground">{SINGLE_TRUST_EXPLANATION}</p> : null}
        {box.dnsError ? (
            <p className="m-0 text-sm text-destructive" role="status">
                DNS: {box.dnsError}
            </p>
        ) : null}
    </>
);

/**
 * One box: name and state chips, its hostname, what it runs, and what it has to
 * spare. A revoked box keeps its row (its history is the point) but loses its
 * actions. The outdated, single-trust and DNS findings each carry their own
 * sentence rather than a tooltip, so they are read rather than hovered.
 */
export const BoxListItem = ({ box, domain, manage, onRename, onRevoke, projects }: BoxListItemProps): ReactElement => (
    <li className="grid gap-3 border-b border-border py-4 last:border-b-0">
        <BoxHeading box={box} manage={manage} onRename={onRename} onRevoke={onRevoke} />
        <div className="grid gap-1">
            <code className="font-mono text-sm break-all">{domain === undefined ? box.slug : boxHostname(box.slug, domain)}</code>
            <p className="m-0 text-xs text-muted-foreground">{BOX_STATUS[box.status].description}</p>
        </div>
        <BoxFacts box={box} projects={projects} />
        <BoxFindings box={box} />
    </li>
);
