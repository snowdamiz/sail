//! What the proxy may do with each T3 RPC while the machine sleeps. Anything not listed needs
//! the live machine: unknown methods wake it, which is always safe.

use serde_json::Value;

/// Answered locally while asleep: fire-and-forget signals whose result is void. Waking for them
/// would keep the machine up just because the app is open.
const VOID_SIGNALS: &[&str] = &["pullRequests.invalidate", "vcs.refreshBranch"];

/// `*.report*` calls (`server.reportClientActivity`, `preview.reportProfiles`, ...) are the app
/// describing itself, never a request for work.
pub fn is_void_signal(tag: &str) -> bool {
    VOID_SIGNALS.contains(&tag) || tag.contains(".report")
}

/// Live tails that carry nothing while asleep: held open, silent. `subscribePreviewEvents` is
/// a feed of tab events with no snapshot: replayed, it would reopen some tabs of an earlier
/// session. `provider.install.subscribe` is a background probe: no install runs on a sleeping
/// machine.
pub const SILENT_STREAMS: &[&str] =
    &["orchestration.subscribePromptSuggestion", "provider.install.subscribe", "subscribePreviewEvents"];

/// Calls Sail makes on its own. While asleep they get their last answer from any epoch, or
/// fail: they must never wake the machine. `assets.createUrl` is the URL of an image a chat
/// shows: failing it frees Sail's few slots for the images that are stored.
const BACKGROUND_PROBES: &[&str] = &[
    "server.refreshProviders",
    "server.discoverSourceControl",
    "server.searchAcpRegistry",
    "agentSessions.scan",
    "vcs.refreshStatus",
    "assets.createUrl",
    // The icons of the files a chat names: a new set of paths with every chat.
    "filesystem.getMetadata",
];

/// A background probe in the shape Sail sends on its own; in any other a person asked.
/// `server.searchAcpRegistry` lists the registry with an empty `query` and searches it with a
/// typed one. `server.refreshProviders` reloads the secrets only for the Refresh button of
/// the provider settings.
pub fn is_background_probe(tag: &str, payload: &Value) -> bool {
    BACKGROUND_PROBES.contains(&tag)
        && match tag {
            "server.searchAcpRegistry" => payload["query"] == "",
            "server.refreshProviders" => payload["reloadSecrets"] != true,
            _ => true,
        }
}

/// Thread UI writes that may wait for the next wake; the server dedupes them by `commandId`.
pub const DEFERRABLE_COMMANDS: &[&str] = &["thread.visit", "thread.mark-unread"];

/// A message sent to a sleeping machine: accepted at once, then delivered as the wake it starts
/// completes. A wake outlasts Sail's 15 s slow-request warning; the message shows as sent
/// meanwhile.
pub const WAKING_COMMANDS: &[&str] = &["message.dispatch"];

pub enum Recording {
    /// Snapshot first, then deltas: replay every item in order.
    All,
    /// Every item is the full state: keep only the latest.
    Latest,
    /// `subscribeServerConfig`: a snapshot, then events that each replace one part of it.
    Config,
    /// Only the frame that ends it: a finished command's whole output. Sail closes the
    /// stream itself on that frame, so its replay needs no end of its own.
    Final,
}

/// Snapshot-first subscriptions whose recorded items replay to a fresh subscriber. Orchestration
/// shell and thread streams are not here: they carry cursors and are answered from the capture
/// and the thread store. A command's output is asked for by the person who expands its row:
/// held silent the row would load forever, so it replays once seen finished and wakes before.
pub fn recorded_stream(tag: &str) -> Option<Recording> {
    Some(match tag {
        "subscribeServerConfig" => Recording::Config,
        "subscribeServerLifecycle"
        | "subscribeAuthAccess"
        | "subscribeResourceTelemetry"
        | "subscribeTerminalMetadata"
        | "subscribeVcsStatus"
        | "subscribeVcsBranch"
        | "pullRequests.subscribeRefreshes"
        | "pullRequests.subscribeLinkedThreadRefreshes" => Recording::All,
        "scheduledTasks.subscribe"
        | "subscribeProjectClones"
        | "subscribeDeviceState"
        | "subscribeDiscoveredLocalServers" => Recording::Latest,
        "orchestration.subscribeCommandOutput" => Recording::Final,
        _ => return None,
    })
}

/// Streams every connect opens. Replayed even without a capture: connecting must never wake.
pub fn is_connection_stream(tag: &str) -> bool {
    matches!(
        tag,
        "subscribeServerConfig"
            | "subscribeServerLifecycle"
            | "subscribeAuthAccess"
            | "subscribeProjectClones"
            | "subscribeDeviceState"
    )
}

/// `device.list` that retries a device host or updates its tooling: an action, not a read.
fn is_device_list_action(tag: &str, payload: &Value) -> bool {
    tag == "device.list" && (!payload["retryHostId"].is_null() || !payload["updateTool"].is_null())
}

/// Unary reads whose last answer stays true while nothing changes on the machine, and the
/// background probes.
pub fn recorded_unary(tag: &str, payload: &Value) -> bool {
    !is_device_list_action(tag, payload)
        && (BACKGROUND_PROBES.contains(&tag)
            || matches!(
                tag,
                "server.getConfig"
                    | "server.getHostResources"
                    | "server.getUsageSummary"
                    | "server.listAcpRegistryProviders"
                    | "peerLinks.list"
                    | "cloud.getRelayClientStatus"
                    | "orchestration.getTurnDiff"
                    | "orchestration.getFullThreadDiff"
                    | "orchestration.getArchivedShellSnapshot"
                    | "orchestration.getThreadFamily"
                    | "orchestration.getThreadTitles"
                    | "orchestration.getThreadLinkMetadata"
                    | "orchestration.getWorktreeThreadIds"
                    | "orchestration.getOlderSettledThreads"
                    | "orchestration.getTurnItem"
                    | "mcpApps.toolInfo"
                    | "mcpApps.readResource"
                    | "projects.listEntries"
                    | "projects.readFile"
                    | "filesystem.browse"
                    | "review.getBranchCommits"
                    | "review.getDiffPreview"
                    | "review.getDiffFileContents"
                    | "vcs.listRefs"
                    | "pullRequests.list"
                    | "pullRequests.listStats"
                    | "pullRequests.summary"
                    | "pullRequests.detail"
                    | "pullRequests.checks"
                    | "pullRequests.routing"
                    | "sourceControl.lookupRepository"
                    | "device.list"
            ))
}

/// What Sail asks for on its own as it starts and as a chat opens, only to show it around
/// the chat: git status, branch, terminals, servers, the pull request's badge and checks,
/// linked chats, the count of older chats, the branch list, the changed-files count. Served as
/// last seen, and never worth a wake: with nothing recorded the request waits, which is only
/// right because nothing a person does waits for it in turn.
///
/// Worktree setup and a chat's preview tabs wait too but are never recorded: a setup replayed
/// as still running would hold Send, and a list replayed as empty would close the tabs.
const SIDE_INFO: &[&str] = &[
    "subscribeVcsStatus",
    "subscribeVcsBranch",
    "subscribeWorktreeSetup",
    "subscribeTerminalMetadata",
    "subscribeDiscoveredLocalServers",
    "preview.list",
    "pullRequests.subscribeRefreshes",
    "pullRequests.summary",
    "pullRequests.checks",
    "orchestration.getThreadLinkMetadata",
];

/// Side information, or a call in the one shape Sail sends on its own: in any other a
/// person asked for it. `orchestration.getOlderSettledThreads` counts with `limit: 0` and
/// lists the chats under "Show more" otherwise. `vcs.listRefs` with a `query` is a search
/// (bar the `limit: 10` lookup of the chat's own branch; `limit: 1` confirms that a worktree
/// has a branch checked out before Sail reuses it), with a `cursor` a further page.
/// `review.getDiffPreview` with `metadataOnly` is the branch's changed-files count; otherwise
/// the files of a commit or of the working tree someone picked, or the diff someone reads.
pub fn is_side_info(tag: &str, payload: &Value) -> bool {
    SIDE_INFO.contains(&tag)
        || match tag {
            "orchestration.getOlderSettledThreads" => payload["limit"] == 0,
            "vcs.listRefs" => payload["cursor"].is_null() && (payload["query"].is_null() || payload["limit"] == 10),
            "review.getDiffPreview" => payload["metadataOnly"] == true && payload["sourceKind"] == "branch-range",
            _ => false,
        }
}

/// Served as last seen, whatever the epoch: side information, and what Sail sends on its
/// own in the very shape a person also waits for: the linked machines (Send), a pull request
/// (a quick merge, the checks popover), the title of the chat that delegated this one, the
/// archived chats (their settings page), the chats under "Show more", the files of a commit
/// or of the working tree, an MCP app's tool definition and resources (a tool call, a click
/// in the app, an approved download). With nothing recorded those wake the machine: left
/// waiting, the person would wait too.
pub fn serves_last_seen(tag: &str, payload: &Value) -> bool {
    is_side_info(tag, payload)
        || matches!(
            tag,
            "peerLinks.list"
                | "orchestration.getThreadTitles"
                | "orchestration.getArchivedShellSnapshot"
                | "orchestration.getOlderSettledThreads"
                | "pullRequests.detail"
                | "mcpApps.toolInfo"
                | "mcpApps.readResource"
        )
        || tag == "review.getDiffPreview" && payload["metadataOnly"] == true
}

/// Requests from a person at the keyboard: they keep the machine awake. An allow-list, so
/// whatever the app sends on its own never does.
pub fn is_user_action(tag: &str, payload: &Value) -> bool {
    const PREFIXES: &[&str] =
        &["terminal.", "provider.", "scheduledTasks.", "projectClone.", "worktreeSetup.", "preview.", "device."];
    const ACTIONS: &[&str] = &[
        "orchestration.dispatchCommand",
        "orchestration.launchThread",
        "orchestration.stopWorkflow",
        "orchestration.forceStopThread",
        "projects.writeFile",
        "projects.mutate",
        "projects.ensureScratch",
        "projects.createNew",
        "projects.createFromThread",
        "shell.openInEditor",
        "assets.persistChatAttachments",
        "attachments.createUploadUrl",
        "attachments.delete",
        "vcs.pull",
        "vcs.createWorktree",
        "vcs.removeWorktree",
        "vcs.createRef",
        "vcs.switchRef",
        "vcs.init",
        "git.runStackedAction",
        "git.preparePullRequestThread",
        "sourceControl.cloneRepository",
        "sourceControl.publishRepository",
        "sourceControl.signInStart",
        "sourceControl.signInWait",
        "sourceControl.signInCancel",
        "sourceControl.star",
        "server.updateSettings",
        "server.updateProvider",
        "server.upsertKeybinding",
        "server.removeKeybinding",
        "server.runStorageCleanup",
        "server.reclaimDatabaseSpace",
        "server.updateServer",
        "server.updateServerWithProgress",
        "server.signalProcess",
        "server.setAcpRegistryProvider",
        "server.disableAcpRegistryProvider",
        "server.logoutAcpRegistry",
        "server.importAcpRegistrySession",
        "server.deleteAcpRegistrySession",
        "server.prepareAcpRegistryAgent",
        "server.uninstallAcpRegistryManagedBinary",
        "server.acceptAcpRegistryUrlAuth",
        "peerLinks.link",
        "peerLinks.unlink",
        "peerLinks.answerRequest",
        "guestShare.create",
        "cloud.installRelayClient",
        "secrets.answerRequest",
        "secrets.saveProjectCredential",
        "secrets.syncProjectCredentials",
        "sessionTransfer.prepareSource",
        "sessionTransfer.stageImport",
        "sessionTransfer.commitImport",
        "sessionTransfer.finalizeSource",
        "sessionTransfer.abort",
        "sessionTransfer.start",
        "sessionTransfer.cancel",
        "sessionTransfer.retry",
    ];
    let passive = matches!(tag, "terminal.observe" | "provider.install.subscribe" | "device.detail")
        || tag.starts_with("scheduledTasks.subscribe")
        || is_void_signal(tag)
        || tag.contains(".list")
        || tag.contains(".get");
    is_device_list_action(tag, payload)
        || !passive
            && (ACTIONS.contains(&tag) || PREFIXES.iter().any(|p| tag.starts_with(p)) || is_pull_request_write(tag))
}

fn is_pull_request_write(tag: &str) -> bool {
    matches!(
        tag.strip_prefix("pullRequests."),
        Some(
            "setFilesViewed"
                | "runAction"
                | "update"
                | "comment"
                | "updateComment"
                | "submitReview"
                | "replyToThread"
                | "setThreadResolution"
                | "setReaction"
                | "requestReviewers"
                | "setLabels"
                | "generateReviewGuide"
        )
    )
}

/// Streams that never end on their own.
pub fn is_subscription(tag: &str) -> bool {
    tag.starts_with("subscribe") || tag.contains(".subscribe") || matches!(tag, "terminal.observe" | "terminal.attach")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Side information in the one shape T3 Code sends on its own.
    const SHAPED: [(&str, &str); 3] = [
        ("vcs.listRefs", r#"{"cwd":"/w","limit":100}"#),
        ("review.getDiffPreview", r#"{"cwd":"/w","metadataOnly":true,"sourceKind":"branch-range"}"#),
        ("orchestration.getOlderSettledThreads", r#"{"before":{"settledAt":"t"},"limit":0}"#),
    ];
    const NEVER_RECORDED: [&str; 2] = ["subscribeWorktreeSetup", "preview.list"];

    #[test]
    fn side_info_is_what_a_chat_shows_not_what_a_person_asks_for() {
        for (tag, payload) in SHAPED {
            assert!(is_side_info(tag, &serde_json::from_str(payload).unwrap()), "{tag}");
        }
        // The lookup of a chat's own branch.
        assert!(is_side_info("vcs.listRefs", &json!({"cwd": "/w", "query": "main", "limit": 10})));
        // A search, a further page, the worktree check before a branch switch: true now or not at all.
        for asked in [
            json!({"cwd": "/w", "query": "ma", "limit": 100}),
            json!({"cwd": "/w", "cursor": 100, "limit": 100}),
            json!({"cwd": "/w", "query": "main", "refKind": "local", "limit": 1}),
        ] {
            assert!(!serves_last_seen("vcs.listRefs", &asked), "{asked}");
        }
        assert!(!serves_last_seen("review.getDiffPreview", &json!({"cwd": "/w", "file": "a.rs"})));
        assert!(!is_side_info("projects.readFile", &json!({"cwd": "/w", "limit": 10})));
        assert!(!is_side_info("pullRequests.runAction", &json!({"number": 1})));
    }

    #[test]
    fn side_info_is_recorded_unless_a_stale_answer_would_break() {
        for tag in SIDE_INFO {
            let recorded = recorded_stream(tag).is_some() || recorded_unary(tag, &json!({}));
            assert_eq!(recorded, !NEVER_RECORDED.contains(tag), "{tag}");
            assert!(!is_user_action(tag, &json!({})), "{tag}");
        }
        for (tag, payload) in SHAPED {
            let payload = serde_json::from_str(payload).unwrap();
            assert!(recorded_unary(tag, &payload) && !is_user_action(tag, &payload), "{tag}");
        }
        for tag in SILENT_STREAMS {
            assert!(recorded_stream(tag).is_none(), "{tag}");
        }
    }

    #[test]
    fn what_a_person_also_asks_for_wakes_when_unrecorded() {
        let awaited = [
            ("peerLinks.list", json!({})),
            ("orchestration.getThreadTitles", json!({})),
            ("orchestration.getArchivedShellSnapshot", json!({})),
            ("orchestration.getOlderSettledThreads", json!({"before": {"settledAt": "t"}, "limit": 25})),
            // A chat's pull request row and the read before a quick merge; the checks popover.
            ("pullRequests.detail", json!({"number": 1, "allowStale": false})),
            ("pullRequests.detail", json!({"number": 1})),
            ("review.getDiffPreview", json!({"cwd": "/w", "metadataOnly": true, "commitSha": "c"})),
            ("review.getDiffPreview", json!({"cwd": "/w", "metadataOnly": true, "sourceKind": "working-tree"})),
            ("mcpApps.toolInfo", json!({"threadId": "t", "itemId": "i", "name": "n"})),
            ("mcpApps.readResource", json!({"threadId": "t", "itemId": "i", "uri": "u"})),
        ];
        for (tag, payload) in awaited {
            let served =
                !is_side_info(tag, &payload) && serves_last_seen(tag, &payload) && recorded_unary(tag, &payload);
            assert!(served, "{tag} {payload}");
        }
        // The automations: replayed, but their settings page waits for them.
        assert!(!is_side_info("scheduledTasks.subscribe", &json!({})));
        assert!(recorded_stream("scheduledTasks.subscribe").is_some());
        // Starting a thread from a pull request is asked for, never sent on its own.
        assert!(!BACKGROUND_PROBES.contains(&"git.resolvePullRequest"));
        assert!(!recorded_unary("git.resolvePullRequest", &json!({})));
        // A command's output is read by expanding its row.
        let output = "orchestration.subscribeCommandOutput";
        assert!(matches!(recorded_stream(output), Some(Recording::Final)));
        assert!(!is_side_info(output, &json!({"threadId": "t", "itemId": "i"})));
    }

    #[test]
    fn a_probe_in_a_shape_a_person_sends_wakes_when_unrecorded() {
        let search = "server.searchAcpRegistry";
        let refresh = "server.refreshProviders";
        for (tag, payload) in [
            (search, json!({"query": "", "limit": 512})),
            (refresh, json!({})),
            (refresh, json!({"modelCatalogOnly": true})),
            (refresh, json!({"refreshModels": true})),
        ] {
            assert!(is_background_probe(tag, &payload), "{tag} {payload}");
        }
        // A typed search and the Refresh button of the provider settings: true now, else a wake.
        for (tag, payload) in
            [(search, json!({"query": "cla"})), (refresh, json!({"refreshModels": true, "reloadSecrets": true}))]
        {
            let asked = !is_background_probe(tag, &payload)
                && recorded_unary(tag, &payload)
                && !serves_last_seen(tag, &payload);
            assert!(asked, "{tag} {payload}");
        }
        // "List sessions", "Refresh" and "Load more", and the update track's release: only ever
        // clicked, and an old answer would not do.
        for tag in ["server.listAcpRegistrySessions", "server.getNpmRelease"] {
            assert!(!is_background_probe(tag, &json!({})) && !recorded_unary(tag, &json!({})), "{tag}");
        }
    }

    #[test]
    fn github_sign_in_and_star_are_a_person_and_a_repository_lookup_is_not() {
        for tag in [
            "sourceControl.signInStart",
            "sourceControl.signInWait",
            "sourceControl.signInCancel",
            "sourceControl.star",
        ] {
            assert!(is_user_action(tag, &json!({})), "{tag}");
        }
        assert!(!is_user_action("sourceControl.lookupRepository", &json!({})));
    }

    #[test]
    fn settings_and_link_clicks_are_a_person_and_client_upkeep_is_not() {
        for tag in [
            "server.upsertKeybinding",
            "server.removeKeybinding",
            "server.runStorageCleanup",
            "server.reclaimDatabaseSpace",
            "server.updateServer",
            "server.updateServerWithProgress",
            "server.signalProcess",
            "server.setAcpRegistryProvider",
            "server.disableAcpRegistryProvider",
            "server.logoutAcpRegistry",
            "server.importAcpRegistrySession",
            "server.deleteAcpRegistrySession",
            "server.prepareAcpRegistryAgent",
            "server.uninstallAcpRegistryManagedBinary",
            "server.acceptAcpRegistryUrlAuth",
            "peerLinks.link",
            "peerLinks.unlink",
            "peerLinks.answerRequest",
            "guestShare.create",
            "cloud.installRelayClient",
        ] {
            assert!(is_user_action(tag, &json!({})), "{tag}");
        }
        for tag in [
            "server.refreshUsageRates",
            "server.retryResourceTelemetry",
            "server.prepareTriage",
            "server.commitDesktopUpdate",
            "server.checkSecretSource",
            "server.checkOtlpEndpoint",
            "server.searchAcpRegistry",
        ] {
            assert!(!is_user_action(tag, &json!({})), "{tag}");
        }
    }

    #[test]
    fn image_urls_are_recorded_and_never_wake() {
        assert!(BACKGROUND_PROBES.contains(&"assets.createUrl"));
        assert!(recorded_unary("assets.createUrl", &json!({})));
        assert!(!is_user_action("assets.createUrl", &json!({})));
    }

    #[test]
    fn preview_and_device_actions_are_a_person_and_their_reads_are_not() {
        for tag in [
            "preview.open",
            "preview.resize",
            "preview.close",
            "preview.stopLocalServer",
            "device.open",
            "device.action",
        ] {
            assert!(is_user_action(tag, &json!({})), "{tag}");
        }
        for tag in ["preview.list", "preview.reportProfiles", "preview.reportStatus", "device.list", "device.detail"] {
            assert!(!is_user_action(tag, &json!({})), "{tag}");
        }
        assert!(recorded_unary("device.list", &json!({})));
        // A retry of a device host or a tool update: done now, never replayed.
        for payload in [json!({"retryHostId": "h"}), json!({"updateTool": "xcode"})] {
            assert!(is_user_action("device.list", &payload) && !recorded_unary("device.list", &payload), "{payload}");
        }
    }

    #[test]
    fn session_transfer_mutations_are_user_actions_and_reads_are_not() {
        for tag in [
            "sessionTransfer.prepareSource",
            "sessionTransfer.stageImport",
            "sessionTransfer.commitImport",
            "sessionTransfer.finalizeSource",
            "sessionTransfer.abort",
            "sessionTransfer.start",
            "sessionTransfer.cancel",
            "sessionTransfer.retry",
        ] {
            assert!(is_user_action(tag, &json!({})), "{tag}");
            assert!(!is_side_info(tag, &json!({})), "{tag}");
            assert!(!recorded_unary(tag, &json!({})), "{tag}");
        }
        for tag in ["sessionTransfer.list", "sessionTransfer.preflight"] {
            assert!(!is_user_action(tag, &json!({})), "{tag}");
        }
    }
}
