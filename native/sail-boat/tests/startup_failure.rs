use std::process::{Command, Output, Stdio};

fn start_with_a_bad_port(stdout: Stdio) -> Output {
    Command::new(env!("CARGO_BIN_EXE_sail-boatd"))
        .env_clear()
        .env("SAIL_BOAT_CONTROL_PORT", "not-a-port")
        .env(
            "SAIL_BOAT_DATA_DIR",
            std::env::temp_dir().join("sail-boatd-startup-failure"),
        )
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(Stdio::piped())
        .output()
        .expect("sail-boatd runs")
}

#[test]
fn a_failed_start_reports_its_reason_as_one_json_line_on_stdout() {
    let output = start_with_a_bad_port(Stdio::piped());

    assert!(!output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("stdout is UTF-8");
    let lines: Vec<&str> = stdout.lines().collect();
    assert_eq!(
        lines.len(),
        1,
        "stdout carries only the startup line: {stdout:?}"
    );
    let line: serde_json::Value = serde_json::from_str(lines[0]).expect("the line is JSON");
    assert_eq!(line["ready"], false);
    assert!(
        line["error"]
            .as_str()
            .is_some_and(|error| error.contains("SAIL_BOAT_CONTROL_PORT")),
        "the reason names what failed: {line}"
    );
}

#[test]
fn a_failed_start_keeps_its_reason_when_stdout_is_gone() {
    let (reader, writer) = std::io::pipe().expect("pipe");
    drop(reader);

    let output = start_with_a_bad_port(writer.into());

    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).expect("stderr is UTF-8");
    assert!(
        stderr.contains("SAIL_BOAT_CONTROL_PORT"),
        "stderr names the startup error, not the closed pipe: {stderr:?}"
    );
}
