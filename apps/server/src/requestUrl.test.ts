import { expect, it } from "vite-plus/test";
import { HttpServerRequest } from "effect/http";

import { requestPageOrigin } from "./requestUrl.ts";

const upgrade = (headers: Record<string, string>) =>
  HttpServerRequest.fromWeb(new Request("http://127.0.0.1:3773/ws", { headers }));

it.each([
  ["the host it reached", { origin: "https://sail.example.test", host: "sail.example.test" }],
  [
    "the host a proxy forwarded",
    {
      origin: "https://sail.example.test:8443",
      host: "127.0.0.1:3773",
      "x-forwarded-host": "sail.example.test:8443",
    },
  ],
])("names the page this server served at %s", (_, headers) => {
  expect(requestPageOrigin(upgrade(headers))).toBe(headers.origin);
});

it.each([
  ["no origin", { host: "sail.example.test" }],
  ["another site", { origin: "https://attacker.example", host: "sail.example.test" }],
  [
    "a longer host",
    { origin: "https://sail.example.test.attacker.example", host: "sail.example.test" },
  ],
  ["another port", { origin: "https://sail.example.test:8443", host: "sail.example.test" }],
  ["an app scheme", { origin: "sail://app", host: "127.0.0.1:3773" }],
  ["an unreadable origin", { origin: "null", host: "sail.example.test" }],
])("names no page for %s", (_, headers) => {
  expect(requestPageOrigin(upgrade(headers))).toBeUndefined();
});
