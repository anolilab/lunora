import type { ReactElement } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import type { TFunction } from "../../i18n/i18n-context";
import type { DanglingReference } from "../../lib/admin";

interface OrphanedObjectsSectionProps {
    /** `true` while the bucket is being enumerated / dangling references resolved. */
    readonly busy: boolean;
    /** Run the orphan check (enumerate the bucket, resolve dangling references). */
    readonly onCheck: () => void;

    /**
     * Record `v.storage()` fields pointing at a missing object. `undefined` means
     * there is NO verdict — the check hasn't been run (it walks the whole bucket, so
     * it isn't automatic), was truncated, or failed. An empty array means the check
     * ran to completion and found none, which is the only input that earns the
     * all-clear.
     */
    readonly references: ReadonlyArray<DanglingReference> | undefined;
    readonly t: TFunction;

    /**
     * `true` when the scan was clipped by a bound. With `references` present the
     * list below is partial; with none, the check never ran against a complete key
     * set and produced no verdict at all.
     */
    readonly truncated: boolean;
}

/**
 * One dangling reference — a record field whose `v.storage()` value points at an
 * object the bucket no longer has. Renders the owning `table·id·column` and the
 * missing key, so an operator can find and fix the record. The inverse of an
 * orphaned object (a file no record references); CF's R2 browser can show neither.
 */
const DanglingRow = ({ reference, t }: { readonly reference: DanglingReference; readonly t: TFunction }): ReactElement => (
    <li
        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2 text-xs"
        data-testid={`fb-dangling-${reference.table}-${reference.id}-${reference.column}`}
    >
        <span className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{`${reference.table}·${reference.id}`}</Badge>
            <span className="text-muted-foreground">{reference.column}</span>
            <span className="text-muted-foreground/60">{t("→")}</span>
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">{reference.key}</code>
        </span>
        <Badge className="border-destructive/40 text-destructive" variant="outline">
            {t("Missing object")}
        </Badge>
    </li>
);

/**
 * The "Orphaned objects" section of the file browser — the half CF structurally
 * cannot show: it correlates the bucket to the schema's `v.storage()` columns.
 * Object→record orphans (a file no record references) are surfaced inline per row
 * by the list/gallery's "Orphan" badge; THIS section surfaces the inverse —
 * **dangling references**, records pointing at an object the bucket no longer has —
 * behind an explicit check (it enumerates the whole bucket, so it isn't automatic).
 *
 * Only rendered when the app declares `v.storage()` columns. Uses {@link EmptyState}
 * for the "checked, none found" case.
 */
export const OrphanedObjectsSection = ({ busy, onCheck, references, t, truncated }: OrphanedObjectsSectionProps): ReactElement => (
    <section className="flex flex-col gap-2 rounded-lg border border-border/60 p-3" data-testid="fb-orphans">
        <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-col gap-1">
                <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">{t("Integrity")}</span>
                <span className="text-sm font-medium text-foreground">{t("Orphaned objects")}</span>
                <span className="text-xs text-muted-foreground">{t("Find records whose file reference points at an object the bucket no longer has.")}</span>
            </div>
            <Button data-testid="fb-orphans-check" disabled={busy} onClick={onCheck} size="sm" type="button" variant="outline">
                {busy ? t("Checking…") : t("Check for orphans")}
            </Button>
        </div>

        {/* The truncation notice lives OUTSIDE the results branch: the case it exists
            for is a scan that produced no rows precisely because it checked nothing,
            and nesting it under `length > 0` made it unreachable exactly there. */}
        {truncated && (
            <p className="text-xs text-warning" data-testid="fb-orphans-truncated">
                {references === undefined || references.length === 0
                    ? t("The bucket is larger than the scan's key limit, so dangling references could not be checked.")
                    : t("Showing the first {count} dangling references — the scan was truncated.", { count: references.length })}
            </p>
        )}

        {/* Only a completed check that found nothing earns the all-clear. */}
        {references?.length === 0 && !truncated && (
            <EmptyState
                description={t("Every record's file reference points at an object that exists in the bucket.")}
                testId="fb-orphans-empty"
                title={t("No dangling references.")}
            />
        )}

        {references !== undefined && references.length > 0 && (
            <ul className="flex flex-col gap-1.5" data-testid="fb-orphans-list">
                {references.map((reference) => (
                    <DanglingRow key={`${reference.table}·${reference.id}·${reference.column}`} reference={reference} t={t} />
                ))}
            </ul>
        )}
    </section>
);

export type { OrphanedObjectsSectionProps };
