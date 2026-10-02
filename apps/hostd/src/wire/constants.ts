/**
 * The protocol version this build speaks. An integer that only ever grows: a
 * change a peer of the previous version could misread bumps it.
 */
const HOSTD_PROTOCOL_VERSION = 1;

/** Outcome of {@link negotiateProtocolVersion}. */
type ProtocolNegotiation =
    | {
          /** `PROTOCOL_UNSUPPORTED`, to send back in an `error` frame before closing. */
          code: "PROTOCOL_UNSUPPORTED";
          /** Tells the operator what to do: upgrade `hostd`, or wait for the control plane. */
          message: string;
          ok: false;
      }
    | { ok: true; version: number };

/**
 * Decide the version a session runs at, on the control plane, from the
 * `protocol` a box announced in `hello`.
 *
 * The box announces the one version it speaks; the control plane speaks every
 * version in `supported` (by default only {@link HOSTD_PROTOCOL_VERSION}). A
 * version outside that set is refused, with a message telling the operator
 * which side is behind.
 * @param offered the `hello.protocol` the box sent
 * @param supported the versions this control plane speaks
 */
const negotiateProtocolVersion = (offered: number, supported: ReadonlyArray<number> = [HOSTD_PROTOCOL_VERSION]): ProtocolNegotiation => {
    if (supported.includes(offered)) {
        return { ok: true, version: offered };
    }

    const newest = Math.max(...supported);

    if (offered < newest) {
        return {
            code: "PROTOCOL_UNSUPPORTED",
            message: `lunora-hostd speaks protocol ${String(offered)}, which Lunora Cloud no longer supports (it speaks ${supported.join(", ")}). Upgrade lunora-hostd on this box.`,
            ok: false,
        };
    }

    return {
        code: "PROTOCOL_UNSUPPORTED",
        message: `lunora-hostd speaks protocol ${String(offered)}, which is newer than Lunora Cloud supports (it speaks ${supported.join(", ")}). Install the lunora-hostd release Lunora Cloud offers, or retry after the control plane is updated.`,
        ok: false,
    };
};

/**
 * Caps every hostd frame is held to, on both sides of the socket.
 *
 * Cloudflare caps a WebSocket message at 1 MiB. A frame here stays at a
 * quarter of that, because nothing large belongs on the socket: releases are
 * fetched over signed HTTP (plan 458 D6). All byte counts are UTF-8 bytes.
 */
const HOSTD_PROTOCOL_LIMITS = {
    /** Longest alias: an alias is one DNS label of the box's default hostname. */
    maxAliasLength: 63,
    /** Most cron expressions in one deploy job. */
    maxCrons: 64,
    /** Longest `message` in a `result.error` or an `error` frame, in UTF-8 bytes (8 KiB). */
    maxErrorMessageBytes: 8192,
    /** Most fleets one `hello` reports. */
    maxFleets: 500,
    /** Most entries in `hello.isolation.problems`. */
    maxIsolationProblems: 8,
    /** Longest entry in `hello.isolation.problems`, in UTF-8 bytes. */
    maxIsolationProblemBytes: 512,
    /** Largest encoded frame, in UTF-8 bytes (256 KiB). */
    maxFrameBytes: 262_144,
    /** Longest `progress.line`, in UTF-8 bytes (8 KiB). */
    maxLineBytes: 8192,
    /** Most entries in one `report.perAlias`. */
    maxReportAliases: 500,
    /** Most entries in one `routes.table`. */
    maxRoutes: 2000,
    /** Longest URL (`releaseUrl`, `manifestUrl`, `result.url`). */
    maxUrlLength: 2048,
} as const;

export type { ProtocolNegotiation };
export { HOSTD_PROTOCOL_LIMITS, HOSTD_PROTOCOL_VERSION, negotiateProtocolVersion };
