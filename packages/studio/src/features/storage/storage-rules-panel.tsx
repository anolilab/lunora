import type { ReactElement } from "react";

import ErrorAlert from "../../components/error-alert";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import type { TFunction } from "../../i18n/i18n-context";
import { useT } from "../../i18n/i18n-context";
import type { StorageOperation, StorageRuleMetadata, StorageRulesResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";

/** Localized label per storage operation. */
const operationLabel = (t: TFunction, operation: StorageOperation): string =>
    ({ delete: t("Delete"), list: t("List"), read: t("Read"), write: t("Write") })[operation];

/** Sort key giving a stable read→write→delete→list column/row order. */
const OPERATION_ORDER: Record<StorageOperation, number> = { delete: 2, list: 3, read: 0, write: 1 };

/** Sort the flat rule list by bucket, then operation, then prefix, for a stable render. */
const sortRules = (rules: StorageRuleMetadata[]): StorageRuleMetadata[] =>
    [...rules].toSorted(
        (a, b) => a.bucket.localeCompare(b.bucket) || OPERATION_ORDER[a.on] - OPERATION_ORDER[b.on] || (a.prefix ?? "").localeCompare(b.prefix ?? ""),
    );

/**
 * The Storage Access Rules view — a read-only inspector of the deployment's
 * object-storage authorization (`defineStorageRule` / `storageRules`). Each row
 * shows a `(bucket, operation, key-prefix)` rule and the procedure whose
 * `.use(storageRules(...))` chain declared it.
 *
 * Deliberately read-only: storage rules live in code (the `when` predicate is an
 * opaque closure, never serialized), so the view surfaces the schema's shape for
 * auditing. The metadata is statically discovered by `@lunora/codegen` and
 * served by `__lunora_admin__:storageRules`, refreshing on every codegen run.
 */

const StorageRulesPanel = (): ReactElement => {
    const t = useT();

    const { data, error, errorSource } = useAdminQuery<StorageRulesResult>(ADMIN_FUNCTIONS.storageRules, {});

    // `undefined` until the first read lands; `loaded` gates the empty state so it
    // only shows after a resolved-but-empty read, not during the initial load.
    const loaded = data !== undefined;
    const rules = sortRules(Array.isArray(data?.rules) ? data.rules : []);

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-storage-rules-panel">
            {error !== null && <ErrorAlert error={errorSource} testId="storage-rules-error" />}

            <p className="text-sm text-muted-foreground" data-testid="storage-rules-note">
                {t("Storage rules are declared in code with defineStorageRule and gate ctx.storage access per bucket. This view is read-only.")}
            </p>

            {loaded && rules.length === 0 ? (
                <EmptyState
                    description={t(
                        "No defineStorageRule is wired through .use(storageRules(...)) in this deployment. Add one to gate object access by key prefix.",
                    )}
                    testId="storage-rules-empty"
                    title={t("No storage rules defined")}
                />
            ) : (
                <Card className="overflow-hidden py-0">
                    <CardContent className="px-0">
                        <Table data-testid="storage-rules-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("Bucket")}</TableHead>
                                    <TableHead>{t("Operation")}</TableHead>
                                    <TableHead>{t("Key prefix")}</TableHead>
                                    <TableHead>{t("Guarded by")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rules.map((rule) => (
                                    <TableRow
                                        data-testid={`storage-rule-${rule.bucket}-${rule.on}-${rule.prefix ?? ""}`}
                                        key={`${rule.bucket}:${rule.on}:${rule.prefix ?? ""}:${rule.procedure}`}
                                    >
                                        <TableCell className="font-mono text-xs">{rule.bucket}</TableCell>
                                        <TableCell>
                                            <Badge variant="secondary">{operationLabel(t, rule.on)}</Badge>
                                        </TableCell>
                                        <TableCell className="font-mono text-xs">
                                            {rule.prefix ?? <span className="text-muted-foreground">{t("(whole bucket)")}</span>}
                                        </TableCell>
                                        <TableCell className="font-mono text-xs text-muted-foreground">{rule.procedure}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}
        </div>
    );
};
export default StorageRulesPanel;
