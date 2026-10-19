import type { LiveStreamIR } from "../ir";
import { assertIdentifier, assertPropertyIdentifier, baseSpecifiers, GENERATED_HEADER, IMPORT_PATH_RE } from "./shared";

/**
 * Render `_generated/live.ts`: a typed reference per declared live topic, or `""` when the project declares
 * no live stream.
 *
 * The module is the live-topic counterpart of `api.ts`. It exists for the same reason: importing the stream
 * value into client code would pull `httpAction`, the validators and the whole server graph into the browser
 * bundle. So the stream is imported as a TYPE only, and the value a reference is made of is plain data
 * (`{ __lunoraLive, topic }`). The payload and key types are inferred from the declaration, never restated.
 *
 * The module has no runtime import, so a backend-only worker that only publishes can use it without the client
 * package. The key is encoded inline, by the rule `parseLiveTopic` inverts on the server: each value
 * percent-encoded, joined with `:`, in the DECLARATION's field order. So `live.posts.post({ postId })` lays its
 * segments out the way the server expects regardless of the order the caller wrote the object in.
 */
const emitLive = (streams: ReadonlyArray<LiveStreamIR>, useUmbrella = false): string => {
    if (streams.length === 0) {
        return "";
    }

    const specifiers = baseSpecifiers(useUmbrella);
    const imports = streams.map((stream) => {
        assertIdentifier(stream.exportName, "live stream export name");

        if (!IMPORT_PATH_RE.test(stream.filePath)) {
            throw new Error(`@lunora/codegen: live stream file path is not safe to import: ${JSON.stringify(stream.filePath)}`);
        }

        return `import type { ${stream.exportName} as ${stream.exportName}Stream } from "../${stream.filePath}.js";`;
    });

    const members = streams.map((stream) => {
        const references = stream.topics.map((topic) => {
            assertPropertyIdentifier(topic.name, "live topic name");

            const declaration = `(typeof ${stream.exportName}Stream)["topics"]["${topic.name}"]`;
            const reference = `LiveTopicRef<LiveTopicPayload<${declaration}>>`;
            const id = JSON.stringify(stream.id);

            if (topic.fields.length === 0) {
                return `        ${topic.name}: (): ${reference} => ({ __lunoraLive: ${id}, topic: ${JSON.stringify(topic.name)} }),`;
            }

            // Each key value is percent-encoded and joined with `:` in the DECLARED field order, the rule `parseLiveTopic` inverts on
            // the server. It is spelled inline so this module needs no runtime package: a backend-only worker imports it to publish.
            const segments = topic.fields.map((field) => `\${encodeURIComponent(key.${field})}`).join(":");

            return `        ${topic.name}: (key: LiveTopicKey<${declaration}>): ${reference} => ({
            __lunoraLive: ${id},
            topic: \`${topic.name}:${segments}\`,
        }),`;
        });

        return `    ${stream.exportName}: {\n${references.join("\n")}\n    },`;
    });

    // Only a keyed topic needs the key type; importing it for keyless topics alone would trip `noUnusedLocals` in the app.
    const hasKeyedTopic = streams.some((stream) => stream.topics.some((topic) => topic.fields.length > 0));
    const serverTypes = hasKeyedTopic ? "LiveTopicKey, LiveTopicPayload, LiveTopicRef" : "LiveTopicPayload, LiveTopicRef";

    return `${GENERATED_HEADER}import type { ${serverTypes} } from "${specifiers.server}";

${imports.join("\n")}

/**
 * A typed reference to each declared live topic, grouped by the stream's export name:
 * \`live.posts.post({ postId })\`. Pass one to \`ctx.live.publish(ref, payload)\` on the server, or to a
 * live-topic hook in the browser. A reference is plain data and carries no server code.
 */
export const live = {
${members.join("\n")}
};
`;
};

export default emitLive;
