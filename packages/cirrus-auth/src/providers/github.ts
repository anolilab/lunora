import { oauthRoutes } from "../routes/oauth.js";
import type { AuthProviderConfig } from "../types.js";

export interface GithubOptions {
    clientId: string;
    clientSecret: string;
}

export const github = (options: GithubOptions): AuthProviderConfig => ({
    id: "github",
    routes: (context) =>
        oauthRoutes(
            {
                id: "github",
                authorizationUrl: "https://github.com/login/oauth/authorize",
                defaultScope: "read:user user:email",
                clientId: options.clientId,
                clientSecret: options.clientSecret,
            },
            context,
        ),
});
