"use client";

import type { ReactNode } from "react";

import type { ActivityRow } from "../core";
import { groupActivityByDay, initials } from "../core";
import { Card, Empty } from "./primitives";

interface ActivityFeedProps {
    now: number;
    /** Resolve an actor id to a display name. Defaults to the id itself. */
    resolveActor?: (actorId: string) => string;
    rows: ReadonlyArray<ActivityRow> | undefined;
}

/**
 * The tenant's activity feed, grouped by day.
 *
 * Names are resolved through a prop rather than a second query: members live in
 * better-auth's tables, which are not Lunora tables, so the shell that already
 * has the member list passes a lookup down. Without one the feed shows ids,
 * which is the failure mode the grouping is meant to avoid — so the default is
 * there to keep the component renderable, not because ids are acceptable.
 */
const ActivityFeed = ({ now, resolveActor, rows }: ActivityFeedProps): ReactNode => {
    if (!rows) {
        return (
            <Card title="Activity">
                <div aria-busy="true" className="lu-saas-feed lu-saas-feed--loading" />
            </Card>
        );
    }

    if (rows.length === 0) {
        return (
            <Card title="Activity">
                <Empty title="No activity yet" />
            </Card>
        );
    }

    return (
        <Card title="Activity">
            {groupActivityByDay(rows, now).map((group) => (
                <div className="lu-saas-feed__group" key={group.day}>
                    <h3 className="lu-saas-feed__day">{group.day}</h3>
                    <ul className="lu-saas-feed__list">
                        {group.entries.map((entry) => {
                            const actor = resolveActor?.(entry.actorId) ?? entry.actorId;

                            return (
                                <li className="lu-saas-feed__entry" key={entry.id}>
                                    <span aria-hidden="true" className="lu-saas-avatar">
                                        {initials(actor)}
                                    </span>
                                    <span className="lu-saas-feed__text">
                                        <strong>{actor}</strong> {entry.sentence}
                                    </span>
                                    <time className="lu-saas-feed__when" dateTime={new Date(entry.timestamp).toISOString()}>
                                        {entry.when}
                                    </time>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            ))}
        </Card>
    );
};

export type { ActivityFeedProps };
export { ActivityFeed };
