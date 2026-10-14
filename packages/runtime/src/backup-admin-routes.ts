/**
 * The `/_lunora/admin/backup/*` route cluster, extracted from `create-worker.ts`
 * (mirrors `./storage-admin-routes`). Two routes covering the whole of backup
 * retention as an operator touches it: read what would go, then remove it.
 *
 * Every handler is closure-free of the worker's internals — it reaches the
 * admin gate, the worker options and the body reader through the injected
 * {@link BackupAdminRouteDeps}, so this module imports no runtime values from
 * `create-worker` (only its types, erased at build).
 */
import type { WorkerOptions } from "./create-worker";
import { LunoraError } from "./errors";
import { assertMethod } from "./method-guard";
import { previewBackupRetention, runBackupPrune } from "./scheduled-backup";

/** Read-only: what backup retention would delete on its next run. Never deletes anything. */
const BACKUP_RETENTION_PATH = "/_lunora/admin/backup/retention";

/** The one route that deletes a backup, and only when an operator invokes it. */
const BACKUP_PRUNE_PATH = "/_lunora/admin/backup/prune";

/** The worker internals the backup routes reach through injection rather than closure. */
interface BackupAdminRouteDeps {
    /** The worker's own options — `backupStore`, `backupCron`, `backupRetain`, `backupPrefix`. */
    options: WorkerOptions;
    /** Read the request body as JSON under the runtime's shared size limit. */
    readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
    /** Admin-gate + require a configured option, else throw the `*_NOT_CONFIGURED` error. */
    requireAdminOption: <T>(request: Request, value: T | undefined, notConfigured: { code: string; message: string }) => T;
}

/** Build the `/_lunora/admin/backup/*` route map merged into the worker's internal route table. */
const buildBackupAdminRoutes = (deps: BackupAdminRouteDeps): Record<string, (request: Request) => Promise<Response>> => {
    const { options, readJsonBody, requireAdminOption } = deps;

    const requireBackupStore = (request: Request, action: string): void => {
        requireAdminOption(request, options.backupStore, {
            code: "BACKUP_NOT_CONFIGURED",
            message: `backup ${action} requires a \`backupStore\` on the worker`,
        });
    };

    /**
     * What `backupRetain` would remove on the next prune, computed by the same
     * selection the prune itself runs.
     *
     * A read, and only a read — the deletes live behind the prune route, and
     * this one calls no code that can delete. It exists because retention's
     * deletes are irreversible and its eligibility rule is genuinely
     * non-obvious on a real bucket (legacy sidecars carry no marker and are
     * never eligible), so "let it run and see what is gone" was the only way to
     * find out. Admin-gated before it reads anything, so an unauthenticated
     * caller learns nothing about which objects exist.
     */
    const handleRetention = async (request: Request): Promise<Response> => {
        assertMethod(request, "GET", "Backup-retention");

        requireBackupStore(request, "retention preview");

        return Response.json(await previewBackupRetention(options), { headers: { "cache-control": "no-store" } });
    };

    /**
     * Delete the snapshots named in `confirm`, intersected with what is still
     * past the retention window.
     *
     * The only route that removes a backup. It runs when an operator asks and
     * never on a schedule — the scheduled backup reports what is past the
     * window and leaves it there, which is what makes the deletion explicit
     * rather than a side effect of a backup succeeding.
     *
     * `confirm` is required, and that is the safety property: without it the
     * confirmed list and the deleted list would be two computations separated
     * by however long a human takes to answer a prompt, and a cron fire in
     * between would push another snapshot past the window — one the operator
     * was shown as kept. Naming keys does not grant permission to delete them:
     * the server re-runs the selection, so anything not eligible is ignored.
     */
    const handlePrune = async (request: Request): Promise<Response> => {
        assertMethod(request, "POST", "Backup-prune");

        requireBackupStore(request, "prune");

        const { confirm } = await readJsonBody(request);

        if (!Array.isArray(confirm) || confirm.some((key) => typeof key !== "string")) {
            throw new LunoraError(
                "backup prune requires a `confirm` array of the sidecar keys to remove — read them from `GET /_lunora/admin/backup/retention` and pass back the ones you mean to delete",
                { code: "BAD_REQUEST", status: 400 },
            );
        }

        return Response.json(await runBackupPrune(options, confirm as string[]), { headers: { "cache-control": "no-store" } });
    };

    return { [BACKUP_PRUNE_PATH]: handlePrune, [BACKUP_RETENTION_PATH]: handleRetention };
};

export type { BackupAdminRouteDeps };
export { BACKUP_PRUNE_PATH, BACKUP_RETENTION_PATH, buildBackupAdminRoutes };
