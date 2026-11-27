import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { AnchoredToastProvider } from "../ui/toast";
import { MessageCopyButton, PromptLinkCopyButton } from "./MessageCopyButton";

const links = vi.hoisted(() => ({
  origin: "https://before.example.test" as string | undefined,
  primaryEnvironmentId: "local" as string | null,
  listeners: new Set<() => void>(),
}));
vi.mock("../../hostedPairing", async (original) => ({
  ...(await original<typeof import("../../hostedPairing")>()),
  linkOrigin: () => links.origin,
}));
vi.mock("~/state/environments", async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original<typeof import("~/state/environments")>()),
    usePrimaryEnvironmentId: () =>
      useSyncExternalStore(
        (listener) => {
          links.listeners.add(listener);
          return () => links.listeners.delete(listener);
        },
        () => links.primaryEnvironmentId,
      ) as never,
  };
});

it("explains a denied clipboard write and lets the same message be copied again", async () => {
  await using screen = await render(
    <AnchoredToastProvider timeout={0}>
      <MessageCopyButton text="A message to copy" />
    </AnchoredToastProvider>,
  );
  using _write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new DOMException("Clipboard access denied", "NotAllowedError"))
    .mockResolvedValue(undefined);
  using _console = vi.spyOn(console, "error").mockImplementation(() => undefined);

  const copy = screen.getByRole("button", { name: "Copy message" });
  await copy.click();

  await expect.element(page.getByText("Failed to copy text to the clipboard.")).toBeVisible();
  await expect.element(copy).toBeEnabled();
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  await copy.click();

  await expect.element(page.getByText("Copied!", { exact: true })).not.toBeInTheDocument();
  await expect.element(copy).toBeDisabled();
});

it("builds a prompt link at the origin in use when it is clicked", async () => {
  links.origin = "https://before.example.test";
  links.primaryEnvironmentId = "local";
  await using screen = await render(<PromptLinkCopyButton prompt="Fix the flaky test" />);
  using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  const copy = screen.getByRole("button", { name: "Copy prompt link" });
  await expect.element(copy).toBeVisible();
  await copy.hover();
  links.origin = "https://after.example.test";
  await copy.click();

  await expect
    .poll(() => write.mock.calls[0]?.[0])
    .toMatch(/^https:\/\/after\.example\.test\/new\?prompt=Fix/);
});

it("offers a prompt link once the desktop's local server comes up", async () => {
  links.origin = undefined;
  links.primaryEnvironmentId = null;
  await using screen = await render(<PromptLinkCopyButton prompt="Fix the flaky test" />);
  using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  await expect
    .element(screen.getByRole("button", { name: "Copy prompt link" }))
    .not.toBeInTheDocument();

  await act(() => {
    links.origin = "http://127.0.0.1:3773";
    links.primaryEnvironmentId = "local";
    for (const listener of links.listeners) listener();
  });
  await screen.getByRole("button", { name: "Copy prompt link" }).click();

  await expect
    .poll(() => write.mock.calls[0]?.[0])
    .toMatch(/^http:\/\/127\.0\.0\.1:3773\/new\?prompt=Fix/);
});
