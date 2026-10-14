/**
 * A dataset is one module's personal data, described once: what it holds, why,
 * on which basis, and which of its tables are exported and erased. The coverage
 * check reads these descriptions, and the workflows read them to decide the order
 * of export and erasure.
 */
import { LunoraError } from "@lunora/errors";

import type { DataOrigin, LegalBasis } from "./articles";
import type { RetainDirective } from "./rules";

/** When a dataset is handled. Erasure runs `quiesce` first, so nothing writes behind it. */
type DatasetPhase = "quiesce" | "erase" | "tombstone";

/** Which shard holds the subject's rows. */
type DatasetPlacement = "subject" | "root" | "global";

/** What erasure does to one table. */
type TableErasure = "delete" | "anonymise" | RetainDirective;

/** How one table in a dataset is treated. */
interface TableSpec {
    /** Defaults to `delete`. */
    readonly erase?: TableErasure;
    /** Columns left out of the export, such as internal bookkeeping. */
    readonly omit?: ReadonlyArray<string>;
    /** Overrides the dataset's origin for this table. */
    readonly origin?: DataOrigin;
}

/** The description a module writes for its dataset. */
interface DatasetSpec {
    /**
     * Object-storage files the subject owns. `prefix` returns the key prefix of one subject's
     * files; it must be specific to that subject, because erasure deletes everything under it.
     */
    readonly files?: { readonly prefix: (subjectId: string) => string };
    readonly legalBasis: LegalBasis;
    readonly origin: DataOrigin;
    readonly phase?: DatasetPhase;
    readonly placement?: DatasetPlacement;
    readonly purpose: string;
    readonly recipients?: ReadonlyArray<string>;
    readonly tables: Readonly<Record<string, TableSpec>>;
}

/** A validated dataset, ready for the coverage check and the workflows. */
interface Dataset extends DatasetSpec {
    readonly id: string;
    readonly phase: DatasetPhase;
    readonly placement: DatasetPlacement;
    readonly recipients: ReadonlyArray<string>;
    /** The tables this dataset covers, by bare name. */
    readonly tableNames: ReadonlyArray<string>;
}

const ID_PATTERN = /^[a-z]\w*$/u;
const PHASE_RANK: Readonly<Record<DatasetPhase, number>> = { erase: 1, quiesce: 0, tombstone: 2 };

/**
 * Validate and freeze a dataset. Refuses an empty purpose, a dataset with no
 * tables, and an id that is not a plain identifier, so the Art. 30 draft and the
 * workflow step names stay well formed.
 */
const defineDataset = (id: string, spec: DatasetSpec): Dataset => {
    if (!ID_PATTERN.test(id)) {
        throw new LunoraError("BAD_REQUEST", `Dataset id "${id}" must be a lowercase identifier.`);
    }

    if (spec.purpose.trim() === "") {
        throw new LunoraError("BAD_REQUEST", `Dataset "${id}" needs a purpose; the Art. 30 record reads it.`);
    }

    const tableNames = Object.keys(spec.tables);

    if (tableNames.length === 0 && spec.files === undefined) {
        throw new LunoraError("BAD_REQUEST", `Dataset "${id}" declares no tables or files.`);
    }

    return {
        ...spec,
        id,
        phase: spec.phase ?? "erase",
        placement: spec.placement ?? "subject",
        recipients: spec.recipients ?? [],
        tableNames,
    };
};

/**
 * The order erasure visits datasets in: quiesce first, so no writer runs behind
 * the erasure, then the ordinary datasets, then tombstones. Within a phase the
 * declared order is kept.
 */
const erasureOrder = (datasets: ReadonlyArray<Dataset>): ReadonlyArray<Dataset> => [...datasets].toSorted((a, b) => PHASE_RANK[a.phase] - PHASE_RANK[b.phase]);

/** One table a retention rule may keep rows of after erasure, and the rule's directive. */
interface RetainedTable {
    readonly directive: RetainDirective;
    readonly table: string;
}

/**
 * The tables of a dataset whose erasure is a `retain` directive, in declared order. A rule may keep
 * their rows past erasure, so the dataset is restricted (Art. 18) and erasure archives what it keeps.
 */
const retainedTables = (dataset: Dataset): ReadonlyArray<RetainedTable> =>
    dataset.tableNames.flatMap((table) => {
        const erase = dataset.tables[table]?.erase;

        return typeof erase === "object" ? [{ directive: erase, table }] : [];
    });

export {
    type Dataset,
    type DatasetPhase,
    type DatasetPlacement,
    type DatasetSpec,
    defineDataset,
    erasureOrder,
    type RetainedTable,
    retainedTables,
    type TableErasure,
    type TableSpec,
};
