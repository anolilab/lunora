"use client";

import type { ReactNode } from "react";

import type { OverviewPayload } from "../core";
import { deriveOverviewStats, isFirstRun } from "../core";
import { Empty } from "./primitives";

interface OverviewProps {
    /**
     * The clock, injected. Every screen here takes it rather than calling
     * `Date.now()`, so a server render and the hydration after it agree, and a
     * test asserts a string instead of racing one.
     */
    now: number;
    /** What `api.saas.overview` resolved to. `undefined` while it is loading. */
    payload: OverviewPayload | undefined;
}

/**
 * The dashboard's stat row.
 *
 * It takes rows as a prop and never calls `useQuery` itself. That is the rule
 * for every component in this directory: the adapter differs per framework and
 * the wiring differs per meta-framework, so a component that fetches is one
 * that cannot be rendered in a story, a test, or somebody else's route. The
 * template shell owns the subscription; these own the pixels.
 */
const OverviewStats = ({ now, payload }: OverviewProps): ReactNode => {
    if (!payload) {
        return <div aria-busy="true" className="lu-saas-stats lu-saas-stats--loading" />;
    }

    if (isFirstRun(payload)) {
        return (
            <Empty title="Nothing here yet">
                <p>Create your first project and this dashboard fills in — live, in every tab you have open.</p>
            </Empty>
        );
    }

    return (
        <div className="lu-saas-stats">
            {deriveOverviewStats(payload, now).map((tile) => (
                <div className="lu-saas-stat" key={tile.id}>
                    <span className="lu-saas-stat__value">{tile.value}</span>
                    <span className="lu-saas-stat__label">{tile.label}</span>
                    {tile.note ? <span className="lu-saas-stat__note">{tile.note}</span> : undefined}
                </div>
            ))}
        </div>
    );
};

export type { OverviewProps };
export { OverviewStats };
