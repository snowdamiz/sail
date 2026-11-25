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
    for (const trusted of [[], [""], ["https://sail.example.test"]]) {
      expect(providerAuthReturnUrl("http://127.0.0.1:3773/settings/providers", trusted)).toBe(
        "http://127.0.0.1:3773/settings/providers",
      );
    }
  });

  it("returns to https://sail.example.test only when the caller trusts it", () => {
    const page = "https://sail.example.test/settings/providers?instanceId=work&code=secret";
    expect(providerAuthReturnUrl(page, ["https://sail.example.test"])).toBe(
      "https://sail.example.test/settings/providers?instanceId=work",
    );
    expect(providerAuthReturnUrl(page, ["https://sail.example.test/"])).toBeDefined();
    expect(
      providerAuthReturnUrl(page, ["https://hosted.example.test", "https://sail.example.test"]),
    ).toBeDefined();
    expect(providerAuthReturnUrl(page, ["https://other.example.test"])).toBeUndefined();
  });

  it.each([
    ["a longer host", "https://sail.example.test.attacker.example/welcome"],
    ["another port", "https://sail.example.test:8443/welcome"],
    ["plain http", "http://sail.example.test/welcome"],
    ["a user name", "https://sail.example.test@attacker.example/welcome"],
  ])("rejects a look-alike with %s", (_, page) => {
    expect(providerAuthReturnUrl(page, ["https://sail.example.test"])).toBeUndefined();
  });

  it("never trusts a non-loopback http origin, which would carry the code in the clear", () => {
    expect(
      providerAuthReturnUrl("http://192.168.1.42:3773/settings/providers", [
        "http://192.168.1.42:3773",
      ]),
    ).toBeUndefined();
    expect(
      providerAuthReturnUrl("http://sail.example.test/welcome", ["http://sail.example.test"]),
    ).toBeUndefined();
  });

  it.each([
    ["absent", undefined],
    ["empty", [""]],
    ["unreadable", ["not a url"]],
    ["an app scheme", ["sail://app"]],
  ])("trusts no web page beyond loopback with an %s trusted origin", (_, trusted) => {
    expect(providerAuthReturnUrl("https://sail.example.test/welcome", trusted)).toBeUndefined();
    expect(providerAuthReturnUrl("https://app.t3.codes/welcome", trusted)).toBeUndefined();
  });
});
