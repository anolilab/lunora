/**
 * `@lunora/hostd` — the daemon a customer installs on their own VPS so Lunora
 * Cloud can run celld fleets on it (plan 458).
 *
 * This entry re-exports the wire protocol (`@lunora/hostd/protocol`). The
 * daemon itself — enrolment, the session, the supervisor and the jobs — is the
 * `lunora-hostd` binary (`src/bin.ts`), not a library surface.
 */
export * from "./protocol";
