import SiReact from "@icons-pack/react-simple-icons/icons/SiReact.mjs";
import SiSolid from "@icons-pack/react-simple-icons/icons/SiSolid.mjs";
import SiSvelte from "@icons-pack/react-simple-icons/icons/SiSvelte.mjs";
import SiVuedotjs from "@icons-pack/react-simple-icons/icons/SiVuedotjs.mjs";
import { Boxes, Gauge, LayoutDashboard, Terminal } from "lucide-react";
import type { ComponentType, FC } from "react";

import { GridCell, HairlineGrid } from "@/kit/grid";
import { Kicker, Section, SectionHeader, Shell } from "@/kit/layout";
import { LinkRow, LinkRowList } from "@/kit/link-row";
import { PageHeader } from "@/kit/page-header";
import siteConfig from "~/site.config";

/**
 * The `/docs` hub — the page a reader lands on before they know which page they
 * want. Three jobs, in order: pick a runtime, find the tool, reach the page
 * everyone else reaches.
 *
 * It is a hand-built route rather than MDX content because it indexes the docs
 * rather than being one of them; keeping it in TSX means it composes from the
 * same kit as the rest of the site.
 */

const runtimes: { blurb: string; brand?: boolean; Icon: ComponentType<{ className?: string; color?: string }>; name: string; to: string }[] = [
    { blurb: "Hooks for live queries, mutations, and auth.", brand: true, Icon: SiReact, name: "React", to: "/docs/frameworks/react" },
    { blurb: "Composables with reactive loaders.", brand: true, Icon: SiVuedotjs, name: "Vue", to: "/docs/frameworks/vue" },
    { blurb: "Live stores and optimistic mutations.", brand: true, Icon: SiSvelte, name: "Svelte", to: "/docs/frameworks/svelte" },
    { blurb: "Signals wired to live queries.", brand: true, Icon: SiSolid, name: "Solid", to: "/docs/frameworks/solid" },
];

const tools = [
    { icon: <LayoutDashboard />, subtitle: "Schema, data, SQL, logs, and time-travel.", title: "Studio", to: "/studio" },
    { icon: <Terminal />, subtitle: "Scaffold, migrate, seed, deploy, and inspect.", title: "CLI", to: "/packages/cli" },
    { icon: <Gauge />, subtitle: "Schema and query lints that catch problems early.", title: "Advisor", to: "/packages/advisor" },
    { icon: <Boxes />, subtitle: "Expose a deployment to your AI agents.", title: "MCP server", to: "/packages/mcp" },
];

const popular = [
    {
        links: [
            { title: "Getting started", to: "/docs/getting-started" },
            { title: "Schema & tables", to: "/docs/concepts/schema" },
            { title: "Queries", to: "/docs/concepts/queries" },
            { title: "Mutations", to: "/docs/concepts/mutations" },
            { title: "Actions", to: "/docs/concepts/actions" },
            { title: "Sharding", to: "/docs/concepts/sharding" },
        ],
        title: "Core",
    },
    {
        links: [
            { title: "Deployment", to: "/docs/deployment" },
            { title: "Architecture", to: "/docs/architecture" },
            { title: "Errors", to: "/docs/errors" },
            { title: "Limits", to: "/docs/limits" },
            { title: "Auth", to: "/packages/auth" },
            { title: "All packages", to: "/packages" },
        ],
        title: "Operations",
    },
];

const DocsHub: FC = () => (
    <div className="bg-canvas" data-theme="dark">
        <PageHeader panelWidth="wide" size="short">
            <div className="mb-7 flex items-center justify-between gap-4">
                <Kicker>Documentation</Kicker>
                <Kicker>Alpha</Kicker>
            </div>
            <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
                <h1 className="text-display font-bold text-ink">Docs</h1>
                <p className="max-w-sm text-body text-ink-muted">
                    Reference for {siteConfig.brand.name} across every framework adapter, plus the CLI, Studio, and add-on packages.
                </p>
            </div>
        </PageHeader>

        <Section id="runtime">
            <Shell>
                <SectionHeader index="01" label="Adapters" note="Start with the adapter built for your project." title="Choose your runtime" />
                <HairlineGrid columns={4}>
                    {runtimes.map(({ blurb, brand, Icon, name, to }, index) => (
                        <GridCell
                            blurb={blurb}
                            icon={<Icon color={brand ? "default" : undefined} />}
                            index={String(index + 1).padStart(2, "0")}
                            key={name}
                            title={name}
                            to={to}
                        />
                    ))}
                </HairlineGrid>
            </Shell>
        </Section>

        <Section id="tools" tone="deep">
            <Shell>
                <SectionHeader index="02" label="Tooling" note="Extend your workflow beyond the core library." title="Developer tools" />
                <LinkRowList>
                    {tools.map((tool) => (
                        <LinkRow icon={tool.icon} key={tool.title} subtitle={tool.subtitle} title={tool.title} to={tool.to} />
                    ))}
                </LinkRowList>
            </Shell>
        </Section>

        <Section id="popular">
            <Shell>
                <SectionHeader index="03" label="Reference" note="The references and guides readers reach for most." title="Popular pages" />
                <div className="grid grid-cols-1 gap-x-col-gap gap-y-10 md:grid-cols-2">
                    {popular.map((column) => (
                        <div key={column.title}>
                            <Kicker className="mb-4 block">{column.title}</Kicker>
                            <LinkRowList>
                                {column.links.map((link) => (
                                    <LinkRow key={link.title} title={link.title} to={link.to} />
                                ))}
                            </LinkRowList>
                        </div>
                    ))}
                </div>
            </Shell>
        </Section>
    </div>
);

export default DocsHub;
