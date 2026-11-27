import { EnvironmentId, ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import {
  decodeComposerContextFragment,
  encodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import { threadLinkContextReferences } from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadReferenceCopyTarget } from "./threadReference.ts";

const thread = {
  threadRef: { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("thread-1") },
  title: "Fix the login flow",
  linkOrigin: "https://sail.example.test",
};

const crossRepositoryPullRequest: ThreadPullRequestLink = {
  host: "github.com",
  repository: "other/repo",
  number: 42,
  url: "https://github.com/other/repo/pull/42",
  source: "manual",
  linkedAt: "2026-01-01T00:00:00.000Z",
  snapshot: null,
  stack: null,
};

describe("resolveThreadReferenceCopyTarget", () => {
  it("does not copy another reference while the open panel URL is unavailable", () => {
    expect(
      resolveThreadReferenceCopyTarget({
        ...thread,
        openPanelPullRequestUrl: null,
        pullRequests: [crossRepositoryPullRequest],
        linkedPullRequestUrl: "https://github.com/t3/pr/12",
      }),
    ).toBeNull();
  });

  it("prefers the open panel pull request over the thread pull request", () => {
    expect(
      resolveThreadReferenceCopyTarget({
        ...thread,
        openPanelPullRequestUrl: "https://github.com/t3/pr/14",
        pullRequests: [crossRepositoryPullRequest],
        linkedPullRequestUrl: "https://github.com/t3/pr/12",
      }),
    ).toMatchObject({
      kind: "pull-request",
      value: "https://github.com/t3/pr/14",
      successTitle: "PR link copied",
    });
  });

  it.each([null, "https://github.com/t3/pr/12"])(
    "copies a native cross-repository link before the fallback URL %s",
    (linkedPullRequestUrl) => {
      expect(
        resolveThreadReferenceCopyTarget({
          ...thread,
          pullRequests: [crossRepositoryPullRequest],
          linkedPullRequestUrl,
        }),
      ).toMatchObject({
        kind: "pull-request",
        value: crossRepositoryPullRequest.url,
      });
    },
  );

  it("uses the fallback URL when native links are dismissed", () => {
    expect(
      resolveThreadReferenceCopyTarget({
        ...thread,
        pullRequests: [{ ...crossRepositoryPullRequest, source: "stack-dismissed" }],
        linkedPullRequestUrl: "https://github.com/t3/pr/12",
      }),
    ).toMatchObject({ kind: "pull-request", value: "https://github.com/t3/pr/12" });
  });

  it("copies a thread chip that pastes back as the same thread on its machine", () => {
    const target = resolveThreadReferenceCopyTarget({ ...thread, linkedPullRequestUrl: null });

    expect(target).toMatchObject({
      kind: "thread",
      description: "Fix the login flow",
      successTitle: "Thread copied",
    });
    const pasted = decodeComposerContextFragment(encodeComposerContextFragment(target!.fragment!));
    expect(pasted).toEqual({
      version: 1,
      source: { environmentId: "env-1" },
      records: [
        expect.objectContaining({
          kind: "thread",
          environmentId: "env-1",
          threadId: "thread-1",
          title: "Fix the login flow",
        }),
      ],
    });
    expect(target!.value).toBe("https://sail.example.test/threads/env-1/thread-1");
    expect(
      threadLinkContextReferences(
        target!.value,
        pasted!.records,
        () => undefined,
        undefined,
        thread.linkOrigin,
      ),
    ).toEqual({
      text: `[Fix the login flow](t3-context://v1/thread/${pasted!.records[0]!.contextId})`,
      records: pasted!.records,
    });
  });

  it("copies a t3-thread link when there is no web app to link into", () => {
    for (const linkOrigin of [undefined, "", "sail://app"]) {
      expect(resolveThreadReferenceCopyTarget({ ...thread, linkOrigin })?.value).toBe(
        "[Fix the login flow](t3-thread://v2/env-1/thread-1)",
      );
    }
  });

  it.each(["work item", "a>b`c"])(
    "copies a t3-thread link that pastes back as thread %j without its chip data",
    (threadId) => {
      const threadRef = {
        environmentId: EnvironmentId.make("remote"),
        threadId: ThreadId.make(threadId),
      };
      const target = resolveThreadReferenceCopyTarget({
        threadRef,
        title: "Work item",
        linkOrigin: undefined,
      });
      for (const title of [
        (ref: { threadId: string }) => (ref.threadId === threadId ? "Work item" : undefined),
        () => undefined,
      ]) {
        const pasted = threadLinkContextReferences(target!.value, [], title);
        expect(pasted.records).toEqual([
          expect.objectContaining({ kind: "thread", ...threadRef, title: "Work item" }),
        ]);
      }
    },
  );

  it("links through the web app it is given", () => {
    expect(
      resolveThreadReferenceCopyTarget({ ...thread, linkOrigin: "https://hosted.example.test" })
        ?.value,
    ).toBe("https://hosted.example.test/threads/env-1/thread-1");
  });
});
