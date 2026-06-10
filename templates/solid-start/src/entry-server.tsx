// @refresh reload
import { createHandler, StartServer } from "@solidjs/start/server";

/**
 * SSR entry. SolidStart's `cloudflare-module` preset compiles this into the
 * fetch handler that `src/server.ts` composes into the Cirrus worker via
 * `createWorker({ httpRouter })`.
 */
export default createHandler(() => (
    <StartServer
        document={({ assets, children, scripts }) => (
            <html lang="en">
                <head>
                    <meta charset="utf-8" />
                    <meta name="viewport" content="width=device-width, initial-scale=1" />
                    <title>{"{{name}}"}</title>
                    {assets}
                </head>
                <body>
                    <div id="app">{children}</div>
                    {scripts}
                </body>
            </html>
        )}
    />
));
