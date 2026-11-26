use std::process::{Command, Stdio};

#[test]
fn a_failed_start_reports_its_reason_as_one_json_line_on_stdout() {
    let output = Command::new(env!("CARGO_BIN_EXE_sail-boatd"))
        .env("SAIL_BOAT_CONTROL_PORT", "not-a-port")
        .stdin(Stdio::null())
        .output()
        .expect("sail-boatd runs");

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
