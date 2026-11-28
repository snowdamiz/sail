import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  updateOwnerPassword: vi.fn(async (_password: string) => true),
}));

vi.mock(import("../../environments/primary"), async (original) => ({
  ...(await original()),
  updateOwnerPassword: (password: string) => mocks.updateOwnerPassword(password),
}));

import { OwnerPasswordSettings } from "./OwnerPasswordSettings";

const environmentId = EnvironmentId.make("env-1");

describe("OwnerPasswordSettings", () => {
  it("explains that the owner sign-in password works for future browsers and Sail Desktop", async () => {
    mocks.updateOwnerPassword.mockReset().mockResolvedValue(true);
    await using screen = await render(
      <OwnerPasswordSettings configured={false} environmentId={environmentId} />,
    );

    await expect.element(screen.getByText("Owner sign-in password")).toBeVisible();
    await expect
      .element(
        screen.getByText(
          /Sign in from future browsers and Sail Desktop without a pairing link.*Password changes stay in the web app.*every password-based browser and Desktop session.*independently paired devices stay signed in/,
        ),
      )
      .toBeVisible();

    await userEvent.fill(screen.getByLabelText("New password"), "correct horse battery staple");
    await userEvent.fill(screen.getByLabelText("Confirm password"), "correct horse battery staple");
    await userEvent.click(screen.getByRole("button", { name: "Set password" }));

    expect(mocks.updateOwnerPassword).toHaveBeenCalledExactlyOnceWith(
      "correct horse battery staple",
    );
    await expect
      .element(
        screen.getByText(
          /Password saved\. Password-based browser and Desktop sessions have been signed out\. Paired devices remain signed in\./,
        ),
      )
      .toBeVisible();
  });
});
