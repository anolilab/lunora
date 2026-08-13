import SiAngular from "@icons-pack/react-simple-icons/icons/SiAngular.mjs";
import SiAstro from "@icons-pack/react-simple-icons/icons/SiAstro.mjs";
import SiExpo from "@icons-pack/react-simple-icons/icons/SiExpo.mjs";
import SiNextdotjs from "@icons-pack/react-simple-icons/icons/SiNextdotjs.mjs";
import SiNuxt from "@icons-pack/react-simple-icons/icons/SiNuxt.mjs";
import SiReact from "@icons-pack/react-simple-icons/icons/SiReact.mjs";
import SiReactrouter from "@icons-pack/react-simple-icons/icons/SiReactrouter.mjs";
import SiSolid from "@icons-pack/react-simple-icons/icons/SiSolid.mjs";
import SiSvelte from "@icons-pack/react-simple-icons/icons/SiSvelte.mjs";
import SiTypescript from "@icons-pack/react-simple-icons/icons/SiTypescript.mjs";
import SiVuedotjs from "@icons-pack/react-simple-icons/icons/SiVuedotjs.mjs";
import { ArrowRight, ExternalLink } from "lucide-react";
import type { ComponentType, FC } from "react";

import TanstackLogo from "@/assets/frameworks/tanstack.svg?react";
import HatchSpacer from "@/components/sections/hatch-spacer";
import { ClosingCta } from "@/components/sections/langbase";
import { Action } from "@/kit/action";
import { Shell } from "@/kit/layout";
import { ArticleHeader } from "@/kit/page-header";
import InstallCommand from "@/pages/start/install-command";

/**
 * `/start` — every way `lunora init` can start a project.
 *
 * The list mirrors `FRAMEWORK_CHOICES` in
 * `packages/cli/src/commands/init/handler.ts`, which is what the CLI validates
 * against. Keep the two in step: this page listed eight kits when the binary
 * offered sixteen, and told every reader to pass `--template`, which is wrong
 * for the four create-vite overlays — those take `--vite` and have no template
 * directory at all. A starter page printing a flag the CLI rejects is worse
 * than no starter page.
 */

interface Kit {
    /** Brand simple-icons need `color="default"` to render their own hex. */
    brand?: boolean;
    Icon: ComponentType<{ className?: string; color?: string }>;
    /** The `-t` / `--vite` value. Bespoke ids are also the `templates/` directory name. */
    id: string;
    name: string;
    /** What you get, not what the framework is. */
    note: string;
    stack: string;
}

/** `lunora init <name> -t <id>` — a whole project, checked into `templates/`. */
const templates: Kit[] = [
    { Icon: TanstackLogo, id: "tanstack-start-react", name: "TanStack Start", note: "SSR with live-loader routes, typed end to end.", stack: "React" },
    { Icon: TanstackLogo, id: "tanstack-start-solid", name: "TanStack Start", note: "The same live loaders on fine-grained Solid reactivity.", stack: "Solid" },
    { brand: true, Icon: SiNextdotjs, id: "next", name: "Next.js", note: "App Router on OpenNext, plus a standalone Lunora worker.", stack: "React" },
    {
        brand: true,
        Icon: SiReactrouter,
        id: "react-router",
        name: "React Router",
        note: "v7 framework mode, SSR composed into the Lunora worker.",
        stack: "React",
    },
    { brand: true, Icon: SiNuxt, id: "nuxt", name: "Nuxt", note: "One worker: Lunora mounts inside Nitro beside your pages.", stack: "Vue" },
    { brand: true, Icon: SiSvelte, id: "sveltekit", name: "SvelteKit", note: "Live stores and reactive loaders, plus a Lunora worker.", stack: "Svelte" },
    { brand: true, Icon: SiAstro, id: "astro", name: "Astro", note: "Mostly-static islands, live where it counts.", stack: "Islands" },
    { brand: true, Icon: SiAngular, id: "analog", name: "Analog", note: "Angular on Nitro, single worker, RxJS-friendly live data.", stack: "Angular" },
    { brand: true, Icon: SiExpo, id: "expo", name: "Expo", note: "iOS, Android and web against one Lunora backend.", stack: "React Native" },
    { brand: true, Icon: SiNextdotjs, id: "vinext", name: "vinext", note: "Next App Router on Vite, composed into one worker. Experimental.", stack: "React" },
    { brand: true, Icon: SiNextdotjs, id: "vinext-pages", name: "vinext", note: "The same, for the Pages Router. Experimental.", stack: "Pages Router" },
    { brand: true, Icon: SiTypescript, id: "standalone", name: "Standalone", note: "No frontend — a typed backend any client can call.", stack: "Worker only" },
];

/** `lunora init <name> --vite <id>` — the official create-vite base, with the Lunora layer on top. */
const overlays: Kit[] = [
    { brand: true, Icon: SiReact, id: "react", name: "React", note: "The default when init runs without a framework flag.", stack: "SPA" },
    { brand: true, Icon: SiVuedotjs, id: "vue", name: "Vue", note: "create-vite's Vue base plus Lunora.", stack: "SPA" },
    { brand: true, Icon: SiSolid, id: "solid", name: "Solid", note: "create-vite's Solid base plus Lunora.", stack: "SPA" },
    { brand: true, Icon: SiSvelte, id: "svelte", name: "Svelte", note: "create-vite's Svelte base plus Lunora.", stack: "SPA" },
];

/** The `--add` feature list, verbatim from the CLI's own option description. */
const addons = [
    "ai",
    "auth",
    "backup",
    "browser",
    "cloudflare-access",
    "crons",
    "email",
    "flags",
    "hyperdrive",
    "payment",
    "presence",
    "queue",
    "storage",
    "workflow",
];

const KitCell: FC<{ flag: string; kit: Kit; source?: boolean }> = ({ flag, kit, source = false }) => {
    const body = (
        <>
            <div className="flex items-center gap-3">
                <kit.Icon className="size-6 shrink-0" color={kit.brand ? "default" : undefined} />
                <div className="min-w-0">
                    <h3 className="truncate text-base font-medium tracking-tight text-ink">{kit.name}</h3>
                    <p className="font-mono text-xs text-ink-faint">{kit.stack}</p>
                </div>
                {source ? <ExternalLink className="ml-auto size-3.5 shrink-0 text-ink-faint transition-colors group-hover:text-ink" /> : null}
            </div>
            <p className="text-sm leading-relaxed text-ink-muted">{kit.note}</p>
            <code className="mt-auto border-t border-hairline pt-3.5 font-mono text-xs text-ink-faint">
                {flag} {kit.id}
            </code>
        </>
    );

    // Only bespoke templates have somewhere to link: the overlays are generated
    // from create-vite at init time and have no directory to browse.
    return source ? (
        <a
            className="group flex h-full flex-col gap-4 bg-canvas p-6 transition-colors hover:bg-wash"
            href={`https://github.com/anolilab/lunora/tree/alpha/templates/${kit.id}`}
            rel="noreferrer"
            target="_blank"
        >
            {body}
        </a>
    ) : (
        <div className="flex h-full flex-col gap-4 bg-canvas p-6">{body}</div>
    );
};

const Start: FC = () => (
    <div className="relative overflow-x-clip bg-canvas" data-theme="dark">
        <ArticleHeader
            actions={
                <>
                    <Action to="/docs/getting-started" variant="primary">
                        Read the guide
                        <ArrowRight className="size-4" />
                    </Action>
                    <Action href="https://github.com/anolilab/lunora/tree/alpha/templates">Browse on GitHub</Action>
                </>
            }
            breadcrumb={[{ label: "Lunora", to: "/" }, { label: "Start" }]}
            lead="Pick a framework and `lunora init` scaffolds a typed, real-time Lunora backend wired into it — schema, functions, live data, and a one-command Cloudflare deploy. Then build."
            meta="Starter kits"
            title="Start with your stack."
        />

        <section data-nav-theme="dark">
            <Shell className="flex justify-center py-12">
                <InstallCommand />
            </Shell>
        </section>

        <HatchSpacer />

        {/* Templates and overlays are two different flags, so they are two bands
            rather than one grid with a badge on each cell. The flag is the thing
            a reader has to get right, and a badge is easy to skim past. */}
        <section data-nav-theme="dark">
            <Shell className="py-20">
                <div className="flex flex-col gap-3">
                    <span className="font-mono text-[10px] tracking-[0.18em] text-ink-faint uppercase">Templates · -t</span>
                    <h2 className="text-h2 font-semibold tracking-tight text-ink">Twelve whole projects</h2>
                    <p className="max-w-xl text-sm leading-relaxed text-ink-muted">
                        Each one is a complete app in <code className="font-mono text-ink-muted">templates/</code>, fetched at init and wired to the same typed,
                        live-syncing backend. Only the frontend changes.
                    </p>
                </div>

                <div className="mt-12 grid grid-cols-1 gap-px border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-3 lg:border-x-0">
                    {templates.map((kit) => (
                        <KitCell flag="-t" key={kit.id} kit={kit} source />
                    ))}
                </div>
            </Shell>
        </section>

        <HatchSpacer />

        <section data-nav-theme="dark">
            <Shell className="py-20">
                <div className="flex flex-col gap-3">
                    <span className="font-mono text-[10px] tracking-[0.18em] text-ink-faint uppercase">SPA · --vite</span>
                    <h2 className="text-h2 font-semibold tracking-tight text-ink">Or start from create-vite</h2>
                    <p className="max-w-xl text-sm leading-relaxed text-ink-muted">
                        No bespoke template — the official create-vite base for your framework, with the Lunora layer added on top.
                    </p>
                </div>

                <div className="mt-12 grid grid-cols-1 gap-px border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-4 lg:border-x-0">
                    {overlays.map((kit) => (
                        <KitCell flag="--vite" key={kit.id} kit={kit} />
                    ))}
                </div>
            </Shell>
        </section>

        <HatchSpacer />

        <section data-nav-theme="dark">
            <Shell className="py-20">
                <div className="grid grid-cols-1 gap-px bg-hairline lg:grid-cols-3">
                    <div className="flex flex-col gap-3 bg-canvas p-8 lg:col-span-2">
                        <span className="font-mono text-[10px] tracking-[0.18em] text-accent uppercase">--add</span>
                        <h3 className="text-h3 font-semibold text-ink">Add the rest at scaffold time</h3>
                        <p className="max-w-xl text-sm leading-relaxed text-ink-muted">
                            Pass a comma-separated list and init wires the packages, config and example code for each one, instead of leaving you to follow a
                            setup page per feature.
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                            {addons.map((addon) => (
                                <code className="border border-hairline px-2 py-1 font-mono text-xs text-ink-muted" key={addon}>
                                    {addon}
                                </code>
                            ))}
                        </div>
                    </div>

                    <div className="flex flex-col gap-8 bg-canvas p-8">
                        <div className="flex flex-col gap-2">
                            <span className="font-mono text-[10px] tracking-[0.18em] text-ink-faint uppercase">--here</span>
                            <p className="text-sm leading-relaxed text-ink-muted">
                                Already have an app? Init detects the framework, patches the config and scaffolds <code className="font-mono">lunora/</code> in
                                place.
                            </p>
                        </div>
                        <div className="flex flex-col gap-2">
                            <span className="font-mono text-[10px] tracking-[0.18em] text-ink-faint uppercase">--ci github | gitlab</span>
                            <p className="text-sm leading-relaxed text-ink-muted">Scaffold the deploy pipeline with it, so the first push ships.</p>
                        </div>
                    </div>
                </div>

                <p className="mt-8 font-mono text-xs text-ink-faint">lunora init my-app -t nuxt --add auth,email --ci github</p>
            </Shell>
        </section>

        <HatchSpacer />

        <ClosingCta />
    </div>
);

export default Start;
