//! The machine's projects, and adding one the way Sail's "Add to another machine" does:
//! `projectClone.start` on the machine's server, which clones and registers the project and
//! shows its progress in Sail, then the env files written in with `projects.writeFile`.

use super::{MachineRuntime, Power};
use crate::projects::{self, Project};
use crate::proxy::upstream;
use anyhow::{bail, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

/// Long enough for a large repository on a slow link.
const CLONE_TIMEOUT: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineProject {
    /// T3's project id on the machine; while Sail Boat adds it, the local project's id.
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_project_id: Option<String>,
    pub title: String,
    pub repo_key: Option<String>,
    /// Set while Sail Boat adds it: how far that is, as Sail words clone progress.
    pub status: Option<String>,
}

impl MachineRuntime {
    /// Its projects as last seen: on the machine when it last ran or slept. Never wakes it.
    pub fn projects(&self) -> Vec<MachineProject> {
        let adding = self.adding.lock().unwrap().clone();
        let mut out: Vec<MachineProject> = self
            .projects
            .lock()
            .unwrap()
            .iter()
            .filter(|p| !adding.iter().any(|a| a.repo_key.is_some() && a.repo_key == p.repo_key))
            .cloned()
            .collect();
        let record = self.record.read().unwrap();
        for project in &mut out {
            project.origin_project_id = record.project_origins.get(&project.id).cloned();
        }
        out.extend(adding);
        out
    }

    pub(super) fn set_projects_from(&self, shell: &Value) {
        let scratch = self.cache.lock().unwrap().scratch_root();
        let projects = projects::live(shell)
            // Sail lists its scratch folder as "No project", not as a project.
            .filter(|p| scratch.is_none() || p["workspaceRoot"].as_str() != scratch.as_deref())
            .map(|p| MachineProject {
                id: p["id"].as_str().unwrap_or_default().to_owned(),
                origin_project_id: None,
                title: p["title"].as_str().unwrap_or_default().to_owned(),
                repo_key: projects::repo_key(p),
                status: None,
            })
            .collect();
        *self.projects.lock().unwrap() = projects;
        self.shared.changed();
    }

    /// Reads the projects from the machine if it runs.
    pub async fn refresh_projects(&self) {
        if self.power() != Power::Running {
            return;
        }
        match self.shell_snapshot().await {
            Ok(shell) => self.set_projects_from(&shell),
            Err(e) => tracing::warn!("reading projects on {}: {e:#}", self.id()),
        }
    }

    /// Clones `project` from this computer's Sail onto the machine and copies `files` (path,
    /// contents) into it. Resolves when the clone is done; the project shows in Sail, with
    /// the clone's progress, as soon as it starts.
    pub async fn add_project(&self, project: &Project, files: Vec<(String, String)>) -> Result<Vec<String>> {
        if self.projects.lock().unwrap().iter().any(|p| p.repo_key.as_deref() == Some(&project.repo_key)) {
            bail!("{} is already on {}", project.title, self.record().name);
        }
        {
            let mut adding = self.adding.lock().unwrap();
            if adding.iter().any(|a| a.repo_key.as_deref() == Some(&project.repo_key)) {
                bail!("{} is already being added", project.title);
            }
            adding.push(MachineProject {
                id: project.id.clone(),
                origin_project_id: None,
                title: project.title.clone(),
                repo_key: Some(project.repo_key.clone()),
                status: Some("Waking the machine".into()),
            });
        }
        self.shared.changed();
        let result = async {
            self.ensure_awake().await?;
            self.kept_awake(self.clone_project(project, files)).await
        }
        .await;
        self.adding.lock().unwrap().retain(|a| a.repo_key.as_deref() != Some(&project.repo_key));
        self.refresh_projects().await;
        self.shared.changed();
        result
    }

    /// Returns the files that could not be copied; the log says why.
    async fn clone_project(&self, project: &Project, files: Vec<(String, String)>) -> Result<Vec<String>> {
        let (url, token) = (self.upstream_url(), self.upstream_token());
        let config = upstream::call(&url, &token, "server.getConfig", json!({})).await?;
        let started = upstream::call(
            &url,
            &token,
            "projectClone.start",
            json!({
                "projectId": uuid(),
                "title": project.title,
                "createdAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                "remoteUrl": projects::https_clone_url(&project.remote_url),
                "destinationPath": projects::clone_destination(&config["settings"], project),
            }),
        )
        .await
        .map_err(|e| explain_clone_failure(e, &self.record().name))?;
        // The server clones for the existing project when one already owns the destination.
        let project_id = started["projectId"].as_str().unwrap_or_default().to_owned();
        let cwd = started["cwd"].as_str().unwrap_or_default().to_owned();
        self.set_adding_status(&project.repo_key, "Connecting");

        let (outcome, _) = upstream::subscribe_until(&url, &token, "subscribeProjectClones", json!({}), CLONE_TIMEOUT, |clones| {
            let clone = clones.as_array()?.iter().find(|c| c["projectId"] == project_id.as_str())?;
            match clone["phase"].as_str()? {
                "done" => Some(Ok(())),
                "failed" => Some(Err(clone["error"].as_str().unwrap_or("the clone failed").to_owned())),
                "cancelled" => Some(Err("the clone was cancelled in Sail".to_owned())),
                _ => {
                    self.set_adding_status(&project.repo_key, &progress(clone));
                    None
                }
            }
        })
        .await?;
        match outcome {
            Some(Ok(())) => {}
            Some(Err(e)) => return Err(explain_clone_failure(anyhow::anyhow!(e), &self.record().name)),
            None => bail!("Sail stopped reporting the clone"),
        }
        self.record_project_origin(project_id, project.id.clone());

        let mut failed = Vec::new();
        for (path, contents) in files {
            let relative = if project.subdirectory.is_empty() { path.clone() } else { format!("{}/{path}", project.subdirectory) };
            let written = upstream::call(
                &url,
                &token,
                "projects.writeFile",
                json!({ "cwd": cwd, "relativePath": relative, "contents": contents }),
            )
            .await;
            if let Err(e) = written {
                tracing::warn!("writing {path} on {}: {e:#}", self.id());
                failed.push(path);
            }
        }
        Ok(failed)
    }

    fn record_project_origin(&self, destination_id: String, source_id: String) {
        self.update_record(|record| {
            record.project_origins.insert(destination_id, source_id);
        });
    }

    fn set_adding_status(&self, repo_key: &str, status: &str) {
        if let Some(a) = self.adding.lock().unwrap().iter_mut().find(|a| a.repo_key.as_deref() == Some(repo_key)) {
            a.status = Some(status.to_owned());
        }
        self.shared.changed();
    }
}

/// T3's `projectCloneProgressSummary`: "Receiving objects · 42% · 1.2 MiB/s".
fn progress(clone: &Value) -> String {
    let stage = match clone["stage"].as_str().unwrap_or_default() {
        "counting" => "Counting objects",
        "receiving" => "Receiving objects",
        "resolving" => "Resolving deltas",
        "checkout" => "Checking out files",
        _ => "Connecting",
    };
    let mut parts = vec![stage.to_owned()];
    if let Some(percent) = clone["percent"].as_u64() {
        parts.push(format!("{percent}%"));
    }
    if clone["stalled"] == true {
        parts.push("Stalled".into());
    } else if let Some(detail) = clone["detail"].as_str().filter(|d| !d.is_empty()) {
        parts.push(detail.to_owned());
    }
    parts.join(" · ")
}

/// A clone the git host turned away: the machine's git uses the GitHub login Boat gives every
/// sandbox, the one of the Boat account.
fn explain_clone_failure(e: anyhow::Error, machine: &str) -> anyhow::Error {
    let text = format!("{e:#}");
    let auth = ["Authentication failed", "could not read Username", "Permission denied", "Repository not found", "terminal prompts disabled"]
        .iter()
        .any(|s| text.contains(s));
    if auth {
        anyhow::anyhow!("{text}\n{machine} uses the GitHub login of your Boat account, which has no access to this repo.")
    } else {
        e
    }
}

/// A random v4 UUID, the form of T3's project ids.
fn uuid() -> String {
    let b: [u8; 16] = rand::random();
    let hex = |r: std::ops::Range<usize>| b[r].iter().map(|x| format!("{x:02x}")).collect::<String>();
    format!(
        "{}-{}-4{}-{:x}{}-{}",
        hex(0..4),
        hex(4..6),
        &hex(6..8)[1..],
        8 | (b[8] & 0x3),
        &hex(8..10)[1..],
        hex(10..16)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boat::Boat;
    use crate::machine::{Event, Shared};
    use crate::store::{Machine, Settings};
    use crate::t3desktop::T3Desktop;
    use std::sync::{Arc, Mutex, RwLock};

    fn old_machine_record() -> Machine {
        serde_json::from_value(json!({
            "id": "machine",
            "sandboxId": "sandbox",
            "name": "Boat",
            "size": "small",
            "upstreamUrl": "",
            "upstreamToken": "",
            "watchdogUrl": "",
            "watchdogSecret": "",
            "localPort": 0,
            "t3Version": "",
            "provisionRevision": "",
            "environmentId": "environment",
            "clientTokens": [],
            "linkTokens": [],
            "createdAt": 0
        }))
        .unwrap()
    }

    #[test]
    fn project_origins_round_trip_and_default_empty() {
        let mut record = old_machine_record();
        assert!(record.project_origins.is_empty());
        record
            .project_origins
            .insert("destination".into(), "source".into());
        let encoded = serde_json::to_value(&record).unwrap();
        assert_eq!(encoded["projectOrigins"], json!({"destination": "source"}));
        assert_eq!(serde_json::from_value::<Machine>(encoded).unwrap(), record);
    }

    #[test]
    fn project_origins_use_destination_ids_on_the_owning_machine() {
        let dir = tempfile::tempdir().unwrap();
        let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let shared = Arc::new(Shared {
            boat: Boat::at(dir.path().join("boat")),
            t3: T3Desktop::at(dir.path().join("t3")),
            settings: RwLock::new(Settings::default()),
            events,
            http: reqwest::Client::new(),
            saving: Mutex::new(Default::default()),
        });
        let mut record = old_machine_record();
        record
            .project_origins
            .insert("previous".into(), "older-source".into());
        let machine = MachineRuntime::new(shared.clone(), record, dir.path().join("first"));
        let mut other_record = old_machine_record();
        other_record.id = "another-machine".into();
        let other = MachineRuntime::new(shared.clone(), other_record, dir.path().join("second"));
        let shell = json!({"projects": [
            {"id": "returned-id", "title": "Renamed", "repositoryIdentity": {"canonicalKey": "same-repo"}},
            {"id": "existing", "title": "Renamed", "repositoryIdentity": {"canonicalKey": "same-repo"}},
            {"id": "previous", "title": "Previous"}
        ]});
        machine.set_projects_from(&shell);
        other.set_projects_from(&shell);
        machine.record_project_origin("returned-id".into(), "source-id".into());
        machine.record_project_origin("returned-id".into(), "source-id".into());
        assert!(
            std::iter::from_fn(|| receiver.try_recv().ok())
                .any(|event| matches!(event, Event::Persist))
        );

        let reloaded =
            serde_json::from_value(serde_json::to_value(machine.record()).unwrap()).unwrap();
        let restored = MachineRuntime::new(shared, reloaded, dir.path().join("restored"));
        restored.set_projects_from(&shell);
        for view in [machine.projects(), restored.projects()] {
            let encoded = serde_json::to_value(view).unwrap();
            assert_eq!(encoded[0]["originProjectId"], "source-id");
            assert_eq!(encoded[0]["id"], "returned-id");
            assert!(encoded[1].get("originProjectId").is_none());
            assert_eq!(encoded[2]["originProjectId"], "older-source");
        }
        assert!(
            other
                .projects()
                .iter()
                .all(|p| p.origin_project_id.is_none())
        );
    }

    #[test]
    fn uuids_are_v4() {
        let id = uuid();
        assert_eq!(id.len(), 36);
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(parts.iter().map(|p| p.len()).collect::<Vec<_>>(), [8, 4, 4, 4, 12]);
        assert!(parts[2].starts_with('4'));
        assert!(matches!(parts[3].chars().next(), Some('8' | '9' | 'a' | 'b')));
    }

    #[test]
    fn words_progress_like_t3() {
        let c = serde_json::json!({"stage": "receiving", "percent": 42, "detail": "1.2 MiB/s", "stalled": false});
        assert_eq!(progress(&c), "Receiving objects · 42% · 1.2 MiB/s");
    }
}
