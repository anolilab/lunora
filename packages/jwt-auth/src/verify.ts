import { LunoraError } from "@lunora/errors";
import type { CryptoKey, JWTPayload, JWTVerifyGetKey, KeyObject } from "jose";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";

import type { JwtVerifierOf, JwtVerifierOptionsOf, VerifiedJwtOf } from "../../../shared/jwt-verify";
import { createJwtVerification } from "../../../shared/jwt-verify";

/**
 * A verification key: a key-set getter (`createLocalJWKSet`, `createRemoteJWKSet`)
 * or one public key. Asymmetric only: the default `algorithms` are asymmetric, so
 * an HMAC secret would never verify, and accepting one would invite pairing it
 * with an HMAC algorithm that anyone holding the "public" value could forge.
 */
type JwtKeySet = CryptoKey | JWTVerifyGetKey | KeyObject;

type JwtVerifierOptions = JwtVerifierOptionsOf<JwtKeySet>;

type VerifiedJwt = VerifiedJwtOf<JWTPayload>;

type JwtVerifier = JwtVerifierOf<JWTPayload>;

const verification = createJwtVerification<JwtKeySet, JWTPayload>({
    fail: (message) => new LunoraError("INTERNAL", message),
    jose: {
        createRemoteJWKSet,
        errors,
        // `jose` overloads `jwtVerify` per key kind; the union is one of the two at runtime.
        jwtVerify: async (token, key, options) => jwtVerify(token, key as Parameters<typeof jwtVerify>[1], options),
    },
    name: "@lunora/jwt-auth",
});

// Typed wrappers, not a destructure: `--isolatedDeclarations` cannot emit an exported binding element.
const httpsOrigin = (value: string, name: string): string => verification.httpsOrigin(value, name);

const jwtVerifier = (options: JwtVerifierOptions): JwtVerifier => verification.jwtVerifier(options);

const verifyJwt = async (token: string, options: Omit<JwtVerifierOptions, "onError" | "token">): Promise<JWTPayload> => verification.verifyJwt(token, options);

export type { TokenSource } from "../../../shared/jwt-verify";
export { bearerToken, cookieToken, firstToken, headerToken, nonEmpty } from "../../../shared/jwt-verify";
export type { JwtKeySet, JwtVerifier, JwtVerifierOptions, VerifiedJwt };
export { httpsOrigin, jwtVerifier, verifyJwt };
