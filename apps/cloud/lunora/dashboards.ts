import { LunoraError } from "@lunora/server";

import type { DashboardPanel } from "../src/telemetry/dashboards";
import { validatePanels } from "../src/telemetry/dashboards";
import type { Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";
import { assertMember, assertRowInOrg } from "./authz";
import { rateLimit } from "./guards";
import { boundedString, LIMITS } from "./validators";

/**
 * User-defined custom dashboards (Tier 2 observability) — Grafana-style saved
 * boards over the org's telemetry. A dashboard holds an ordered list of panels;
 * each panel is a saved query over data the console already serves (a metric
 * trend, a single stat, or a saved Traces/Logs filter shortcut). No new backend:
 * the panels render from `metrics.list` and the Traces/Logs deep-links.
 *
 * Org-scoped like every sibling: reads are members-only; writes (create/update/
 * remove) are owners/admins (the same gate `lunora/alerts.ts` uses). Panel
 * shaping (add/remove/reorder + validation) is the pure `src/telemetry/dashboards`
 * model — the client mutates panels with those reducers and sends the whole array
 * back, which this file re-validates before persisting.
 */

/** A panel as the dashboard wire view carries it — mirrors {@link DashboardPanel} locally so codegen inlines it. */
interface DashboardPanelView {
    config: {
        filter?: string;
        metricName?: string;
        stat?: "count" | "first" | "last";
    };
    id: string;
    kind: "logs" | "metric" | "stat" | "traces";
    title: string;
}

/** One dashboard as the client consumes it (identity + ordered panels + timestamps). */
interface DashboardView {
    _id: Id<"dashboards">;
    createdAt: number;
    name: string;
    panels: DashboardPanelView[];
    updatedAt: number;
}

/** The panel-config validator — only the keys a panel's kind uses are ever set. */
const panelConfig = v.object({
    filter: v.optional(v.string()),
    metricName: v.optional(v.string()),
    stat: v.optional(v.union(v.literal("last"), v.literal("first"), v.literal("count"))),
});

/** The panel validator shared by `create`/`update` inputs. */
const panel = v.object({
    config: panelConfig,
    id: v.string(),
    kind: v.union(v.literal("metric"), v.literal("stat"), v.literal("traces"), v.literal("logs")),
    title: v.string(),
});

/** Project a stored dashboard row onto the wire view. */
const toView = (row: DashboardRow): DashboardView => {
    return {
        _id: row._id,
        createdAt: row.createdAt,
        name: row.name,
        panels: row.panels.map((current) => {
            return {
                config: {
                    ...(current.config.filter === undefined ? {} : { filter: current.config.filter }),
                    ...(current.config.metricName === undefined ? {} : { metricName: current.config.metricName }),
                    ...(current.config.stat === undefined ? {} : { stat: current.config.stat }),
                },
                id: current.id,
                kind: current.kind,
                title: current.title,
            };
        }),
        updatedAt: row.updatedAt,
    };
};

/** The stored dashboard row shape (the columns `findMany`/`get` return). */
interface DashboardRow {
    _id: Id<"dashboards">;
    createdAt: number;
    name: string;
    organizationId: Id<"organizations">;
    panels: DashboardPanel[];
    updatedAt: number;
}

/** Reject a blank dashboard name up front (shared by create/update). */
const requireName = (name: string): string => {
    const trimmed = name.trim();

    if (trimmed === "") {
        throw new LunoraError("BAD_REQUEST", "dashboard name is required");
    }

    return trimmed;
};

/** Re-validate panels on the server (the client validates too) before persisting. */
const requireValidPanels = (panels: ReadonlyArray<DashboardPanel>): void => {
    const error = validatePanels(panels);

    if (error !== null) {
        throw new LunoraError("BAD_REQUEST", error);
    }
};

/** An org's dashboards, most-recent first (any member). */
export const list = query
    .input({ organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { organizationId } }): Promise<DashboardView[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.dashboards.findMany({ where: { organizationId } });

        return page.toSorted((a, b) => b.createdAt - a.createdAt).map((row) => toView(row));
    });

/** One dashboard by id, org-checked (any member). `null` when it isn't in the org. */
export const get = query
    .input({ id: v.id("dashboards"), organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { id, organizationId } }): Promise<DashboardView | null> => {
        await assertMember(context, organizationId);

        const row = (await context.db.get(id)) as DashboardRow | null;

        if (row?.organizationId !== organizationId) {
            return null;
        }

        return toView(row);
    });

/** Create a named dashboard (owners/admins). Starts with the given panels (usually none). */
export const create = mutation
    .use(rateLimit("api"))
    .input({
        name: boundedString(LIMITS.name),
        organizationId: v.id("organizations"),
        panels: v.optional(v.array(panel)),
    })
    .mutation(async ({ ctx: context, args }): Promise<Id<"dashboards">> => {
        await assertMember(context, args.organizationId, ["owner", "admin"]);

        const name = requireName(args.name);
        const panels = (args.panels ?? []) as DashboardPanel[];

        requireValidPanels(panels);

        const { now } = context;

        return context.db.insert("dashboards", {
            createdAt: now,
            name,
            organizationId: args.organizationId,
            panels,
            updatedAt: now,
        });
    });

/**
 * Update a dashboard (owners/admins). `name` renames it; `panels` replaces the
 * whole ordered list — the client computes add/remove/reorder with the pure
 * reducers and sends the result, which is re-validated here. Both are optional so
 * a rename and a panel edit are independent calls.
 */
export const update = mutation
    .use(rateLimit("api"))
    .input({
        id: v.id("dashboards"),
        name: v.optional(boundedString(LIMITS.name)),
        organizationId: v.id("organizations"),
        panels: v.optional(v.array(panel)),
    })
    .mutation(async ({ ctx: context, args }): Promise<Id<"dashboards">> => {
        await assertMember(context, args.organizationId, ["owner", "admin"]);
        await assertRowInOrg(context, args.id, args.organizationId, "dashboard");

        const patch: { name?: string; panels?: DashboardPanel[]; updatedAt: number } = { updatedAt: context.now };

        if (args.name !== undefined) {
            patch.name = requireName(args.name);
        }

        if (args.panels !== undefined) {
            const panels = args.panels as DashboardPanel[];

            requireValidPanels(panels);
            patch.panels = panels;
        }

        await context.db.patch(args.id, patch);

        return args.id;
    });

/** Delete a dashboard (owners/admins), org-checked. */
export const remove = mutation
    .use(rateLimit("api"))
    .input({ id: v.id("dashboards"), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { id, organizationId } }): Promise<Id<"dashboards">> => {
        await assertMember(context, organizationId, ["owner", "admin"]);
        await assertRowInOrg(context, id, organizationId, "dashboard");
        await context.db.delete(id);

        return id;
    });
