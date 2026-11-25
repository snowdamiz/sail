import { describe, expect, it } from "vite-plus/test";
import { providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";

describe("provider auth return destinations", () => {
  it.each(["t3code", "t3code-dev"])(
    "returns to %s Welcome and the selected settings instance",
    (scheme) => {
      expect(providerAuthReturnUrl(`${scheme}://app/welcome?code=secret#agents:machine-id`)).toBe(
        `${scheme}://app/welcome#agents:machine-id`,
      );
      expect(
        providerAuthReturnUrl(`${scheme}://app/settings/providers?instanceId=work&code=secret`),
      ).toBe(`${scheme}://app/settings/providers?instanceId=work`);
    },
  );
  it.each([
    "t3code://attacker/welcome",
    "t3code://app/welcome/../evil",
    "https://attacker.example/welcome",
  ])("rejects %s", (url) => expect(providerAuthReturnUrl(url)).toBeUndefined());

  it("returns to a loopback page with or without a trusted origin", () => {
    for (const trusted of [undefined, "", "https://sail.example.test"]) {
      expect(providerAuthReturnUrl("http://127.0.0.1:3773/settings/providers", trusted)).toBe(
        "http://127.0.0.1:3773/settings/providers",
      );
    }
  });

  it("returns to https://sail.example.test only when the caller trusts it", () => {
    const page = "https://sail.example.test/settings/providers?instanceId=work&code=secret";
    expect(providerAuthReturnUrl(page, "https://sail.example.test")).toBe(
      "https://sail.example.test/settings/providers?instanceId=work",
    );
    expect(providerAuthReturnUrl(page, "https://sail.example.test/")).toBeDefined();
    expect(providerAuthReturnUrl(page, "https://other.example.test")).toBeUndefined();
    expect(providerAuthReturnUrl(page, "http://sail.example.test")).toBeUndefined();
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["unreadable", "not a url"],
  ])("trusts no web page beyond loopback with an %s trusted origin", (_, trusted) => {
    expect(providerAuthReturnUrl("https://sail.example.test/welcome", trusted)).toBeUndefined();
    expect(providerAuthReturnUrl("https://app.t3.codes/welcome", trusted)).toBeUndefined();
  });
});
