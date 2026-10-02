/**
 * `@lunora/hostd` — the daemon a customer installs on their own VPS so Lunora
 * Cloud can run celld fleets on it (plan 458).
 *
 * Only the wire protocol exists so far; enrolment, the session and the
 * supervisor arrive with plan 458 W4. Import the protocol from
 * `@lunora/hostd/protocol`, which is what this entry re-exports.
 */
export * from "./protocol";
