use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    io::{self, Cursor, Write},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CaptureRequest {
    host: String,
    round: usize,
    sequence: usize,
    warmup: bool,
    representative: bool,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Sample {
    #[serde(flatten)]
    request: CaptureRequest,
    elapsed_ns: u64,
    stages_ns: BTreeMap<String, u64>,
    profile: Value,
    trace: Value,
    screenshot_sha256: String,
    source_sha: String,
    package_sha256: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Timing {
    samples: usize,
    min_ns: u64,
    median_ns: u64,
    p95_ns: u64,
    max_ns: u64,
    p95_sequence: usize,
    png_digests: usize,
    traces: usize,
    source_sha: String,
    package_sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EarlierReport {
    schema_version: usize,
    warmup_rounds: usize,
    measured_rounds: usize,
    rotation: Vec<String>,
    samples: Vec<Sample>,
    timings: BTreeMap<String, Timing>,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CaptureSource {
    source_sha: String,
    archive_sha256: String,
}

fn await_file(host: &Path, expected: &Path, budget: Duration) -> Result<()> {
    let started = Instant::now();
    while !expected.is_file() {
        ensure!(
            !host.join("provider-error.private").exists(),
            "capture provider failed in {}",
            host.display()
        );
        ensure!(
            started.elapsed() < budget,
            "timed out waiting for {}",
            expected.display()
        );
        thread::sleep(Duration::from_millis(25));
    }
    Ok(())
}

fn validate_sample(
    sample: &Sample,
    request: &CaptureRequest,
    source: &CaptureSource,
) -> Result<()> {
    ensure!(
        sample.request == *request,
        "sample does not match its capture request"
    );
    ensure!(
        sample.source_sha == source.source_sha && sample.package_sha256 == source.archive_sha256,
        "sample does not match the declared source and package"
    );
    ensure!(
        sample.elapsed_ns > 0
            && sample.stages_ns.keys().map(String::as_str).eq([
                "focus",
                "highlight",
                "navigate",
                "screenshot",
                "trace",
            ])
            && sample.stages_ns.values().all(|time| *time > 0)
            && sample
                .stages_ns
                .values()
                .map(|time| u128::from(*time))
                .sum::<u128>()
                == u128::from(sample.elapsed_ns),
        "invalid capture stage durations"
    );
    ensure!(
        sample.profile
            == json!({
                "browser": "Chrome/158.0.0.0",
                "fonts": [
                    "-apple-system, BlinkMacSystemFont, \"Inter Variable\", \"Segoe UI\", system-ui, sans-serif",
                    "ui-monospace, \"SF Mono\", SFMono-Regular, Menlo, Consolas, \"Liberation Mono\", monospace",
                ],
                "locale": "en",
                "motion": "standard",
                "theme": "light",
                "viewport": {"height": 600, "scale": 2, "width": 640, "zoom": 1},
            }),
        "sample does not match the pinned capture profile"
    );
    let trace = sample
        .trace
        .as_array()
        .context("sample has no action trace")?;
    ensure!(
        trace.iter().map(|event| event["action"].as_str()).eq([
            Some("openDirectThreadUrl"),
            Some("tabToAttachFiles"),
            Some("readComposerControls"),
        ]) && trace[0]["observed"]
            == json!({
                "availableModel": true,
                "codeText": "clamp(12, 0, 10); // 10\nclamp(-3, 0, 10); // 0",
                "replyVisible": true,
                "stopVisible": false,
                "table": [
                    ["Step", "Tool", "Result"],
                    ["Read", "read", "1 file"],
                    ["Edit", "edit", "+4 lines"],
                    ["Test", "execute", "12 passed"],
                ],
                "tableRows": 4,
                "threadTitle": "Compatibility replay",
            })
            && trace[1]["observed"]
                == json!({
                    "composerName": "Message Compatibility replay",
                    "focusName": "Attach files",
                    "focusRole": "button",
                    "menuCount": 0,
                }),
        "sample did not record the settled thread and composer focus"
    );
    let controls = trace[2]["observed"]["controls"]
        .as_array()
        .context("sample has no observed composer controls")?;
    ensure!(
        controls.iter().all(|control| {
            control["name"]
                .as_str()
                .is_some_and(|name| !name.is_empty())
                && control.get("pressed").is_some_and(|pressed| {
                    pressed.is_null() || matches!(pressed.as_str(), Some("true" | "false"))
                })
        }) && ["Attach files", "Showcase", "Submit message"]
            .iter()
            .all(|name| { controls.iter().any(|control| control["name"] == *name) }),
        "sample has incomplete composer controls"
    );
    Ok(())
}

fn validate_png(sample: &Sample, path: &Path) -> Result<()> {
    let bytes = fs::read(path)?;
    ensure!(
        format!("{:x}", Sha256::digest(&bytes)) == sample.screenshot_sha256,
        "sample screenshot has a different digest"
    );
    let mut png = png::Decoder::new(Cursor::new(bytes)).read_info()?;
    let info = png.info();
    ensure!(
        (info.width, info.height) == (1280, 1200)
            && info.animation_control.is_none()
            && info.bit_depth != png::BitDepth::Sixteen,
        "sample screenshot has the wrong geometry or format"
    );
    let mut pixels = vec![
        0;
        png.output_buffer_size()
            .context("PNG output size overflow")?
    ];
    png.next_frame(&mut pixels)?;
    png.finish()?;
    Ok(())
}

fn assign(host: &Path, request: &CaptureRequest, source: &CaptureSource) -> Result<Sample> {
    let path = host.join(format!("capture-{}.request", request.round));
    let staging = path.with_extension("pending");
    ensure!(
        !path.exists(),
        "capture directory already used: {}",
        path.display()
    );
    let mut writer = fs::File::create_new(&staging)?;
    serde_json::to_writer(&mut writer, request)?;
    drop(writer);
    fs::rename(staging, path)?;
    let result = host.join(format!("samples/{:02}.json", request.round));
    await_file(host, &result, Duration::from_secs(90))?;
    let sample: Sample = serde_json::from_reader(fs::File::open(&result)?)?;
    validate_sample(&sample, request, source)?;
    validate_png(&sample, &result.with_extension("png"))?;
    Ok(sample)
}

fn summarize<'a>(samples: impl Iterator<Item = &'a Sample>) -> Result<Timing> {
    let mut values: Vec<_> = samples.collect();
    values.sort_by_key(|sample| sample.elapsed_ns);
    let first = values.first().context("empty timing cohort")?;
    ensure!(
        values
            .iter()
            .all(|sample| sample.source_sha == first.source_sha
                && sample.package_sha256 == first.package_sha256),
        "archive changed within a timing cohort"
    );
    let count = values.len();
    let lower = values[(count - 1) / 2].elapsed_ns;
    let upper = values[count / 2].elapsed_ns;
    let p95 = values[(count * 95).div_ceil(100) - 1];
    Ok(Timing {
        samples: count,
        min_ns: first.elapsed_ns,
        median_ns: lower + (upper - lower) / 2,
        p95_ns: p95.elapsed_ns,
        max_ns: values[count - 1].elapsed_ns,
        p95_sequence: p95.request.sequence,
        png_digests: values
            .iter()
            .map(|sample| &sample.screenshot_sha256)
            .collect::<BTreeSet<_>>()
            .len(),
        traces: values
            .iter()
            .map(|sample| serde_json::to_string(&sample.trace))
            .collect::<serde_json::Result<BTreeSet<_>>>()?
            .len(),
        source_sha: first.source_sha.clone(),
        package_sha256: first.package_sha256.clone(),
    })
}

fn request_at(hosts: &[&str], sequence: usize, warmups: usize) -> CaptureRequest {
    let round = sequence / hosts.len();
    CaptureRequest {
        host: hosts[(round + sequence % hosts.len()) % hosts.len()].to_owned(),
        round,
        sequence,
        warmup: round < warmups,
        representative: round == warmups,
    }
}

fn by_host(hosts: &[&str], samples: &[Sample]) -> Result<BTreeMap<String, Timing>> {
    hosts
        .iter()
        .map(|host| {
            summarize(
                samples
                    .iter()
                    .filter(|sample| sample.request.host == *host && !sample.request.warmup),
            )
            .map(|timing| ((*host).to_owned(), timing))
        })
        .collect()
}

fn earlier_baselines(
    path: &Path,
    source: &CaptureSource,
    warmups: usize,
    measured: usize,
) -> Result<BTreeMap<String, Timing>> {
    let report: EarlierReport = serde_json::from_reader(fs::File::open(path)?)?;
    let hosts = ["a", "b"];
    ensure!(
        report.schema_version == 2
            && report.rotation == hosts
            && report.warmup_rounds == warmups
            && report.measured_rounds == measured
            && report.samples.len() == hosts.len() * (warmups + measured),
        "expected an earlier two-install report with matching rounds and full trace timing"
    );
    let runs = path
        .parent()
        .context("earlier report has no run directory")?
        .join("runs");
    for (sequence, sample) in report.samples.iter().enumerate() {
        let request = request_at(&hosts, sequence, warmups);
        validate_sample(sample, &request, source)?;
        let path = runs.join(format!(
            "{}/samples/{:02}.json",
            request.host, request.round
        ));
        let raw: Sample = serde_json::from_reader(fs::File::open(&path)?)?;
        ensure!(
            *sample == raw,
            "earlier report disagrees with its raw sample"
        );
        validate_png(sample, &path.with_extension("png"))?;
    }
    let timings = by_host(&hosts, &report.samples)?;
    ensure!(
        timings == report.timings,
        "earlier report summary disagrees with its samples"
    );
    Ok(timings)
}

fn compare(baselines: &BTreeMap<String, Timing>, head: u64) -> BTreeMap<&str, Value> {
    ["a", "b"]
        .into_iter()
        .map(|host| {
            let incumbent = baselines[host].p95_ns;
            let delta = i128::from(head) - i128::from(incumbent);
            let within_relative = u128::from(head) * 100 <= u128::from(incumbent) * 115;
            let within_absolute = delta <= 2_000_000_000;
            (
                host,
                json!({
                    "baselineP95Ns": incumbent,
                    "deltaNs": delta,
                    "withinRelativeBudget": within_relative,
                    "withinAbsoluteBudget": within_absolute,
                    "pass": within_relative && within_absolute,
                }),
            )
        })
        .collect()
}

fn qualify(
    paired: &BTreeMap<String, Timing>,
    earlier: &BTreeMap<String, Timing>,
    digest: &str,
) -> Value {
    let candidate = paired["head"].p95_ns;
    let paired = compare(paired, candidate);
    let incumbent_first = compare(earlier, candidate);
    let pass = paired
        .values()
        .chain(incumbent_first.values())
        .all(|result| result["pass"] == true);
    json!({"earlierReportSha256": digest, "paired": paired, "incumbentFirst": incumbent_first, "pass": pass})
}

fn main() -> Result<()> {
    let mut args = env::args_os().skip(1);
    let root = PathBuf::from(args.next().context(
        "usage: capture-timings CAPTURE_ROOT WARMUPS MEASURED [--candidate EARLIER_TIMINGS]",
    )?);
    let warmups: usize = args
        .next()
        .context("missing warmup count")?
        .to_string_lossy()
        .parse()?;
    let measured: usize = args
        .next()
        .context("missing measured count")?
        .to_string_lossy()
        .parse()?;
    let earlier_path = match args.next().as_deref() {
        None => None,
        Some(flag) if flag == "--candidate" => Some(PathBuf::from(
            args.next().context("missing earlier timings")?,
        )),
        Some(_) => anyhow::bail!("unknown capture-timings option"),
    };
    ensure!(
        args.next().is_none() && measured > 0 && measured <= 100 && warmups <= 10,
        "invalid sample counts"
    );
    let source_dir = root
        .parent()
        .context("capture root has no source directory")?
        .join("sources");
    let load_source = |name: &str| -> Result<CaptureSource> {
        Ok(serde_json::from_reader(fs::File::open(
            source_dir.join(format!("{name}.json")),
        )?)?)
    };
    let published = load_source("published")?;
    let (hosts, head, earlier): (&[&str], _, _) = if let Some(path) = earlier_path {
        let head = load_source("head")?;
        ensure!(
            head.source_sha != published.source_sha
                && head.archive_sha256 != published.archive_sha256,
            "candidate source and archive must differ from the published package"
        );
        let earlier = earlier_baselines(&path, &published, warmups, measured)?;
        (
            &["a", "head", "b"],
            Some(head),
            Some((earlier, format!("{:x}", Sha256::digest(fs::read(path)?)))),
        )
    } else {
        (&["a", "b"], None, None)
    };
    for label in hosts {
        let path = root.join(label);
        await_file(&path, &path.join("ready"), Duration::from_secs(180))?;
    }
    let mut samples = Vec::new();
    for round in 0..warmups + measured {
        for _ in hosts {
            let request = request_at(hosts, samples.len(), warmups);
            let source = if request.host == "head" {
                head.as_ref().context("missing candidate source")?
            } else {
                &published
            };
            samples.push(assign(&root.join(&request.host), &request, source)?);
        }
        eprintln!("Captured round {} of {}", round + 1, warmups + measured);
    }
    let timings = by_host(hosts, &samples)?;
    let qualification = earlier.map(|(earlier, digest)| qualify(&timings, &earlier, &digest));
    let mut stdout = io::stdout().lock();
    serde_json::to_writer_pretty(
        &mut stdout,
        &json!({
            "schemaVersion": 2,
            "rotation": hosts,
            "warmupRounds": warmups,
            "measuredRounds": measured,
            "timings": timings,
            "timingQualification": qualification,
            "samples": samples,
        }),
    )?;
    stdout.write_all(b"\n")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAIRED: &str = include_str!(
        "../../../incumbent/observations/served-chromium-linux/migration-head-87ca7814/capture-timings.json"
    );
    const INCUMBENT: &str = include_str!(
        "../../../incumbent/observations/served-chromium-linux/migration-head-87ca7814/incumbent-timings.json"
    );

    #[test]
    fn a_paired_pass_cannot_override_the_incumbent_first_failure() -> Result<()> {
        let paired: EarlierReport = serde_json::from_str(PAIRED)?;
        let earlier: EarlierReport = serde_json::from_str(INCUMBENT)?;
        let result = qualify(&paired.timings, &earlier.timings, "example-digest");
        for host in ["a", "b"] {
            assert_eq!(result["paired"][host]["pass"], true);
            assert_eq!(result["incumbentFirst"][host]["pass"], false);
        }
        assert_eq!(result["pass"], false);
        Ok(())
    }

    #[test]
    fn rejects_missing_profile_or_composer_observation() -> Result<()> {
        let report: EarlierReport = serde_json::from_str(PAIRED)?;
        let original = &report.samples[0];
        let source = CaptureSource {
            source_sha: original.source_sha.clone(),
            archive_sha256: original.package_sha256.clone(),
        };
        validate_sample(original, &original.request, &source)?;
        let mut missing_profile: Sample = serde_json::from_value(serde_json::to_value(original)?)?;
        missing_profile.profile = Value::Null;
        assert!(validate_sample(&missing_profile, &original.request, &source).is_err());

        let mut missing_observation: Sample =
            serde_json::from_value(serde_json::to_value(original)?)?;
        missing_observation.trace[2]
            .as_object_mut()
            .unwrap()
            .remove("observed");
        assert!(validate_sample(&missing_observation, &original.request, &source).is_err());
        Ok(())
    }

    #[test]
    fn rejects_a_checksummed_truncated_png() -> Result<()> {
        let mut report: EarlierReport = serde_json::from_str(PAIRED)?;
        let sample = &mut report.samples[0];
        let png = include_bytes!(
            "../../../incumbent/observations/served-chromium-linux/migration-head-87ca7814/a/capture.png"
        );
        let mut image = tempfile::NamedTempFile::new()?;
        image.write_all(png)?;
        validate_png(sample, image.path())?;

        fs::write(image.path(), &png[..24])?;
        sample.screenshot_sha256 = format!("{:x}", Sha256::digest(&png[..24]));
        assert!(validate_png(sample, image.path()).is_err());
        Ok(())
    }
}
