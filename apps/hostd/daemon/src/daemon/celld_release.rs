//! The wrangler config a celld fleet runs a STORED RELEASE with (plan 458 W3),
//! a port of `packages/config/src/celld/release-config.ts`.
//!
//! `lunora-hostd` never sees a project checkout. A box downloads the release the
//! control plane stored for a deployment — the prebuilt Worker bundle, the
//! binding manifest `lunora build --emit-bindings` wrote, and the static assets —
//! and has to hand `celld deploy` a Wrangler config for it. This builds that
//! config from the manifest alone.
//!
//! The bundle is already built, so the config names it as `main` with
//! `no_bundle`, and celld needs no esbuild on the box. D1, KV, R2 and queues get
//! the same per-project names on every target, `{alias}--{binding}` — the rule
//! `apps/cloud`'s `tenantResourceName` applies on Workers for Platforms — so a
//! project moved between targets keeps its names. Durable Object classes must
//! be SQLite-backed: celld creates nothing else, so one cumulative
//! `new_sqlite_classes` migration lists them all. Binding types celld cannot run
//! are refused by name, all at once, before anything is written.
//!
//! The TypeScript passes its result through `projectCelldConfig`, the projection
//! every celld deploy uses. For the keys built here that projection is the
//! identity — each is an accepted key, the one migration already has exactly
//! `{new_sqlite_classes, tag}`, and the empty `exports` it injects is dropped as
//! configuring nothing — so it is not ported.
//! `tests/fixtures/celld-release-config.json` holds the TypeScript's own
//! output for every case, and both implementations are tested against it.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// Where the bundle sits in the release directory, beside the config.
pub const CELLD_RELEASE_MAIN: &str = "worker.js";

/// Where the static assets sit in the release directory.
pub const CELLD_RELEASE_ASSETS_DIRECTORY: &str = "assets";

/// The binding types a celld fleet runs, and so a release may carry, with how
/// each is satisfied: `provisioned` — a per-project resource this config names
/// ([`release_resource_name`]); `bound` — bound as the manifest declares it.
/// Every other type is refused.
pub const CELLD_RELEASE_BINDINGS: [(&str, &str); 8] = [
    ("assets", "bound"),
    ("d1", "provisioned"),
    ("durable_object", "bound"),
    ("kv", "provisioned"),
    ("queue_consumer", "bound"),
    ("queue_producer", "provisioned"),
    ("r2", "provisioned"),
    ("workflow", "bound"),
];

/// Longest alias: one DNS label.
pub const MAX_RELEASE_ALIAS_LENGTH: usize = 63;

/// The tightest name limit across the named resource types (R2 buckets, queues).
pub const MAX_RESOURCE_NAME: usize = 63;

/// The tag of the one migration listing every Durable Object class. celld accepts a growing class list under the same tag.
const MIGRATION_TAG: &str = "lunora-v1";

const DEFAULT_COMPATIBILITY_FLAGS: [&str; 1] = ["nodejs_compat"];

/// The serving options of a release's static assets: the subset of wrangler's `assets` the deploy request carries.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct CelldReleaseAssetsConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html_handling: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub not_found_handling: Option<String>,
    /// `true` / `false`, or a list of route patterns.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_worker_first: Option<Value>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CelldReleaseOptions {
    /// The deployment alias: the fleet's Worker name and the prefix of every resource name.
    pub alias: String,
    /// Serving options for the assets, when the release has any.
    pub assets_config: Option<CelldReleaseAssetsConfig>,
    /// The deploy job's compatibility date; wins over the manifest's.
    pub compatibility_date: Option<String>,
    /// Wins over the manifest's flags. Without either, `["nodejs_compat"]`, the platform default.
    pub compatibility_flags: Option<Vec<String>>,
    /// Cron expressions celld fires natively (plan 458 D11).
    pub crons: Vec<String>,
    /// Whether the release carries static assets; they are written to [`CELLD_RELEASE_ASSETS_DIRECTORY`].
    pub has_assets: bool,
    /// Vars and secrets, merged (plan 458 D10).
    pub vars: IndexMap<String, String>,
}

/// One binding celld cannot run, and why.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CelldReleaseRefusal {
    pub binding: String,
    pub reason: String,
    #[serde(rename = "type")]
    pub kind: String,
}

/// A release that cannot run on celld; `refused` lists every binding at fault.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CelldReleaseConfigError {
    pub message: String,
    pub refused: Vec<CelldReleaseRefusal>,
}

impl CelldReleaseConfigError {
    fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), refused: Vec::new() }
    }
}

impl std::fmt::Display for CelldReleaseConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CelldReleaseConfigError {}

/// Whether `alias` is a deployment alias: one DNS label of dash-separated `[a-z0-9]` runs, at most 63 characters.
pub fn is_release_alias(alias: &str) -> bool {
    alias.len() <= MAX_RELEASE_ALIAS_LENGTH
        && !alias.is_empty()
        && alias.split('-').all(|run| !run.is_empty() && run.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit()))
}

/// The per-project name of a D1 database, KV namespace, R2 bucket or queue:
/// `{alias}--{binding}`, the binding lowercased with `_` → `-`. Injective, since an
/// alias never contains `--`.
pub fn release_resource_name(alias: &str, binding: &str) -> Result<String, CelldReleaseConfigError> {
    if !is_release_alias(alias) {
        return Err(CelldReleaseConfigError::new(format!("alias \"{alias}\" must be dash-separated runs of [a-z0-9], at most 63 characters")));
    }

    let name = format!("{alias}--{}", binding.to_lowercase().replace('_', "-"));

    if crate::wire::js_length(&name) > MAX_RESOURCE_NAME {
        return Err(CelldReleaseConfigError::new(format!(
            "resource name \"{name}\" exceeds {MAX_RESOURCE_NAME} characters; shorten the project name or binding {binding}"
        )));
    }

    Ok(name)
}

/// `String(value)` for the primitives a manifest field holds; anything else as JSON.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// `value ?? fallback`: JSON `null` is as absent as a missing key.
fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

/// One manifest entry's fields. `binding` and `type` are strings: `parse_release` checks them.
struct Requirement<'a> {
    binding: &'a str,
    kind: &'a str,
    entry: &'a Map<String, Value>,
}

impl<'a> Requirement<'a> {
    fn get(&self, key: &str) -> Option<&'a Value> {
        self.entry.get(key)
    }

    /// `resource ?? binding`.
    fn resource_or_binding(&self) -> Value {
        present(self.get("resource")).cloned().unwrap_or_else(|| Value::String(self.binding.to_owned()))
    }
}

fn requirements(manifest: &Value) -> Vec<Requirement<'_>> {
    manifest
        .get("bindings")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .map(|entry| Requirement {
            binding: entry.get("binding").and_then(Value::as_str).unwrap_or_default(),
            kind: entry.get("type").and_then(Value::as_str).unwrap_or_default(),
            entry,
        })
        .collect()
}

/// Why celld cannot run `requirement`, or `None` when it can.
fn refusal_of(requirement: &Requirement<'_>) -> Option<String> {
    if !CELLD_RELEASE_BINDINGS.iter().any(|(kind, _)| *kind == requirement.kind) {
        return Some(format!("{} bindings do not run on celld", requirement.kind));
    }

    let class_name = requirement.get("className");

    if requirement.kind == "durable_object" {
        let Some(class_name) = class_name else {
            return Some("a Durable Object binding must name its class".to_owned());
        };

        // Absent is a binding to another Worker's class, which a single-app fleet cannot reach.
        match requirement.get("sqlite") {
            Some(Value::Bool(true)) => {}
            Some(Value::Bool(false)) => return Some(format!("class {} is KV-backed, and celld creates only SQLite-backed classes", js_string(class_name))),
            _ => return Some(format!("class {} belongs to another Worker; a celld fleet runs one", js_string(class_name))),
        }
    }

    if requirement.kind == "workflow" && class_name.is_none() {
        return Some("a workflow binding must name its class".to_owned());
    }

    None
}

/// `String.prototype.localeCompare` under the root collation, for ASCII: punctuation, then `$`, then digits,
/// then letters case-insensitively, with lower case before upper case only to break a tie. Anything else
/// sorts after ASCII by code point.
fn locale_compare(left: &str, right: &str) -> std::cmp::Ordering {
    const ORDER: &str = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz";

    let primary = |text: &str| -> Vec<u32> {
        text.chars()
            .map(|character| ORDER.find(character.to_ascii_lowercase()).map_or(1000 + u32::from(character), |index| u32::try_from(index).unwrap_or(u32::MAX)))
            .collect()
    };
    let tertiary = |text: &str| -> Vec<bool> { text.chars().map(|character| character.is_ascii_uppercase()).collect() };

    primary(left).cmp(&primary(right)).then_with(|| tertiary(left).cmp(&tertiary(right))).then_with(|| left.cmp(right))
}

/// Whether `key` is an array index, which a JavaScript object enumerates first, in ascending order.
fn array_index(key: &str) -> Option<u32> {
    let index = key.parse::<u32>().ok().filter(|index| *index < u32::MAX)?;

    (index.to_string() == key).then_some(index)
}

/// `{ ...vars }` as JavaScript orders it: array-index keys ascending, then the rest in insertion order.
fn js_object(vars: &IndexMap<String, String>) -> Value {
    let mut indexed: Vec<(u32, &String)> = vars.keys().filter_map(|key| Some((array_index(key)?, key))).collect();

    indexed.sort_unstable();

    let ordered = indexed.into_iter().map(|(_, key)| key).chain(vars.keys().filter(|key| array_index(key).is_none()));

    Value::Object(ordered.map(|key| (key.clone(), Value::String(vars[key].clone()))).collect())
}

fn of_type<'a, 'b>(requirements: &'b [Requirement<'a>], kind: &str) -> Vec<&'b Requirement<'a>> {
    requirements.iter().filter(|requirement| requirement.kind == kind).collect()
}

/// Queue producers and consumers. A consumer of a queue the Worker also produces to shares the producer's queue.
fn queue_section(alias: &str, requirements: &[Requirement<'_>]) -> Result<Option<Value>, CelldReleaseConfigError> {
    let producers = of_type(requirements, "queue_producer");
    let consumers = of_type(requirements, "queue_consumer");

    if producers.is_empty() && consumers.is_empty() {
        return Ok(None);
    }

    // A `Map`: a later producer of the same queue wins.
    let mut producer_names: Vec<(Value, String)> = Vec::new();

    for producer in &producers {
        let key = producer.resource_or_binding();
        let name = release_resource_name(alias, producer.binding)?;

        match producer_names.iter_mut().find(|(existing, _)| *existing == key) {
            Some(entry) => entry.1 = name,
            None => producer_names.push((key, name)),
        }
    }

    let mut section = Map::new();

    if !producers.is_empty() {
        let list = producers
            .iter()
            .map(|producer| Ok(json!({ "binding": producer.binding, "queue": release_resource_name(alias, producer.binding)? })))
            .collect::<Result<Vec<_>, _>>()?;

        section.insert("producers".into(), Value::Array(list));
    }

    if !consumers.is_empty() {
        let list = consumers
            .iter()
            .map(|consumer| {
                let key = consumer.resource_or_binding();
                let queue = match producer_names.iter().find(|(existing, _)| *existing == key) {
                    Some((_, name)) => name.clone(),
                    None => release_resource_name(alias, consumer.binding)?,
                };

                Ok(json!({ "queue": queue }))
            })
            .collect::<Result<Vec<_>, _>>()?;

        section.insert("consumers".into(), Value::Array(list));
    }

    Ok(Some(Value::Object(section)))
}

/// The sections every binding type maps to, keyed by their wrangler name; absent when the release has none of that type.
fn binding_sections(requirements: &[Requirement<'_>], options: &CelldReleaseOptions, config: &mut Map<String, Value>) -> Result<(), CelldReleaseConfigError> {
    let alias = options.alias.as_str();
    let durable_objects = of_type(requirements, "durable_object");
    let mut sqlite_classes: Vec<&Value> = Vec::new();

    for requirement in &durable_objects {
        if let Some(class_name) = requirement.get("className").filter(|class_name| !sqlite_classes.contains(class_name)) {
            sqlite_classes.push(class_name);
        }
    }

    sqlite_classes.sort_by(|left, right| locale_compare(&js_string(left), &js_string(right)));

    // Configures nothing → left out, so the config shows only what the Worker uses.
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value.filter(|value| value.as_array().is_none_or(|list| !list.is_empty())) {
            config.insert(key.to_owned(), value);
        }
    };

    put(
        "assets",
        options.has_assets.then(|| {
            let mut assets = Map::new();

            if let Some(binding) = of_type(requirements, "assets").first() {
                assets.insert("binding".into(), Value::String(binding.binding.to_owned()));
            }

            assets.insert("directory".into(), Value::String(format!("./{CELLD_RELEASE_ASSETS_DIRECTORY}")));

            if let Some(Value::Object(serving)) = options.assets_config.as_ref().and_then(|serving| serde_json::to_value(serving).ok()) {
                assets.extend(serving);
            }

            Value::Object(assets)
        }),
    );

    let d1 = of_type(requirements, "d1")
        .iter()
        .map(|requirement| {
            let name = release_resource_name(alias, requirement.binding)?;

            Ok(json!({ "binding": requirement.binding, "database_id": name, "database_name": name }))
        })
        .collect::<Result<Vec<_>, CelldReleaseConfigError>>()?;

    put("d1_databases", Some(Value::Array(d1)));
    put(
        "durable_objects",
        (!durable_objects.is_empty()).then(|| {
            let bindings: Vec<Value> =
                durable_objects.iter().map(|requirement| json!({ "class_name": requirement.get("className"), "name": requirement.binding })).collect();

            json!({ "bindings": bindings })
        }),
    );

    let kv = of_type(requirements, "kv")
        .iter()
        .map(|requirement| Ok(json!({ "binding": requirement.binding, "id": release_resource_name(alias, requirement.binding)? })))
        .collect::<Result<Vec<_>, CelldReleaseConfigError>>()?;

    put("kv_namespaces", Some(Value::Array(kv)));
    put("migrations", Some(if sqlite_classes.is_empty() { json!([]) } else { json!([{ "new_sqlite_classes": sqlite_classes, "tag": MIGRATION_TAG }]) }));
    put("queues", queue_section(alias, requirements)?);

    let r2 = of_type(requirements, "r2")
        .iter()
        .map(|requirement| Ok(json!({ "binding": requirement.binding, "bucket_name": release_resource_name(alias, requirement.binding)? })))
        .collect::<Result<Vec<_>, CelldReleaseConfigError>>()?;

    put("r2_buckets", Some(Value::Array(r2)));

    let workflows: Vec<Value> = of_type(requirements, "workflow")
        .iter()
        .map(|requirement| json!({ "binding": requirement.binding, "class_name": requirement.get("className"), "name": requirement.resource_or_binding() }))
        .collect();

    put("workflows", Some(Value::Array(workflows)));

    Ok(())
}

/// The Wrangler config celld deploys a stored release with — written beside
/// the bundle ([`CELLD_RELEASE_MAIN`]) and the assets
/// ([`CELLD_RELEASE_ASSETS_DIRECTORY`]) in the release directory. `manifest` is
/// the release's binding manifest, as `parse_release` checked it.
///
/// Refused, listing every binding celld cannot run, or for a malformed alias,
/// an over-long resource name, or assets that do not match the manifest's
/// assets binding.
pub fn celld_config_from_release(manifest: &Value, options: &CelldReleaseOptions) -> Result<Value, CelldReleaseConfigError> {
    let requirements = requirements(manifest);
    let refused: Vec<CelldReleaseRefusal> = requirements
        .iter()
        .filter_map(|requirement| {
            Some(CelldReleaseRefusal { binding: requirement.binding.to_owned(), reason: refusal_of(requirement)?, kind: requirement.kind.to_owned() })
        })
        .collect();

    if !refused.is_empty() {
        let listed: Vec<String> = refused.iter().map(|entry| format!("{} ({}): {}", entry.binding, entry.kind, entry.reason)).collect();

        return Err(CelldReleaseConfigError { message: format!("this release cannot run on celld: {}", listed.join("; ")), refused });
    }

    let has_assets_binding = requirements.iter().any(|requirement| requirement.kind == "assets");

    if has_assets_binding != options.has_assets {
        return Err(CelldReleaseConfigError::new(if options.has_assets {
            "the release carries assets but its manifest has no assets binding"
        } else {
            "the manifest has an assets binding but the release carries no assets"
        }));
    }

    // `options ?? manifest`: a manifest's `null` date is written as it is, as the TypeScript does.
    let compatibility_date = options.compatibility_date.clone().map(Value::String).or_else(|| manifest.get("compatibilityDate").cloned());
    let compatibility_flags = match (&options.compatibility_flags, present(manifest.get("compatibilityFlags"))) {
        (Some(flags), _) => json!(flags),
        (None, Some(Value::Array(flags))) => Value::Array(flags.clone()),
        (None, Some(_)) => return Err(CelldReleaseConfigError::new("the manifest's compatibilityFlags is not a list")),
        (None, None) => json!(DEFAULT_COMPATIBILITY_FLAGS),
    };
    let mut config = Map::new();

    config.insert("name".into(), Value::String(options.alias.clone()));
    config.insert("main".into(), Value::String(CELLD_RELEASE_MAIN.to_owned()));
    config.insert("no_bundle".into(), Value::Bool(true));

    if let Some(date) = compatibility_date {
        config.insert("compatibility_date".into(), date);
    }

    config.insert("compatibility_flags".into(), compatibility_flags);

    if !options.vars.is_empty() {
        config.insert("vars".into(), js_object(&options.vars));
    }

    if !options.crons.is_empty() {
        config.insert("triggers".into(), json!({ "crons": options.crons }));
    }

    binding_sections(&requirements, options, &mut config)?;

    Ok(Value::Object(config))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn produces_what_the_typescript_produces_for_every_fixture_case() {
        let fixture: Value = serde_json::from_str(include_str!("../../tests/fixtures/celld-release-config.json")).unwrap();

        for case in fixture.as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let options: CelldReleaseOptions = serde_json::from_value(case["options"].clone()).unwrap();
            let result = celld_config_from_release(&case["manifest"], &options);

            match case.get("expected") {
                // Key order included: `Value`'s equality ignores it, its serialisation does not.
                Some(expected) => assert_eq!(serde_json::to_string(&result.unwrap()).unwrap(), serde_json::to_string(expected).unwrap(), "{name}"),
                None => {
                    let error = result.unwrap_err();
                    let refused: Vec<CelldReleaseRefusal> = serde_json::from_value(case["error"]["refused"].clone()).unwrap();

                    assert_eq!(error.message, case["error"]["message"].as_str().unwrap(), "{name}");
                    assert_eq!(error.refused, refused, "{name}");
                }
            }
        }
    }

    #[test]
    fn checks_the_alias_and_the_resource_name() {
        assert!(is_release_alias("my-app-2"));
        assert!(!is_release_alias("my--app") && !is_release_alias("-app") && !is_release_alias("App") && !is_release_alias(""));
        assert!(!is_release_alias(&"a".repeat(64)));
        assert_eq!(release_resource_name("my-app", "SESSION_STORE").unwrap(), "my-app--session-store");
    }

    #[test]
    fn orders_vars_as_a_javascript_object_does() {
        let vars: IndexMap<String, String> =
            [("b", "1"), ("10", "2"), ("2", "3"), ("01", "4"), ("a", "5")].into_iter().map(|(key, value)| (key.to_owned(), value.to_owned())).collect();

        assert_eq!(js_object(&vars).as_object().unwrap().keys().collect::<Vec<_>>(), ["2", "10", "b", "01", "a"]);
    }

    #[test]
    fn sorts_class_names_as_locale_compare_does() {
        let mut names = vec!["b", "B", "a_b", "aB", "Ab", "a1", "$x", "_y", "ab"];

        names.sort_by(|left, right| locale_compare(left, right));
        assert_eq!(names, ["_y", "$x", "a_b", "a1", "ab", "aB", "Ab", "b", "B"]);
    }
}
