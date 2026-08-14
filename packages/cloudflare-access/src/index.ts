export { composeResolvers, createAccessResolver } from "./resolver";
export type {
    AccessClaims,
    AccessJwtFallbackOptions,
    AccessKeySet,
    CreateAccessResolverOptions,
    ResolvedAccessIdentity,
    ResolvedIdentityLike,
    ResolveIdentityFunction,
    VerifyAccessJwtOptions,
} from "./types";
export { accessIssuer, verifyAccessJwt } from "./verify";
