/**
 * `@lunora/hostd/protocol` — the versioned wire protocol between `lunora-hostd`
 * on a customer's box and Lunora Cloud's per-box Durable Object (plan 458 W1).
 *
 * Zero runtime dependencies: it runs unchanged in Node (`hostd`) and in
 * workerd (the control plane). The normative contract, for implementations in
 * any language, is `protocol/hostd/README.md`.
 */
export type { HostdFrame } from "./wire/codec";
export { decodeBoxMessage, decodeCloudMessage, encodeMessage, peekProtocolVersion } from "./wire/codec";
export type { ProtocolNegotiation } from "./wire/constants";
export { HOSTD_PROTOCOL_LIMITS, HOSTD_PROTOCOL_VERSION, negotiateProtocolVersion } from "./wire/constants";
export type { RequestSigningInput } from "./wire/signing";
export { challengeSigningPayload, HOSTD_AUTH_DOMAIN, HOSTD_REQUEST_DOMAIN, HOSTD_REQUEST_HEADERS, requestSigningPayload } from "./wire/signing";
export type {
    AliasReport,
    AuthMessage,
    BoxIsolation,
    BoxMessage,
    BoxResources,
    BoxVersions,
    ChallengeMessage,
    CloudErrorMessage,
    CloudMessage,
    ConfigMessage,
    DecodeError,
    DecodeErrorCode,
    DecodeResult,
    DeployJob,
    DestroyJob,
    DiagnoseJob,
    FleetState,
    FleetSummary,
    HelloMessage,
    HostdJob,
    HostdMessage,
    IsolationStatus,
    JobMessage,
    PingMessage,
    PongMessage,
    ProgressMessage,
    ProtocolErrorDetail,
    ReloadJob,
    ReportMessage,
    ResultMessage,
    RouteEntry,
    RoutesMessage,
    TelemetryConfig,
    UpgradeJob,
} from "./wire/types";
export { isAlias, isErrorCode, isHostname, isNonce, isProtocolId, isSignature, isVersion } from "./wire/validate";
