//! Projects as the T3 shell snapshot describes them, and the rules of the "Add to another machine"
//! dialog (`AddProjectToMachineDialog.tsx`, `addProjectToMachine.ts`), so a project added from
//! Sail Boat ends up exactly as one added in Sail.

use serde::Serialize;
use serde_json::Value;

/// A project in a T3 shell snapshot that can be cloned elsewhere: it has a git remote.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub title: String,
    pub path: String,
    /// T3's repository grouping key: the same repository has it on every machine.
    pub repo_key: String,
    /// `data:` URL of the favicon Sail shows for it.
    pub icon: Option<String>,
    #[serde(skip)]
    pub remote_url: String,
    /// Where the project sits below its repository root, or "".
    #[serde(skip)]
    pub subdirectory: String,
    #[serde(skip)]
    pinned: bool,
    #[serde(skip)]
    updated_at: String,
}

/// T3's `repositoryGroupingKeyOf`: what its sidebar groups checkouts by.
pub fn repo_key(project: &Value) -> Option<String> {
    let identity = &project["repositoryIdentity"];
    identity["origin"]["canonicalKey"].as_str().or(identity["canonicalKey"].as_str()).map(str::to_owned)
}

/// The shell's live projects that have a remote, pinned first, then most recently used, as
/// Sail lists them.
pub fn cloneable(shell: &Value) -> Vec<Project> {
    let mut out: Vec<Project> = live(shell)
        .filter_map(|p| {
            let identity = &p["repositoryIdentity"];
            let remote_url = identity["origin"]["remoteUrl"].as_str().or(identity["locator"]["remoteUrl"].as_str())?;
            let path = p["workspaceRoot"].as_str()?.to_owned();
            Some(Project {
                id: p["id"].as_str()?.to_owned(),
                title: p["title"].as_str().unwrap_or_default().to_owned(),
                repo_key: repo_key(p)?,
                icon: p["faviconPath"].as_str().and_then(|f| icon_data_url(&std::path::Path::new(&path).join(f))),
                remote_url: remote_url.to_owned(),
                subdirectory: subdirectory(identity["rootPath"].as_str(), &path),
                pinned: !p["pinnedAt"].is_null(),
                updated_at: p["updatedAt"].as_str().unwrap_or_default().to_owned(),
                path,
            })
        })
        .collect();
    out.sort_by(|a, b| b.pinned.cmp(&a.pinned).then_with(|| b.updated_at.cmp(&a.updated_at)));
    out
}

/// The shell's projects that are not archived.
pub fn live(shell: &Value) -> impl Iterator<Item = &Value> {
    shell["projects"].as_array().into_iter().flatten().filter(|p| p["archivedAt"].is_null() && p["deletedAt"].is_null())
}

/// T3's `projectSubdirectory`.
fn subdirectory(repository_root: Option<&str>, workspace_root: &str) -> String {
    let Some(root) = repository_root else { return String::new() };
    let prefix = root.trim_end_matches(['/', '\\']);
    match workspace_root.strip_prefix(prefix) {
        Some(rest) if rest.starts_with(['/', '\\']) => rest[1..].replace('\\', "/"),
        _ => String::new(),
    }
}

/// Where the dialog clones to by default: `getCloneDestinationPath` of the target's
/// `addProjectBaseDirectory` and the repository's folder (`<host>/<owner>/<repo>` with its ghq
/// layout on, which is the repository key).
pub fn clone_destination(target_settings: &Value, project: &Project) -> String {
    let base = target_settings["addProjectBaseDirectory"].as_str().unwrap_or_default().trim();
    let base = if base.is_empty() {
        "~/".to_owned()
    } else {
        let anchored = base == "~" || base.starts_with(['/', '~']) || base == "." || base == ".." || base.starts_with("./") || base.starts_with("../");
        let base = if anchored { base.to_owned() } else { format!("~/{base}") };
        if base.ends_with('/') { base } else { format!("{base}/") }
    };
    let folder = if target_settings["ghqCloneLayout"] == true {
        project.repo_key.clone()
    } else {
        clone_directory_name(&project.remote_url)
    };
    format!("{base}{folder}")
}

/// T3's `getCloneDirectoryName`: the URL's last path segment without `.git`.
fn clone_directory_name(url: &str) -> String {
    let url = url.split(['?', '#']).next().unwrap_or_default().trim();
    let last = url.rsplit(['/', '\\', ':']).find(|s| !s.trim().is_empty()).unwrap_or_default();
    last.strip_suffix(".git").unwrap_or(last).to_owned()
}

/// The dialog's "Clone over: HTTPS" choice: a new machine has no SSH key, while HTTPS works
/// with the git host sign-in Sail sets up there. Other URLs stay as they are.
pub fn https_clone_url(url: &str) -> String {
    let url = url.trim();
    let ssh = url.strip_prefix("ssh://").map(|rest| {
        let rest = rest.split_once('@').map_or(rest, |(_, r)| r);
        let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
        (host.split(':').next().unwrap_or(host).to_owned(), path.to_owned())
    });
    let scp = || {
        let (user_host, path) = url.split_once(':')?;
        let host = user_host.split_once('@').map_or(user_host, |(_, h)| h);
        (!url.contains("://") && !host.is_empty() && !path.starts_with('/')).then(|| (host.to_owned(), path.to_owned()))
    };
    match ssh.or_else(scp) {
        Some((host, path)) if !path.is_empty() => format!("https://{host}/{path}"),
        _ => url.to_owned(),
    }
}

/// `isDefaultCopiedFile`: env files are the ignored files people almost always want on a new
/// machine, so the dialog picks them by default.
pub fn copied_by_default(path: &str, byte_length: u64) -> bool {
    const MAX_BYTES: u64 = 1024 * 1024;
    let name = path.rsplit('/').next().unwrap_or(path);
    let env = name == ".env" || name == ".envrc" || name == ".dev.vars" || name.strip_prefix(".env.").is_some_and(|rest| !rest.is_empty());
    env && byte_length <= MAX_BYTES
}

/// Small image files only: they go to the UI inline.
fn icon_data_url(file: &std::path::Path) -> Option<String> {
    use base64::Engine;
    const MAX_ICON_BYTES: u64 = 64 * 1024;
    let mime = match file.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => return None,
    };
    if std::fs::metadata(file).ok()?.len() > MAX_ICON_BYTES {
        return None;
    }
    let bytes = std::fs::read(file).ok()?;
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn project(remote_url: &str) -> Project {
        Project {
            id: "p".into(),
            title: "kickstart".into(),
            path: "/Users/you/Dev/kickstart".into(),
            repo_key: "github.com/you/kickstart".into(),
            icon: None,
            remote_url: remote_url.into(),
            subdirectory: String::new(),
            pinned: false,
            updated_at: String::new(),
        }
    }

    #[test]
    fn clones_where_t3_would() {
        let p = project("git@github.com:you/kickstart.git");
        assert_eq!(clone_destination(&json!({}), &p), "~/kickstart");
        assert_eq!(clone_destination(&json!({"addProjectBaseDirectory": "Dev"}), &p), "~/Dev/kickstart");
        assert_eq!(clone_destination(&json!({"addProjectBaseDirectory": "/srv/code/"}), &p), "/srv/code/kickstart");
        assert_eq!(
            clone_destination(&json!({"addProjectBaseDirectory": "~/src", "ghqCloneLayout": true}), &p),
            "~/src/github.com/you/kickstart"
        );
    }

    #[test]
    fn clones_over_https() {
        assert_eq!(https_clone_url("git@github.com:you/kickstart.git"), "https://github.com/you/kickstart.git");
        assert_eq!(https_clone_url("ssh://git@gitlab.com:22/you/kickstart.git"), "https://gitlab.com/you/kickstart.git");
        assert_eq!(https_clone_url("https://github.com/you/kickstart.git"), "https://github.com/you/kickstart.git");
    }

    #[test]
    fn copies_env_files_by_default() {
        assert!(copied_by_default(".env", 10));
        assert!(copied_by_default("apps/web/.env.local", 10));
        assert!(copied_by_default(".dev.vars", 10));
        assert!(!copied_by_default(".env.", 10));
        assert!(!copied_by_default("notes.env", 10));
        assert!(!copied_by_default(".env", 2 * 1024 * 1024));
    }

    #[test]
    fn lists_projects_with_a_remote() {
        let shell = json!({"projects": [
            {"id": "a", "title": "a", "workspaceRoot": "/r/a/pkg", "updatedAt": "2026-01-01", "pinnedAt": null, "archivedAt": null,
             "repositoryIdentity": {"canonicalKey": "github.com/x/a", "rootPath": "/r/a", "locator": {"remoteUrl": "https://github.com/x/a.git"}}},
            {"id": "b", "title": "b", "workspaceRoot": "/r/b", "updatedAt": "2026-02-01", "archivedAt": null, "repositoryIdentity": null},
            {"id": "c", "title": "c", "workspaceRoot": "/r/c", "updatedAt": "2026-03-01", "archivedAt": "x",
             "repositoryIdentity": {"canonicalKey": "github.com/x/c", "locator": {"remoteUrl": "https://github.com/x/c.git"}}},
        ]});
        let listed = cloneable(&shell);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].subdirectory, "pkg");
    }
}
