use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    io::{self, Write},
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

#[derive(Debug, Deserialize, Serialize)]
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

#[derive(Debug, Serialize)]
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

fn assign(host: &Path, request: &CaptureRequest) -> Result<Sample> {
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
    ensure!(
        sample.request == *request,
        "sample does not match its capture request"
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
    let png = fs::read(result.with_extension("png"))?;
    ensure!(
        png.starts_with(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\x05\0\0\0\x04\xb0")
            && format!("{:x}", Sha256::digest(png)) == sample.screenshot_sha256,
        "sample screenshot is invalid or has a different digest"
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
        ]) && trace[0]["observed"]["replyVisible"] == true
            && trace[0]["observed"]["availableModel"] == true
            && trace[0]["observed"]["table"]
                == json!([
                    ["Step", "Tool", "Result"],
                    ["Read", "read", "1 file"],
                    ["Edit", "edit", "+4 lines"],
                    ["Test", "execute", "12 passed"],
                ])
            && trace[1]["observed"]["focusName"] == "Attach files",
        "sample did not record the settled thread and composer focus"
    );
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

fn main() -> Result<()> {
    let mut args = env::args_os().skip(1);
    let root = PathBuf::from(
        args.next()
            .context("usage: capture-timings CAPTURE_ROOT WARMUPS MEASURED [--candidate]")?,
    );
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
    let candidate = match args.next().as_deref() {
        None => false,
        Some(flag) if flag == "--candidate" => true,
        Some(_) => anyhow::bail!("unknown capture-timings option"),
    };
    ensure!(
        args.next().is_none() && measured > 0 && measured <= 100 && warmups <= 10,
        "invalid sample counts"
    );
    let hosts: &[&str] = if candidate {
        &["a", "head", "b"]
    } else {
        &["a", "b"]
    };
    for label in hosts {
        let path = root.join(label);
        await_file(&path, &path.join("ready"), Duration::from_secs(180))?;
    }
    let mut samples = Vec::new();
    for round in 0..warmups + measured {
        for offset in 0..hosts.len() {
            let host = hosts[(round + offset) % hosts.len()];
            let request = CaptureRequest {
                host: host.to_owned(),
                round,
                sequence: samples.len(),
                warmup: round < warmups,
                representative: round == warmups,
            };
            let sample = assign(&root.join(host), &request)?;
            if let Some(first) = samples.first() {
                let first: &Sample = first;
                ensure!(sample.profile == first.profile, "capture profile changed");
            }
            samples.push(sample);
        }
        eprintln!("Captured round {} of {}", round + 1, warmups + measured);
    }
    let timings = hosts
        .iter()
        .map(|host| {
            summarize(
                samples
                    .iter()
                    .filter(|sample| sample.request.host == *host && !sample.request.warmup),
            )
            .map(|timing| (*host, timing))
        })
        .collect::<Result<BTreeMap<_, _>>>()?;
    let comparisons: BTreeMap<_, _> = if candidate {
        ["a", "b"]
            .into_iter()
            .map(|baseline| {
                let incumbent = timings[baseline].p95_ns;
                let head = timings["head"].p95_ns;
                let delta = i128::from(head) - i128::from(incumbent);
                let within_relative = u128::from(head) * 100 <= u128::from(incumbent) * 115;
                let within_absolute = delta <= 2_000_000_000;
                (
                    baseline,
                    json!({
                        "deltaNs": delta,
                        "withinRelativeBudget": within_relative,
                        "withinAbsoluteBudget": within_absolute,
                        "pass": within_relative && within_absolute,
                    }),
                )
            })
            .collect()
    } else {
        BTreeMap::new()
    };
    let mut stdout = io::stdout().lock();
    serde_json::to_writer_pretty(
        &mut stdout,
        &json!({
            "schemaVersion": 1,
            "rotation": hosts,
            "warmupRounds": warmups,
            "measuredRounds": measured,
            "timings": timings,
            "comparisons": comparisons,
            "samples": samples,
        }),
    )?;
    stdout.write_all(b"\n")?;
    Ok(())
}
