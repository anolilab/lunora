import type { ReactElement, ReactNode } from "react";

import { Button } from "@/components/ui/button";

import type { BoxFleet, BoxView } from "./boxes";
import { BOX_STATUS, boxHostname, FLEET_STATE, formatMegabytes, OUTDATED_EXPLANATION, SINGLE_TRUST_EXPLANATION } from "./boxes";
import { COLUMN_LABEL } from "./section-styles";
import { RelativeTime, StatusBadge } from "./section-ui";

interface BoxListItemProps {
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

/** One label/value pair of the facts grid. */
const Fact = ({ children, label }: { children: ReactNode; label: string }): ReactElement => (
    <div className="grid min-w-0 gap-0.5">
        <dt className={`${COLUMN_LABEL} text-muted-foreground`}>{label}</dt>
        <dd className="m-0 truncate text-sm">{children}</dd>
    </div>
);

/** Name, state chips and — for an owner/admin, on a box not yet revoked — its actions. */
const BoxHeading = ({
    box,
    diagnose,
    manage,
    onDiagnose,
    onRename,
    onRevoke,
}: Pick<BoxListItemProps, "box" | "diagnose" | "manage" | "onDiagnose" | "onRename" | "onRevoke">): ReactElement => {
    const status = BOX_STATUS[box.status];

    return (
        <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{box.name}</span>
            <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
            {box.outdated ? <StatusBadge tone="warning">outdated</StatusBadge> : null}
            {box.singleTrust ? <StatusBadge tone="warning">single trust</StatusBadge> : null}
            {manage && box.status !== "revoked" ? (
                <span className="ml-auto flex items-center gap-1">
                    {diagnose ? (
                        <Button aria-label={`Diagnose ${box.name}`} onClick={onDiagnose} size="sm" type="button" variant="ghost">
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

/** One fleet: its alias, the deployment it runs and its state. */
const FleetRow = ({ fleet }: { fleet: BoxFleet }): ReactElement => {
    const state = FLEET_STATE[fleet.state];

    return (
        <li className="flex flex-wrap items-center gap-2 text-sm">
            <code className="font-mono">{fleet.alias}</code>
            <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
            <span className="truncate font-mono text-xs text-muted-foreground">{fleet.deploymentId ?? "nothing deployed"}</span>
        </li>
    );
};

/** The celld fleets the box runs, as it last reported them; nothing until it has reported any. */
const BoxFleets = ({ box }: Pick<BoxListItemProps, "box">): ReactElement | null => {
    if (box.fleets === undefined || box.fleets.length === 0) {
        return null;
    }

    return (
        <div className="grid gap-1.5">
            <p className={`${COLUMN_LABEL} m-0 text-muted-foreground`}>Fleets</p>
            <ul className="m-0 grid list-none gap-1 p-0">
                {box.fleets.map((fleet) => (
                    <FleetRow fleet={fleet} key={fleet.alias} />
                ))}
            </ul>
        </div>
    );
};

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
 * One box: name and state chips, its hostname, what it runs, what it has to
 * spare, and the celld fleets it reported. A revoked box keeps its row (its history is the point) but loses its
 * actions. The outdated, single-trust and DNS findings each carry their own
 * sentence rather than a tooltip, so they are read rather than hovered.
 */
export const BoxListItem = ({ box, diagnose, domain, manage, onDiagnose, onRename, onRevoke, projects }: BoxListItemProps): ReactElement => (
    <li className="grid gap-3 border-b border-border py-4 last:border-b-0">
        <BoxHeading box={box} diagnose={diagnose} manage={manage} onDiagnose={onDiagnose} onRename={onRename} onRevoke={onRevoke} />
        <div className="grid gap-1">
            <code className="font-mono text-sm break-all">{domain === undefined ? box.slug : boxHostname(box.slug, domain)}</code>
            <p className="m-0 text-xs text-muted-foreground">{BOX_STATUS[box.status].description}</p>
        </div>
        <BoxFacts box={box} projects={projects} />
        <BoxFleets box={box} />
        <BoxFindings box={box} />
    </li>
);
