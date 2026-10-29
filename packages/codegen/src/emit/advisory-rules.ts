const RULE_FIELDS = ["categories", "description", "facing", "level", "remediation", "title"] as const;

type Finding = { name: string };

/**
 * Split findings into per-rule text (first occurrence of each `name`) and slim per-finding
 * rows. A rule field that differs from its rule's first occurrence stays on the row, so
 * `{ ...rules[row.name], ...row }` reproduces every finding exactly.
 */
const splitAdvisoryRules = (findings: ReadonlyArray<Finding>): { advisoryRows: Finding[]; advisoryRules: Record<string, Record<string, unknown>> } => {
    const advisoryRules: Record<string, Record<string, unknown>> = {};
    const advisoryRows = (findings as ReadonlyArray<Finding & Record<string, unknown>>).map((finding) => {
        let rule = advisoryRules[finding.name];

        if (!rule) {
            rule = Object.fromEntries(RULE_FIELDS.filter((key) => key in finding).map((key) => [key, finding[key]]));
            advisoryRules[finding.name] = rule;
        }

        return Object.fromEntries(
            Object.entries(finding).filter(
                ([key, value]) => !(RULE_FIELDS as ReadonlyArray<string>).includes(key) || JSON.stringify(value) !== JSON.stringify(rule[key]),
            ),
        ) as Finding;
    });

    return { advisoryRows, advisoryRules };
};

export default splitAdvisoryRules;
