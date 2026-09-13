import type { ReactElement } from "react";
import { useState } from "react";

import { Card, CardContent } from "../../components/ui/card";
import { useT } from "../../i18n/i18n-context";
import type { RlsOperation } from "../../lib/admin";
import type { FunctionDescriptor } from "../../lib/types";
import { PermissionsMatrix } from "./permissions-matrix";
import { PermissionsPlayground } from "./permissions-playground";
import PolicyScaffolder from "./policy-scaffolder";

interface PermissionsPanelProps {
    /** Functions exposed to the playground; auto-discovered when omitted. */
    readonly functions?: FunctionDescriptor[];

    /**
     * Forward the loopback-dev gate for forging an identity. The matrix is always
     * read-only; the playground's run control is enabled only when this is set.
     */
    readonly runAsIdentity?: boolean;

    /**
     * Loopback-dev gate for the local policy/role scaffolder (plan 025 Item 3).
     * The scaffolder writes to `lunora/` + reruns codegen, so it renders only
     * when set — absent from a deployed/read-only studio. Shares the schema
     * editor's capability flag.
     */
    readonly schemaEditable?: boolean;
}

/**
 * The Permissions page: a read-only {@link PermissionsMatrix} above a live
 * {@link PermissionsPlayground}. Clicking a covered cell's "Probe this"
 * affordance seeds the playground with that cell's covering procedure so the
 * operator can immediately run it under a chosen identity.
 *
 * Cell → procedure is the only safe prefill (a table/operation has no single
 * canonical function), so the matrix passes the covering procedure's registry
 * path (`<file>:<function>`) and the playground selects it.
 */
export const PermissionsPanel = ({ functions, runAsIdentity = false, schemaEditable = false }: PermissionsPanelProps = {}): ReactElement => {
    const t = useT();
    const [prefill, setPrefill] = useState<{ functionPath: string; nonce: number } | undefined>(undefined);

    // The matrix surfaces the covering procedure's REGISTRY PATH per cell
    // (`<file>:<function>`); "Probe this" seeds the playground with it. The bare
    // export name would be a different string from every entry in the function
    // list — the `<select>` would still display the right option (React falls
    // back to the first when the value matches none) while the probe dispatched
    // a path the registry has never heard of. The bumped nonce re-applies on
    // repeat clicks of the same target.
    const onProbe = (_table: string, _operation: RlsOperation, functionPath: string): void => {
        if (functionPath !== "") {
            setPrefill((previous) => {
                return { functionPath, nonce: (previous?.nonce ?? 0) + 1 };
            });
        }
    };

    return (
        <div className="flex flex-col gap-8" data-testid="lunora-permissions">
            <section className="flex flex-col gap-3">
                <header className="border-b border-border px-4 py-3">
                    <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Permissions")}</span>
                </header>
                <PermissionsMatrix onProbe={onProbe} />
            </section>

            <section className="flex flex-col gap-3">
                <Card className="gap-0 py-0">
                    <header className="border-b border-border px-4 py-3">
                        <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Probe")}</span>
                    </header>
                    <CardContent className="px-4 py-4">
                        <p className="mb-3 text-sm text-muted-foreground">{t("Pick a function and an identity, then run it to see the access outcome.")}</p>
                        <PermissionsPlayground functions={functions} prefill={prefill} runAsIdentity={runAsIdentity} />
                    </CardContent>
                </Card>
            </section>

            {schemaEditable && (
                <section className="flex flex-col gap-2">
                    <PolicyScaffolder />
                </section>
            )}
        </div>
    );
};

export type { PermissionsPanelProps };
