import type { ReactElement } from "react";

import { OPT_IN_LADDER, TOOL_LEVEL } from "../../../../../shared/ai-chat";
import ErrorAlert from "../../components/error-alert";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import type { MessageId, TFunction } from "../../i18n/i18n-context";
import { useT } from "../../i18n/i18n-context";
import type { AiAvailableResult, AiOptInLevel, DeployInfo, SettingEntry, SettingsResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { CLOUDFLARE_WORKERS_URL } from "../../lib/cf-links";
import type { Shortcuts } from "../../lib/shortcuts";
import { resetShortcuts, setShortcut, useShortcuts } from "../../lib/shortcuts";

interface SettingsPanelProps {
    /** Shard key the settings read targets on first load. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

/** Badge tone per setting kind, so secrets read as the most guarded. */
const KIND_VARIANT: Record<SettingEntry["kind"], "destructive" | "outline" | "secondary"> = {
    binding: "outline",
    secret: "destructive",
    var: "secondary",
};

/** The deployment facts that are actually present, as label/value rows. Absent fields are omitted rather than rendered blank. */
const toDeployRows = (deploy: DeployInfo | undefined, t: TFunction): { label: string; value: string }[] => {
    if (deploy === undefined) {
        return [];
    }

    const rows: { label: string; value: string }[] = [];

    if (deploy.workerUrl !== undefined) {
        rows.push({ label: t("URL"), value: deploy.workerUrl });
    }

    if (deploy.environment !== undefined) {
        rows.push({ label: t("Environment"), value: deploy.environment });
    }

    if (deploy.deploymentId !== undefined) {
        rows.push({ label: t("Deployment"), value: deploy.deploymentId });
    }

    if (deploy.versionTag !== undefined) {
        rows.push({ label: t("Version"), value: deploy.versionTag });
    }

    return rows;
};

/**
 * What each rung of the data-sharing ladder lets the assistant read.
 *
 * An exhaustive `Record` over the closed union, so a tier added to the ladder in
 * `shared/ai-chat.ts` is a compile error here rather than a rung that renders
 * blank. The tools a tier unlocks are NOT restated — they are derived from
 * `TOOL_LEVEL` below, which is the map the server gates on.
 */
const LEVEL_SUMMARY: Readonly<Record<AiOptInLevel, MessageId>> = {
    disabled: "The assistant is off. Nothing about this deployment is sent to a model.",
    schema: "Table and column names.",
    schema_and_log: "Table and column names, plus recent log lines.",
    schema_and_log_and_data: "Table and column names, log lines, and rows read with SELECT.",
};

/** The tools a tier unlocks, read from the server's own gate map so the two cannot drift. */
const toolsAt = (level: AiOptInLevel): string[] => {
    const tools: string[] = [];

    for (const [tool, tier] of Object.entries(TOOL_LEVEL)) {
        if (tier === level) {
            tools.push(tool);
        }
    }

    return tools;
};

/**
 * The deployment's AI data-sharing level, and the ladder it sits on.
 *
 * **Here rather than beside the assistant**, which was the other candidate: the
 * lowest rung HIDES every assistant surface, so an operator on `disabled` — the
 * one most likely to be wondering why the assistant is missing — could never
 * reach a readout that lived inside it. Settings is also already the read-only
 * view of exactly this kind of thing: a wrangler var the studio shows and cannot
 * edit.
 *
 * Strictly a readout. The level is decided server-side (`LUNORA_AI_OPT_IN`, read
 * by the worker that serves the chat op) and there is deliberately no control
 * here — a level the browser could raise would not be a gate.
 */
const DataSharingCard = (): ReactElement => {
    const t = useT();

    // The same op, args and shard the assistant provider asks on mount, so
    // TanStack serves both from one cache entry rather than probing twice.
    const { data } = useAdminQuery<AiAvailableResult>(ADMIN_FUNCTIONS.aiAvailable, {}, { shardKey: "" });
    const level = data?.level;
    const at = level === undefined ? -1 : OPT_IN_LADDER.indexOf(level);

    return (
        <Card className="py-0" data-testid="set-ai-sharing">
            <header className="flex items-center justify-between border-b border-border px-4 py-3">
                <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("AI assistant data sharing")}</span>
                {level !== undefined && (
                    <Badge data-testid="set-ai-level" variant={level === "disabled" ? "outline" : "secondary"}>
                        {level}
                    </Badge>
                )}
            </header>
            <CardContent className="flex flex-col gap-3 py-3">
                <ul className="flex flex-col gap-1.5 text-sm">
                    {OPT_IN_LADDER.map((tier, rung) => {
                        const granted = at >= rung;
                        const tools = toolsAt(tier);

                        return (
                            <li
                                className={granted ? "flex flex-col gap-0.5" : "flex flex-col gap-0.5 opacity-50"}
                                data-granted={String(granted)}
                                data-testid={`set-ai-tier-${tier}`}
                                key={tier}
                            >
                                <span className="flex items-center gap-2">
                                    <span className="font-mono text-xs">{tier}</span>
                                    {tier === level && <span className="text-[11px] text-primary">{t("current")}</span>}
                                </span>
                                <span className="text-xs text-muted-foreground">{t(LEVEL_SUMMARY[tier])}</span>
                                {tools.length > 0 && <span className="font-mono text-[11px] text-muted-foreground">{tools.join(", ")}</span>}
                            </li>
                        );
                    })}
                </ul>
                <p className="text-xs text-muted-foreground" data-testid="set-ai-howto">
                    {t("Set LUNORA_AI_OPT_IN in wrangler.jsonc and redeploy to change this. The Studio can read this level but never raise it.")}
                </p>
            </CardContent>
        </Card>
    );
};

/**
 * Read-only **Settings** view of the deployment's config: the Worker vars,
 * secrets, and bindings exposed via `env`, plus best-effort deploy metadata.
 * Reads the `__lunora_admin__:getSettings` RPC via {@link useAdminQuery} (gated
 * by the server's `LUNORA_ADMIN_TOKEN`).
 *
 * Strictly view-only: secret values are masked server-side and never returned
 * raw, and there is no editing here. The infrastructure plane lives in
 * Cloudflare/wrangler — a deep-link to the Cloudflare dashboard is provided so
 * you can edit there. Deployment config is static at runtime (it only changes on
 * redeploy), so this loads once on mount — there is no live channel or poll.
 */

/**
 * One rebindable shortcut: its label, its fixed modifier, and a capture box.
 *
 * Only the KEY is rebindable, never the modifiers. Those carry constraints the
 * operator cannot see — the console is Ctrl-only because macOS owns ⌘` as
 * "cycle this app's windows" — so offering them as a choice would offer bindings
 * that silently never fire.
 */
const ShortcutRow = ({ modifier, name, label }: { readonly label: string; readonly modifier: string; readonly name: keyof Shortcuts }): ReactElement => {
    const shortcuts = useShortcuts();

    const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
        // Tab, Shift-Tab and Escape are NOT consumed: swallowing them made this box
        // a keyboard trap (WCAG 2.1.2) — a keyboard or screen-reader user who
        // focused it could not leave without a pointer.
        if (["Escape", "Tab"].includes(event.key)) {
            return;
        }

        // A binding that needs Shift can never fire: `useConsoleShortcut` requires
        // `!event.shiftKey`, so storing `?` would produce a shortcut the operator
        // cannot trigger and cannot see is broken.
        if (event.shiftKey) {
            event.preventDefault();

            return;
        }

        event.preventDefault();
        setShortcut(name, event.key);
    };

    return (
        <div className="contents" data-testid={`set-shortcut-${name}`}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="flex items-center gap-1.5">
                <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{modifier}</kbd>
                <input
                    aria-label={label}
                    className="h-7 w-12 rounded-md border border-border bg-background text-center font-mono text-xs uppercase outline-none focus-visible:border-ring"
                    data-testid={`set-shortcut-input-${name}`}
                    onKeyDown={onKeyDown}
                    readOnly
                    value={shortcuts[name]}
                />
            </dd>
        </div>
    );
};

export const SettingsPanel = ({ initialShardKey }: SettingsPanelProps): ReactElement => {
    const t = useT();

    // Deployment config is static at runtime (it only changes on redeploy), so a
    // plain one-shot read with no live channel.
    const {
        data: result,
        error,
        errorSource,
        isLoading: loading,
    } = useAdminQuery<SettingsResult>(ADMIN_FUNCTIONS.getSettings, {}, { shardKey: initialShardKey ?? "" });

    const deployRows = toDeployRows(result?.deploy, t);

    const settings = result?.settings ?? [];

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-settings">
            <div className="flex flex-wrap items-center gap-3">
                <a
                    className="text-sm text-primary underline-offset-4 hover:underline"
                    data-testid="set-cf-link"
                    href={CLOUDFLARE_WORKERS_URL}
                    rel="noreferrer"
                    target="_blank"
                >
                    {t("Open in Cloudflare")}
                </a>
            </div>

            <p className="text-sm text-muted-foreground" data-testid="set-readonly-note">
                {t("View-only — values are masked. Edit vars, secrets, and bindings in wrangler or the Cloudflare dashboard.")}
            </p>

            {error !== null && <ErrorAlert error={errorSource} testId="set-error" />}

            {deployRows.length > 0 && (
                <Card className="py-0" data-testid="set-deploy">
                    <header className="border-b border-border px-4 py-3">
                        <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Deployment")}</span>
                    </header>
                    <CardContent className="py-3">
                        <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                            {deployRows.map((row) => (
                                <div className="contents" data-testid="set-deploy-row" key={row.label}>
                                    <dt className="text-muted-foreground">{row.label}</dt>
                                    <dd className="truncate font-mono text-xs" title={row.value}>
                                        {row.value}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    </CardContent>
                </Card>
            )}

            <DataSharingCard />

            {/* Browser preferences, not deployment config — everything above this
                card is served by the worker and read-only; everything in it lives
                in this browser and is the only thing on the page an operator can
                actually change. */}
            <Card className="py-0" data-testid="set-preferences">
                <header className="flex items-center justify-between border-b border-border px-4 py-3">
                    <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Keyboard shortcuts")}</span>
                    <button
                        className="rounded px-1 text-[11px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
                        data-testid="set-shortcut-reset"
                        onClick={resetShortcuts}
                        type="button"
                    >
                        {t("Reset")}
                    </button>
                </header>
                <CardContent className="py-3">
                    <dl className="grid grid-cols-[10rem_minmax(0,1fr)] items-center gap-x-4 gap-y-2 text-sm">
                        <ShortcutRow label={t("Command palette")} modifier="⌘/Ctrl" name="palette" />
                        <ShortcutRow label={t("Operation console")} modifier="Ctrl" name="console" />
                    </dl>
                    <p className="pt-3 text-xs text-muted-foreground">{t("Stored in this browser. Focus a box and press a key to rebind it.")}</p>
                </CardContent>
            </Card>

            <Card className="py-0">
                <header className="border-b border-border px-4 py-3">
                    <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Environment & bindings")}</span>
                </header>

                {error === null && !loading && settings.length === 0 && (
                    <p className="px-4 py-8 text-center text-sm text-muted-foreground" data-testid="set-empty">
                        {t("No environment variables or bindings.")}
                    </p>
                )}

                {settings.length > 0 && (
                    <CardContent className="px-0 py-0">
                        <Table data-testid="set-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("name")}</TableHead>
                                    <TableHead>{t("kind")}</TableHead>
                                    <TableHead>{t("value")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {settings.map((entry) => (
                                    <TableRow data-testid="set-row" key={entry.name}>
                                        <TableCell className="font-mono text-xs font-medium">{entry.name}</TableCell>
                                        <TableCell>
                                            <Badge variant={KIND_VARIANT[entry.kind]}>{entry.bindingType ?? entry.kind}</Badge>
                                        </TableCell>
                                        <TableCell className="max-w-[28ch] truncate font-mono text-xs text-muted-foreground">
                                            {entry.value ?? <span className="text-muted-foreground">—</span>}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </CardContent>
                )}
            </Card>
        </div>
    );
};

export type { SettingsPanelProps };
