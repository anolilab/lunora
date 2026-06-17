import schemaImg from "@/assets/studio/schema.png";
import sqlImg from "@/assets/studio/sql-editor.png";
import timeTravelImg from "@/assets/studio/time-travel.png";
import AuroraMesh from "@/components/sections/aurora-mesh";
import FeatureScene from "@/components/sections/feature-scene";
import Section from "@/components/sections/section";
import SectionDivider from "@/components/sections/section-divider";
import SectionHeader from "@/components/sections/section-header";

const StudioShowcase = () => (
    <div className="bg-background relative overflow-hidden" data-theme="dark">
        <SectionDivider />
        <AuroraMesh placement="top" />
        <Section classes={{ root: "relative z-10" }} gridLength={0} mode="dark">
            <div className="col-span-full">
                <SectionHeader
                    align="center"
                    className="mx-auto"
                    eyebrow="Lunora Studio"
                    subhead="Schema, data, SQL, functions, workflows, and time travel — a local admin UI that ships with every Lunora app and runs against your live edge database."
                    title="A studio for your whole backend."
                />
            </div>

            <div className="col-span-full mt-20 flex flex-col gap-24 lg:gap-36">
                <FeatureScene
                    alt="Lunora Studio schema view showing shard-local and global tables"
                    bullets={[
                        "Shard-local tables in Durable Object SQLite",
                        "Global tables replicated through D1",
                        "Edit the schema — codegen reruns, types stay in sync",
                    ]}
                    copy="Declare your tables once. Lunora generates the typed data model and keeps server and client in lockstep — shard-local state in a Durable Object's SQLite, global tables in D1."
                    eyebrow="Schema"
                    image={schemaImg}
                    title="Your schema is the source of truth."
                />
                <FeatureScene
                    alt="Lunora Studio SQL editor with a query and results"
                    bullets={["Live table browser, per shard", "SQL editor with results, chart, and explain", "Saved queries and quick references"]}
                    copy="A full data browser and SQL editor over your live edge database — inspect rows, run queries, and read explain plans without leaving the studio."
                    eyebrow="Data & SQL"
                    image={sqlImg}
                    reverse
                    title="Browse and query live data."
                />
                <FeatureScene
                    alt="Lunora Studio time-travel view with point-in-time restore"
                    bullets={[
                        "Point-in-time restore, any moment in the last 30 days",
                        "Bookmark-based, in-place recovery",
                        "Snapshot backup tier for older state",
                    ]}
                    copy="Every shard is a SQLite database you can rewind. Restore to any moment in the last 30 days from a bookmark, or reach further back with the snapshot backup tier — no extra infrastructure."
                    eyebrow="Time Travel"
                    image={timeTravelImg}
                    title="Rewind your data to any moment."
                />
            </div>
        </Section>
    </div>
);

export default StudioShowcase;
