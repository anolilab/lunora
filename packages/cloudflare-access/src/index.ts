export { composeResolvers, createAccessResolver } from "./resolver";
export type {
    AccessClaims,
    AccessKeySet,
    CreateAccessResolverOptions,
    ResolvedAccessIdentity,
    ResolvedIdentityLike,
    ResolveIdentityFunction,
    VerifyAccessJwtOptions,
} from "./types";
export { accessIssuer, verifyAccessJwt } from "./verify";
