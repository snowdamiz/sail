import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { AnchoredToastProvider } from "../ui/toast";
import { MessageCopyButton, PromptLinkCopyButton } from "./MessageCopyButton";

const links = vi.hoisted(() => ({ origin: "https://before.example.test" }));
vi.mock("../../hostedPairing", async (original) => ({
  ...(await original<typeof import("../../hostedPairing")>()),
  linkOrigin: () => links.origin,
}));

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
  await using screen = await render(<PromptLinkCopyButton prompt="Fix the flaky test" />);
  using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  const copy = screen.getByRole("button", { name: "Copy prompt link" });
  await expect.element(copy).toBeVisible();
  // Hovering opens the tooltip and re-renders, so the origin changes after it.
  await copy.hover();
  links.origin = "https://after.example.test";
  await copy.click();

  await expect
    .poll(() => write.mock.calls[0]?.[0])
    .toMatch(/^https:\/\/after\.example\.test\/new\?prompt=Fix/);
});
