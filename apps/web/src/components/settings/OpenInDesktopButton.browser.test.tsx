import { expect, it } from "vite-plus/test";

import { render, stubGlobal } from "../../../test/render";
import { OpenInDesktopButton } from "./OpenInDesktopButton";

const pairingUrl = "https://sail.example.test/pair#token=one%26two";

it("offers a desktop deep link with the complete pairing URL in the browser", async () => {
  using _bridge = stubGlobal("desktopBridge", undefined);
  await using screen = await render(<OpenInDesktopButton pairingUrl={pairingUrl} />);

  await expect
    .element(screen.getByRole("link", { name: "Open in Sail desktop" }))
    .toHaveAttribute(
      "href",
      "sail://pair?pairingUrl=https%3A%2F%2Fsail.example.test%2Fpair%23token%3Done%2526two",
    );
});

it("hides the desktop deep link inside the desktop app", async () => {
  using _bridge = stubGlobal("desktopBridge", {});
  await using screen = await render(<OpenInDesktopButton pairingUrl={pairingUrl} />);

  await expect
    .element(screen.getByRole("link", { name: "Open in Sail desktop" }))
    .not.toBeInTheDocument();
});
