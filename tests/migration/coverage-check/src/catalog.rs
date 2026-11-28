use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub schema_version: u64,
    pub release_inventory: PathBuf,
    pub incumbent_source_sha: String,
    pub migration_base_sha: String,
    pub entrypoints: Vec<String>,
    pub platforms: BTreeMap<String, Platform>,
    pub platform_sets: BTreeMap<String, Vec<String>>,
    pub observation_contract: ObservationContract,
    pub cases: Vec<Case>,
    pub observations: Vec<Observation>,
    pub open_matrix_items: Vec<OpenItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Platform {
    pub surface: String,
    pub os: Option<String>,
    pub arch: Option<String>,
    pub inventory_target: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationContract {
    pub stages: Vec<String>,
    pub results: Vec<String>,
    pub role_values: Vec<String>,
    pub evidence_profiles: BTreeMap<String, Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Case {
    pub id: String,
    pub platform_set: String,
    pub entrypoint: String,
    pub states: Vec<String>,
    pub evidence_profile: String,
    pub source_references: Vec<String>,
    #[serde(default)]
    pub supplemental_receipts: Vec<PathBuf>,
}

#[derive(Clone, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub case_id: String,
    pub platform_id: String,
    pub state: String,
    pub entrypoint: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    #[serde(flatten)]
    pub cell: Cell,
    pub configuration_id: String,
    pub stage: String,
    pub result: String,
    pub runs: Vec<Run>,
    #[serde(default)]
    pub comparison_artifacts: Vec<Artifact>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub role: String,
    pub source_sha: String,
    pub server_implementation: String,
    pub server_source_sha: String,
    pub fixture_id: String,
    pub environment: Environment,
    pub artifacts: Vec<Artifact>,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub os_version: Option<String>,
    pub arch: Option<String>,
    pub client_version: Option<String>,
    pub browser_version: Option<String>,
    pub installer_asset_digest: Option<String>,
    pub origin: Option<String>,
    pub connection_mode: Option<String>,
    pub display_profile: Option<serde_json::Value>,
}

#[derive(Deserialize)]
pub struct Artifact {
    pub kind: String,
    pub path: PathBuf,
    pub sha256: String,
}

#[derive(Deserialize, Serialize)]
pub struct OpenItem {
    pub id: String,
    pub status: String,
    pub detail: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    pub incumbent_source_sha: String,
    pub migration_base_sha: String,
    pub github_release: Release,
    pub installer_targets: Vec<InstallerTarget>,
    pub oci_server: OciServer,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OciServer {
    pub repository: String,
    pub index_digest: String,
    pub manifests: Vec<OciManifest>,
}

#[derive(Deserialize)]
pub struct OciManifest {
    pub digest: String,
    pub platform: OciPlatform,
}

#[derive(Deserialize)]
pub struct OciPlatform {
    pub os: String,
    pub architecture: String,
}

#[derive(Deserialize)]
pub struct Release {
    pub tag_name: String,
    pub assets: Vec<Asset>,
}

#[derive(Deserialize)]
pub struct Asset {
    pub name: String,
    pub digest: String,
    pub size: u64,
    #[serde(rename = "unpackedCli")]
    pub unpacked_cli: Option<UnpackedCli>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnpackedCli {
    pub runtime_sha256: String,
    pub installed_entries: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallerTarget {
    pub id: String,
    pub desktop_assets: Vec<String>,
    pub cli_archive: Option<String>,
}
