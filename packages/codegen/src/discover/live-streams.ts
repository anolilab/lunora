import { LunoraError } from "@lunora/errors";
import type { CallExpression, Node as MorphNode, ObjectLiteralElementLike, ObjectLiteralExpression, Project, PropertyAssignment, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { isLiveIdentifier, isReservedLiveTopicName } from "../../../../shared/live-stream";
import { diagnosticAt } from "../diagnostics";
import type { LiveStreamIR, LiveTopicIR } from "../ir";
import { descendantsOfKind, listLunoraSourceFiles, lunoraRelativePath } from "./ast";
import { addressableExportNameOf } from "./attribution";
import { callsServerFactory } from "./callee";
import { propertyKeyName } from "./property-name";

/** A spread member, or a computed key, hides names from a static read. */
const hidesNames = (literal: ObjectLiteralExpression): boolean =>
    literal.getProperties().some((property) => Node.isSpreadAssignment(property) || Node.isComputedPropertyName(property.getNameNode()));

/**
 * Also true for a method or accessor. The `topics` and `key` maps hold only validators, so a member of either kind is a
 * declaration codegen cannot read; the stream's own options object may carry `onSubscribe(…) {}`.
 */
const hidesMembers = (literal: ObjectLiteralExpression): boolean =>
    hidesNames(literal) ||
    literal
        .getProperties()
        .some((property) => Node.isMethodDeclaration(property) || Node.isGetAccessorDeclaration(property) || Node.isSetAccessorDeclaration(property));

/** The name of a member of a map {@link hidesMembers} already vetted: every member is a plain or shorthand property. */
const memberName = (member: ObjectLiteralElementLike): string => propertyKeyName(member as PropertyAssignment);

/** The member of `literal` that spells `name` at runtime, so `"key": {…}` and `key: {…}` read the same. */
const propertyNamed = (literal: ObjectLiteralExpression, name: string): ObjectLiteralElementLike | undefined =>
    literal
        .getProperties()
        .find((property) => (Node.isPropertyAssignment(property) || Node.isShorthandPropertyAssignment(property)) && propertyKeyName(property) === name);

const notLiteral = (node: MorphNode, detail: string): LunoraError => {
    const located = diagnosticAt(node, `defineLiveStream ${detail}`);

    return new LunoraError("LIVE_STREAM_NOT_LITERAL", located.message);
};

/** The object literal a property is initialised with, or a `LIVE_STREAM_NOT_LITERAL` error naming what to write instead. */
const literalOf = (owner: ObjectLiteralExpression, property: string, expectation: string): ObjectLiteralExpression => {
    const member = propertyNamed(owner, property);
    const initializer = Node.isPropertyAssignment(member) ? member.getInitializer() : undefined;

    if (initializer === undefined || !Node.isObjectLiteralExpression(initializer)) {
        throw notLiteral(member ?? owner, `needs ${expectation} so codegen can read its topics`);
    }

    if (hidesMembers(initializer)) {
        throw notLiteral(initializer, `cannot spread into or compute the keys of \`${property}\`: codegen must read every name as a literal`);
    }

    return initializer;
};

const topicOf = (streamId: string, member: ObjectLiteralElementLike): LiveTopicIR => {
    const name = memberName(member);
    const declaration = Node.isPropertyAssignment(member) ? member.getInitializer() : undefined;

    if (declaration === undefined || !Node.isObjectLiteralExpression(declaration)) {
        throw notLiteral(member, `needs an object literal for topic "${name}" ({ key?, payload }), not a reference to one`);
    }

    if (hidesMembers(declaration)) {
        throw notLiteral(declaration, `cannot spread into or compute the keys of topic "${name}"`);
    }

    if (!isLiveIdentifier(name) || isReservedLiveTopicName(name)) {
        throw new LunoraError(
            "LIVE_TOPIC_INVALID",
            `live stream "${streamId}": topic name "${name}" must be a plain identifier (letters, digits and "_", starting with a letter) that does not encode into the "room:" or socket topic prefix.`,
        );
    }

    const keyProperty = propertyNamed(declaration, "key");

    if (keyProperty === undefined) {
        return { fields: [], name };
    }

    const key = literalOf(declaration, "key", `an object literal \`key\` for topic "${name}"`);
    const fields = key.getProperties().map((entry) => memberName(entry));
    const invalid = fields.find((field) => !isLiveIdentifier(field));

    if (invalid !== undefined) {
        throw new LunoraError(
            "LIVE_TOPIC_INVALID",
            `live stream "${streamId}": key field "${name}.${invalid}" must be a plain identifier (letters, digits and "_", starting with a letter).`,
        );
    }

    return { fields, name };
};

const streamOf = (call: CallExpression, exportName: string, lunoraDirectory: string): LiveStreamIR => {
    const options = call.getArguments()[0];

    if (options === undefined || !Node.isObjectLiteralExpression(options)) {
        throw notLiteral(call, `needs an object-literal options argument so codegen can read its \`id\` and \`topics\``);
    }

    if (hidesNames(options)) {
        throw notLiteral(options, "cannot spread its options or use a computed key: codegen must read `id` and `topics` as literals");
    }

    const idProperty = propertyNamed(options, "id");
    const idValue = Node.isPropertyAssignment(idProperty) ? idProperty.getInitializer() : undefined;

    if (idValue === undefined || !Node.isStringLiteral(idValue)) {
        throw notLiteral(idProperty ?? options, 'needs a string-literal `id` (e.g. `defineLiveStream({ id: "posts", … })`) so codegen can type its references');
    }

    const id = idValue.getLiteralValue();
    const topics = literalOf(options, "topics", "an object-literal `topics` map");

    return {
        exportName,
        filePath: lunoraRelativePath(lunoraDirectory, call.getSourceFile().getFilePath()),
        id,
        topics: topics.getProperties().map((entry) => topicOf(id, entry)),
    };
};

/** Reject two streams that share an id or an export name: both name routes or `live.<export>` keys that must be unique. */
const assertUnique = (streams: ReadonlyArray<LiveStreamIR>): void => {
    const seen = new Map<string, string>();

    for (const stream of streams) {
        for (const [kind, value] of [
            ["id", stream.id],
            ["export", stream.exportName],
        ] as const) {
            const key = `${kind}:${value}`;
            const prior = seen.get(key);

            if (prior !== undefined) {
                throw new LunoraError(
                    "LIVE_STREAM_DUPLICATE",
                    `live stream ${kind} "${value}" is declared by both lunora/${prior}.ts and lunora/${stream.filePath}.ts; it must be unique across the app.`,
                );
            }

            seen.set(key, stream.filePath);
        }
    }
};

/** The node that owns `call`, looking through the wrappers that do not change its runtime value (`as`, `satisfies`, `!`, parentheses). */
const ownerOf = (call: CallExpression): MorphNode | undefined => {
    let owner = call.getParent();

    while (Node.isAsExpression(owner) || Node.isSatisfiesExpression(owner) || Node.isNonNullExpression(owner) || Node.isParenthesizedExpression(owner)) {
        owner = owner.getParent();
    }

    return owner;
};

/** Every `defineLiveStream` call in one source file, each bound to the named export it must be. */
const streamsIn = (sourceFile: SourceFile, lunoraDirectory: string): LiveStreamIR[] =>
    descendantsOfKind(sourceFile, SyntaxKind.CallExpression)
        .filter((call) => callsServerFactory(call, "defineLiveStream"))
        .map((call) => {
            const declaration = ownerOf(call);
            const exportName = Node.isVariableDeclaration(declaration) ? addressableExportNameOf(declaration, "binding") : undefined;

            // Nothing can import a stream that is not a named export, so no reference could ever be typed for it, and the shard
            // would not know it to check a publish. Refuse it rather than leave a mounted stream that is silently unpublishable.
            if (exportName === undefined) {
                throw new LunoraError(
                    "LIVE_STREAM_NOT_EXPORTED",
                    diagnosticAt(
                        call,
                        "defineLiveStream must be assigned to a named export (`export const posts = defineLiveStream({ … })`), not a default export, a local, or an inline call, so codegen can type its references",
                    ).message,
                );
            }

            return streamOf(call, exportName, lunoraDirectory);
        });

/**
 * Every `defineLiveStream({ … })` in `lunora/`, which must be a named export, read from its literals: the stream `id`, each topic
 * name, and each topic's `key` field names in declared order. A non-literal id, or a spread or computed
 * `topics` / `key` map, throws `LIVE_STREAM_NOT_LITERAL` (the `SOCKET_PATH_NOT_LITERAL` precedent), since the
 * generated encoder and the typed references cannot be derived from a name codegen cannot read.
 */
const discoverLiveStreams = (project: Project, lunoraDirectory: string): LiveStreamIR[] => {
    const streams = listLunoraSourceFiles(lunoraDirectory).flatMap((filePath) =>
        streamsIn(project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath), lunoraDirectory),
    );

    assertUnique(streams);

    return streams;
};

export default discoverLiveStreams;
