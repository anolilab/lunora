/**
 * Placeholder `database_id` written for an auto-provisioned `DB` binding. It is
 * intentionally not a valid id so a deploy can't silently target the wrong
 * database; reconciliation warns the user to replace it (see the D1 warning in
 * `reconcileWranglerBindings`).
 *
 * Kept apart from `reconcile-bindings` so a module that only needs the string
 * (`celld-config`, reached from `@lunora/config/cli` through the driver
 * registry) does not pull codegen and ts-morph into every CLI start.
 */
const D1_PLACEHOLDER_ID = "<replace-with-d1-create-id>";

/**
 * The `id` reconcile writes on a Hyperdrive binding it adds, and the one the `hyperdrive`
 * registry item ships: wrangler requires a string, and `lunora dev` serves the binding from an
 * embedded Postgres whatever it is. `lunora deploy` swaps in a real id.
 */
const HYPERDRIVE_PLACEHOLDER_ID = "<replace-with-hyperdrive-create-id>";

export { D1_PLACEHOLDER_ID, HYPERDRIVE_PLACEHOLDER_ID };
