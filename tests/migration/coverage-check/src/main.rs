mod catalog;
mod evidence;

use anyhow::{Context, Result, ensure};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    env, io,
    path::{Path, PathBuf},
    process::Command,
};

use catalog::{Catalog, Cell, Inventory, OpenItem};
use evidence::{
    Evidence, is_hex, oci_manifest, read_json, render_cli_terminal, render_oci_terminal,
    render_service_terminal, verify_linux_cli_lifecycle, verify_oci_lifecycle,
    verify_reference_pair, verify_service_upgrade,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    incumbent_source_sha: String,
    migration_base_sha: String,
    cases: usize,
    declared_cells: usize,
    observed_cells: usize,
    unobserved_cells: usize,
    verified_observations: usize,
    verified_visual_reference_observations: usize,
    verified_cli_reference_observations: usize,
    verified_oci_reference_observations: usize,
    verified_service_upgrade_observations: usize,
    supplemental_receipts: usize,
    open_matrix_items: Vec<OpenItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    missing: Option<Vec<Cell>>,
}

fn git(repo: &Path, args: &[&str]) -> Result<String> {
    let result = Command::new("git").current_dir(repo).args(args).output()?;
    ensure!(
        result.status.success(),
        "git {}: {}",
        args.join(" "),
        String::from_utf8_lossy(&result.stderr).trim()
    );
    Ok(String::from_utf8(result.stdout)?)
}

fn require_commit(repo: &Path, sha: &str) -> Result<()> {
    ensure!(is_hex(sha, 40), "expected a full commit SHA: {sha}");
    let commit = git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{sha}^{{commit}}"),
        ],
    )?;
    ensure!(commit.trim() == sha, "expected a commit, found {sha}");
    Ok(())
}

fn audit(repo: &Path, path: &Path, list_missing: bool) -> Result<Report> {
    let path = path
        .canonicalize()
        .with_context(|| format!("resolve {}", path.display()))?;
    let catalog: Catalog = read_json(&path)?;
    ensure!(
        catalog.schema_version == 1,
        "expected coverage catalog schema version 1"
    );
    let mut evidence = Evidence::new(path.parent().context("catalog has no parent directory")?)?;
    let inventory: Inventory = read_json(&evidence.resolve(&catalog.release_inventory)?)?;
    let incumbent = &catalog.incumbent_source_sha;
    ensure!(
        *incumbent == inventory.incumbent_source_sha
            && catalog.migration_base_sha == inventory.migration_base_sha,
        "inventory and catalog pin different source commits"
    );
    require_commit(repo, incumbent)?;
    require_commit(repo, &catalog.migration_base_sha)?;
    let release_tag = format!("refs/tags/{}^{{commit}}", inventory.github_release.tag_name);
    let published = git(
        repo,
        &["rev-parse", "--verify", "--end-of-options", &release_tag],
    )?;
    ensure!(
        published.trim() == incumbent,
        "published tag does not resolve to the catalog's incumbent"
    );
    let source = git(repo, &["ls-tree", "-r", "-z", "--name-only", incumbent])?;
    let source_paths: BTreeSet<_> = source.split_terminator('\0').collect();
    let known_assets: BTreeMap<_, _> = inventory
        .github_release
        .assets
        .iter()
        .map(|asset| {
            asset
                .digest
                .strip_prefix("sha256:")
                .map(|digest| (digest, asset.name.as_str()))
                .context("expected an inventory SHA-256")
        })
        .collect::<Result<_>>()?;
    ensure!(
        known_assets.keys().all(|digest| is_hex(digest, 64)),
        "invalid inventory SHA-256"
    );

    for (set, platforms) in &catalog.platform_sets {
        let unique: BTreeSet<_> = platforms.iter().collect();
        ensure!(
            !platforms.is_empty() && unique.len() == platforms.len(),
            "empty or duplicate platform list in {set}"
        );
        for id in platforms {
            ensure!(
                catalog.platforms.contains_key(id),
                "unknown platform {id} in {set}"
            );
        }
    }
    let contract = &catalog.observation_contract;
    for (profile, required_kinds) in [
        (
            "interaction",
            ["screenshot", "capture-receipt", "state-receipt"],
        ),
        (
            "process",
            ["terminal-screenshot", "process-transcript", "state-receipt"],
        ),
        (
            "negative",
            [
                "terminal-screenshot",
                "mutation-receipt",
                "comparison-result",
            ],
        ),
    ] {
        let kinds = contract
            .evidence_profiles
            .get(profile)
            .with_context(|| format!("missing schema-v1 evidence profile {profile}"))?;
        for kind in required_kinds {
            ensure!(
                kinds.iter().any(|value| value == kind),
                "schema-v1 evidence profile {profile} requires {kind}"
            );
        }
    }
    let mut required = BTreeSet::new();
    let mut evidence_profiles = BTreeMap::new();
    let mut supplemental = BTreeSet::new();
    for case in &catalog.cases {
        ensure!(
            !case.id.trim().is_empty() && !case.states.is_empty(),
            "empty case ID or states"
        );
        let required_profile = match case.id.as_str() {
            "cli-open" | "installer-home" | "installer-formats" | "updater" | "host-upgrade" => {
                Some("process")
            }
            "chat-display" | "chat-link" | "palette-link" => Some("interaction"),
            _ => None,
        };
        if let Some(profile) = required_profile {
            ensure!(
                case.evidence_profile == profile,
                "schema-v1 case {} requires the {profile} evidence profile",
                case.id
            );
        }
        let profile = contract
            .evidence_profiles
            .get(&case.evidence_profile)
            .with_context(|| format!("unknown evidence profile for {}", case.id))?;
        ensure!(
            !profile.is_empty(),
            "empty evidence profile for {}",
            case.id
        );
        ensure!(
            evidence_profiles.insert(&case.id, profile).is_none(),
            "duplicate case {}",
            case.id
        );
        ensure!(
            catalog.entrypoints.contains(&case.entrypoint),
            "unknown entrypoint for {}",
            case.id
        );
        let platforms = catalog
            .platform_sets
            .get(&case.platform_set)
            .with_context(|| format!("unknown platform set for {}", case.id))?;
        for state in &case.states {
            ensure!(!state.trim().is_empty(), "empty state for {}", case.id);
            for platform in platforms {
                ensure!(
                    required.insert(Cell {
                        case_id: case.id.clone(),
                        platform_id: platform.clone(),
                        state: state.clone(),
                        entrypoint: case.entrypoint.clone(),
                    }),
                    "duplicate state {state} for {}",
                    case.id
                );
            }
        }
        for source in &case.source_references {
            ensure!(
                source_paths.contains(source.as_str()),
                "source {source} is absent at {incumbent}"
            );
        }
        for receipt in &case.supplemental_receipts {
            let path = evidence.resolve(receipt)?;
            if supplemental.insert(path.clone()) {
                let value: serde_json::Value = read_json(&path)?;
                ensure!(
                    value.is_object(),
                    "expected a supplemental receipt object: {}",
                    path.display()
                );
            }
        }
    }

    let mut observed = BTreeSet::new();
    let mut records = BTreeSet::new();
    let mut verified_visual_references = 0;
    let mut verified_cli_references = 0;
    let mut verified_oci_references = 0;
    let mut verified_service_upgrades = 0;
    for observation in &catalog.observations {
        let cell = &observation.cell;
        let label = format!(
            "{}/{}/{} ({})",
            cell.case_id, cell.platform_id, cell.state, observation.configuration_id
        );
        ensure!(
            required.contains(cell),
            "observation does not match a declared cell: {label}"
        );
        ensure!(
            !observation.configuration_id.trim().is_empty(),
            "missing configuration ID: {label}"
        );
        ensure!(
            contract.stages.contains(&observation.stage),
            "unknown observation stage: {label}"
        );
        ensure!(
            contract.results.contains(&observation.result),
            "unknown observation result: {label}"
        );
        ensure!(
            records.insert((cell, &observation.configuration_id, &observation.stage)),
            "duplicate observation in {}: {label}",
            observation.stage
        );
        observed.insert(cell);

        let pass = observation.result == "pass";
        let release_reference = observation.stage == "p01-release-reference";
        let platform = &catalog.platforms[&cell.platform_id];
        let oci_arch = match cell.platform_id.as_str() {
            "oci-linux-arm64" => Some("arm64"),
            "oci-linux-amd64" => Some("amd64"),
            _ => None,
        };
        if let Some(arch) = oci_arch {
            ensure!(
                platform.surface == "oci"
                    && platform.os.as_deref() == Some("linux")
                    && platform.arch.as_deref() == Some(arch)
                    && platform.inventory_target.is_none(),
                "invalid OCI platform identity: {label}"
            );
        }
        let electron_target = cell.platform_id.strip_prefix("electron-");
        ensure!(
            (platform.surface == "electron") == electron_target.is_some(),
            "Electron platform ID conflicts with surface metadata: {label}"
        );
        if let Some(target) = electron_target {
            let os = platform
                .os
                .as_deref()
                .context("missing Electron platform OS")?;
            let arch = platform
                .arch
                .as_deref()
                .context("missing Electron platform architecture")?;
            let expected = format!("{os}-{arch}");
            ensure!(
                target == expected,
                "Electron platform ID conflicts with OS or architecture: {label}"
            );
            ensure!(
                !(pass && release_reference)
                    || platform.inventory_target.as_deref() == Some(target),
                "Electron reference requires matching installer target {expected}: {label}"
            );
        }
        ensure!(
            !pass || !observation.runs.is_empty(),
            "passing observation has no runs: {label}"
        );
        for run in &observation.runs {
            ensure!(
                contract.role_values.contains(&run.role),
                "unknown run role: {label}"
            );
            ensure!(
                is_hex(&run.source_sha, 40)
                    && is_hex(&run.server_source_sha, 40)
                    && !run.server_implementation.trim().is_empty()
                    && !run.fixture_id.trim().is_empty(),
                "missing or invalid run provenance: {label}"
            );
            if release_reference {
                ensure!(
                    run.source_sha == *incumbent && run.server_source_sha == *incumbent,
                    "release reference uses a different source: {label}"
                );
                let loopback_origin =
                    run.environment.origin.as_deref() == Some("server-served loopback");
                let loopback_connection =
                    run.environment.connection_mode.as_deref() == Some("loopback");
                ensure!(
                    !loopback_origin || loopback_connection,
                    "loopback origin requires loopback connection mode: {label}"
                );
                let target_id = if !pass && run.environment.installer_asset_digest.is_none() {
                    None
                } else if loopback_origin
                    || (platform.surface == "server-served-web" && loopback_connection)
                {
                    let os = platform
                        .os
                        .as_deref()
                        .context("missing browser platform OS")?;
                    let arch = run
                        .environment
                        .arch
                        .as_deref()
                        .context("missing loopback server architecture")?;
                    Some(format!("{os}-{arch}"))
                } else {
                    platform.inventory_target.clone()
                };
                let claimed_digest = run.environment.installer_asset_digest.as_deref();
                let asset = if let Some(arch) = oci_arch {
                    let manifest = oci_manifest(&inventory.oci_server, arch)?;
                    ensure!(
                        (!pass && claimed_digest.is_none())
                            || claimed_digest == manifest.strip_prefix("sha256:"),
                        "installer digest does not match published OCI {arch} manifest: {label}"
                    );
                    None
                } else {
                    claimed_digest
                        .map(|digest| {
                            known_assets
                                .get(digest)
                                .copied()
                                .with_context(|| format!("unpublished installer digest: {label}"))
                        })
                        .transpose()?
                };
                if let Some(target_id) = target_id {
                    let asset = asset.with_context(|| {
                        format!("missing installer digest for {target_id}: {label}")
                    })?;
                    let target = inventory
                        .installer_targets
                        .iter()
                        .find(|target| target.id == target_id)
                        .with_context(|| {
                            format!("unknown installer target {target_id}: {label}")
                        })?;
                    let desktop_asset = target.desktop_assets.iter().any(|name| name == asset);
                    let cli_asset = target.cli_archive.as_deref() == Some(asset);
                    ensure!(
                        desktop_asset || cli_asset,
                        "installer asset {asset} is outside target {target_id}: {label}"
                    );
                    ensure!(
                        electron_target.is_none() || desktop_asset,
                        "Electron reference requires a published desktop installer: {label}"
                    );
                    if pass
                        && matches!(
                            cell.case_id.as_str(),
                            "chat-display" | "chat-link" | "palette-link"
                        )
                        && let Some(arch) =
                            electron_target.and_then(|target| target.strip_prefix("linux-"))
                    {
                        let version = inventory.github_release.tag_name.trim_start_matches('v');
                        ensure!(
                            asset == format!("Sail-{version}-{arch}.deb"),
                            "Linux Electron reference requires the matching Debian installer: {label}"
                        );
                    }
                }
            }
            if let Some(arch) = &platform.arch {
                ensure!(
                    run.environment.arch.as_ref() == Some(arch),
                    "run architecture disagrees with platform: {label}"
                );
            }
            if pass {
                for kind in evidence_profiles[&cell.case_id] {
                    ensure!(
                        run.artifacts.iter().any(|artifact| artifact.kind == *kind),
                        "missing {kind} in {}: {label}",
                        run.role
                    );
                }
            }
            for artifact in &run.artifacts {
                evidence.verify(artifact).with_context(|| label.clone())?;
            }
        }
        for artifact in &observation.comparison_artifacts {
            evidence.verify(artifact).with_context(|| label.clone())?;
        }
        let has_process_evidence = evidence_profiles[&cell.case_id]
            .iter()
            .any(|kind| kind == "process-transcript")
            || observation
                .runs
                .iter()
                .flat_map(|run| &run.artifacts)
                .any(|artifact| artifact.kind == "process-transcript");
        if pass && release_reference && has_process_evidence {
            match (cell.case_id.as_str(), cell.platform_id.as_str(), oci_arch) {
                ("cli-open" | "installer-home", "cli-linux-arm64" | "cli-linux-x64", _) => {
                    verify_linux_cli_lifecycle(&evidence, &inventory, platform, observation)
                        .with_context(|| label.clone())?;
                    verified_cli_references += 1;
                }
                ("cli-open" | "installer-home", _, Some(arch)) => {
                    verify_oci_lifecycle(&evidence, &inventory, arch, observation)
                        .with_context(|| label.clone())?;
                    verified_oci_references += 1;
                }
                ("host-upgrade", "cli-linux-arm64", _) => {
                    verify_service_upgrade(&evidence, &inventory, platform, observation)
                        .with_context(|| label.clone())?;
                    verified_service_upgrades += 1;
                }
                _ => anyhow::bail!("no process verifier for passing release reference: {label}"),
            }
        }
        let has_visual_reference = evidence_profiles[&cell.case_id]
            .iter()
            .any(|kind| kind == "screenshot")
            || observation
                .runs
                .iter()
                .flat_map(|run| &run.artifacts)
                .any(|artifact| artifact.kind == "capture-receipt");
        if pass && release_reference && has_visual_reference {
            verify_reference_pair(&evidence, observation).with_context(|| label.clone())?;
            verified_visual_references += 1;
        }
    }
    let declared_cells = required.len();
    let observed_cells = observed.len();
    Ok(Report {
        incumbent_source_sha: catalog.incumbent_source_sha,
        migration_base_sha: catalog.migration_base_sha,
        cases: catalog.cases.len(),
        declared_cells,
        observed_cells,
        unobserved_cells: declared_cells - observed_cells,
        verified_observations: catalog.observations.len(),
        verified_visual_reference_observations: verified_visual_references,
        verified_cli_reference_observations: verified_cli_references,
        verified_oci_reference_observations: verified_oci_references,
        verified_service_upgrade_observations: verified_service_upgrades,
        supplemental_receipts: supplemental.len(),
        open_matrix_items: catalog.open_matrix_items,
        missing: list_missing.then(|| {
            required
                .into_iter()
                .filter(|cell| !observed.contains(cell))
                .collect()
        }),
    })
}

fn main() -> Result<()> {
    let mut args = env::args_os().skip(1).peekable();
    let render: Option<fn(&Path) -> Result<()>> = match args.peek().and_then(|arg| arg.to_str()) {
        Some("--render-cli") => Some(render_cli_terminal),
        Some("--render-oci") => Some(render_oci_terminal),
        Some("--render-service") => Some(render_service_terminal),
        _ => None,
    };
    if let Some(render) = render {
        args.next();
        let directory = args.next().context("missing process capture directory")?;
        ensure!(
            args.next().is_none(),
            "expected exactly one process capture directory"
        );
        return render(Path::new(&directory));
    }
    let mut path = None;
    let mut list_missing = false;
    for arg in args {
        if arg == "--list-missing" {
            list_missing = true;
        } else {
            ensure!(
                path.is_none() && !arg.to_string_lossy().starts_with('-'),
                "usage: sail-migration-coverage [--list-missing] [catalog.json]"
            );
            path = Some(PathBuf::from(arg));
        }
    }
    let path =
        path.unwrap_or_else(|| PathBuf::from("tests/migration/incumbent/coverage-catalog.json"));
    let report = audit(&env::current_dir()?, &path, list_missing)?;
    serde_json::to_writer_pretty(io::stdout().lock(), &report)?;
    println!();
    Ok(())
}
