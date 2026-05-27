import { oauthRoutes } from "../routes/oauth.js";
import type { AuthProviderConfig } from "../types.js";

export interface GoogleOptions {
    clientId: string;
    clientSecret: string;
}

export const google = (options: GoogleOptions): AuthProviderConfig => ({
    id: "google",
    routes: (context) =>
        oauthRoutes(
            {
                id: "google",
                authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
                defaultScope: "openid email profile",
                clientId: options.clientId,
                clientSecret: options.clientSecret,
            },
            context,
        ),
});
