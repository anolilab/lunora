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
 * The wire topic comes from `encodeLiveTopic`, the one encoder the server parses with. The key fields are
 * emitted in the declaration's order, so `live.posts.post({ postId })` lays its segments out the way the
 * server expects regardless of the order the caller wrote the object in.
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

            const fields = `[${topic.fields.map((field) => JSON.stringify(field)).join(", ")}]`;

            return `        ${topic.name}: (key: LiveTopicKey<${declaration}>): ${reference} => ({
            __lunoraLive: ${id},
            topic: encodeLiveTopic(${JSON.stringify(topic.name)}, ${fields}, key),
        }),`;
        });

        return `    ${stream.exportName}: {\n${references.join("\n")}\n    },`;
    });

    // Only a keyed topic needs the encoder and the key type; importing them for keyless topics alone would trip `noUnusedLocals` in the app.
    const hasKeyedTopic = streams.some((stream) => stream.topics.some((topic) => topic.fields.length > 0));
    const encoderImport = hasKeyedTopic ? `import { encodeLiveTopic } from "${specifiers.client}";\n` : "";
    const serverTypes = hasKeyedTopic ? "LiveTopicKey, LiveTopicPayload" : "LiveTopicPayload";

    return `${GENERATED_HEADER}import type { LiveTopicRef } from "${specifiers.client}";
${encoderImport}import type { ${serverTypes} } from "${specifiers.server}";

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
