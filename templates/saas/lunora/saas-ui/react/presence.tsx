"use client";

import type { ReactNode } from "react";

import type { PresenceMemberLike } from "../core";
import { initials, presenceRoster, presenceSummary } from "../core";

interface PresenceBarProps {
    /** How many avatars to show before collapsing into a `+N`. */
    cap?: number;
    /** The viewer, so their own entry can be labelled and sorted first. */
    currentUserId: string | undefined;
    /** `listPresent`'s rows. `undefined` while the subscription is connecting. */
    members: ReadonlyArray<PresenceMemberLike> | undefined;
}

/**
 * Who is looking at this page right now.
 *
 * This is the kit's one screen that could not be built on a request/response
 * backend at all — not "would be slower", could not. It takes rows as props like
 * everything else here; the route owns `usePresence`, which heartbeats and
 * subscribes.
 */
const PresenceBar = ({ cap, currentUserId, members }: PresenceBarProps): ReactNode => {
    if (!members) {
        return <div aria-busy="true" className="lu-saas-presence lu-saas-presence--loading" />;
    }

    const roster = presenceRoster(members, currentUserId, cap);

    return (
        <div className="lu-saas-presence">
            <ul className="lu-saas-presence__list">
                {roster.entries.map((entry) => (
                    <li
                        className={entry.isSelf ? "lu-saas-avatar lu-saas-avatar--self" : "lu-saas-avatar"}
                        key={entry.key}
                        title={entry.isSelf ? `${entry.name} (you)` : entry.name}
                    >
                        {initials(entry.name)}
                    </li>
                ))}
                {roster.overflow > 0 ? <li className="lu-saas-avatar lu-saas-avatar--more">+{roster.overflow}</li> : undefined}
            </ul>
            <span className="lu-saas-presence__summary">{presenceSummary(roster)}</span>
        </div>
    );
};

export type { PresenceBarProps };
export { PresenceBar };
