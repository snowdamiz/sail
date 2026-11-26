import { createClerkBridge } from "@clerk/electron";
import * as NodeURL from "node:url";
import { storage } from "@clerk/electron/storage";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type { EnvironmentId } from "@t3tools/contracts";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
} from "@t3tools/client-runtime/platform";
import {
  codexAuthDeliveryUrl,
  codexAuthReturnUrl,
  isCodexAuthHandoffLink,
  readCodexAuthHandoff,
} from "@t3tools/shared/codexAuthHandoff";
import { receiveCodexAuthCallback, CodexAuthCallbackError } from "./CodexAuthCallback.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import { providerAuthReturnUrl } from "@t3tools/shared/providerAuthReturnUrl";
import { promptLinkAppPath } from "@t3tools/shared/promptLinks";
import { readPairingAppLink } from "@t3tools/shared/remote";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { clerkFrontendApiHostnameFromPublishableKey } from "@t3tools/shared/relayAuth";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopUserData from "./DesktopUserData.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";

declare const __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: string | undefined;
declare const __T3CODE_BUILD_HOSTED_APP_URL__: string | undefined;

const decodeConnectionCatalog = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ConnectionCatalogDocument),
);

/**
 * Any page can open a handoff link, so trust comes only from what this desktop knows now. A saved
 * server's own page speaks only for that server; the hosted app and this computer's pages serve many.
 */
function acceptCodexAuthHandoff(
  value: string,
  development: boolean,
  { targets, profiles, disabledEnvironmentIds }: ConnectionCatalogDocument,
) {
  const hostedAppUrl =
    typeof __T3CODE_BUILD_HOSTED_APP_URL__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_HOSTED_APP_URL__.trim() || undefined;
  const serverPages = (environmentId?: EnvironmentId) =>
    profiles.flatMap((profile) => {
      const chosenByUser = profile._tag === "BearerConnectionProfile" && profile.learned !== true;
      return chosenByUser &&
        (environmentId === undefined || profile.environmentId === environmentId)
        ? [profile.httpBaseUrl]
        : [];
    });
  const request = readCodexAuthHandoff(value, development, [hostedAppUrl, ...serverPages()]);
  if (!request) return undefined;
  const enabled =
    targets.some(({ environmentId }) => environmentId === request.environmentId) &&
    !disabledEnvironmentIds.includes(request.environmentId);
  const trustedOrigins = [hostedAppUrl, ...serverPages(request.environmentId)];
  return enabled && codexAuthReturnUrl(request.returnUrl, trustedOrigins)
    ? { request, trustedOrigins }
    : undefined;
}

export class DesktopClerkBridgeInitializationError extends Schema.TaggedError<DesktopClerkBridgeInitializationError>()(
  "DesktopClerkBridgeInitializationError",
  {
    stateDir: Schema.String,
    isDevelopment: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to initialize the desktop Clerk bridge for state directory "${this.stateDir}" (development: ${this.isDevelopment}).`;
  }
}

export class DesktopClerkBridgeCleanupError extends Schema.TaggedError<DesktopClerkBridgeCleanupError>()(
  "DesktopClerkBridgeCleanupError",
  {
    stateDir: Schema.String,
    isDevelopment: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to clean up the desktop Clerk bridge for state directory "${this.stateDir}" (development: ${this.isDevelopment}).`;
  }
}

export class DesktopClerk extends Context.Service<
  DesktopClerk,
  {
    readonly configure: Effect.Effect<
      void,
      never,
      | ElectronApp.ElectronApp
      | ElectronWindow.ElectronWindow
      | DesktopWebLinks.DesktopWebLinks
      | DesktopConnectionCatalogStore.DesktopConnectionCatalogStore
      | Scope.Scope
    >;
  }
>()("@t3tools/desktop/app/DesktopClerk") {}

function resolveDesktopClerkFrontendApiHostname(
  publishableKey: string | undefined,
): string | undefined {
  const normalizedKey = publishableKey?.trim();
  if (!normalizedKey) return undefined;

  try {
    return clerkFrontendApiHostnameFromPublishableKey(normalizedKey);
  } catch {
    return undefined;
  }
}

export const desktopClerkFrontendApiHostname = resolveDesktopClerkFrontendApiHostname(
  typeof __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__,
);

function createDesktopClerkBridge(tokenDirectory: string, isDevelopment: boolean) {
  return createClerkBridge({
    storage: storage({ path: tokenDirectory }),
    manageSingleInstanceLock: false,
    passkeys: true,
    renderer: {
      scheme: ElectronProtocol.getDesktopScheme(isDevelopment),
      host: ElectronProtocol.DESKTOP_HOST,
    },
  });
}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const shell = yield* ElectronShell.ElectronShell;
  const path = yield* Path.Path;

  // Must not yield: the bridge registers a scheme Electron rejects once ready.
  const userDataPath = yield* DesktopUserData.resolveUserDataPath(environment);
  yield* electronApp.setPath("userData", userDataPath);

  // Clerk skips the profile lock on macOS. Interrupt before runtime construction because quit is asynchronous.
  if (!(yield* electronApp.requestSingleInstanceLock)) {
    yield* electronApp.quit;
    return yield* Effect.interrupt;
  }
  // Chromium opens these caches at the first event-loop turn, before ready.
  yield* DesktopUserData.clearStaleGpuCaches({
    userDataPath,
    electronVersion: process.versions.electron,
  });

  const pendingSecondInstances: Array<readonly string[]> = [];
  let handleSecondInstance = (argv: readonly string[]) => {
    pendingSecondInstances.push(argv);
  };
  yield* electronApp.on("second-instance", (_event: unknown, argv: readonly string[]) => {
    handleSecondInstance(argv);
  });
  // macOS hands a launch link to open-url, which can fire before configure runs.
  const pendingOpenUrls: Array<string> = [];
  let handleOpenUrl = (url: string) => {
    pendingOpenUrls.push(url);
    return true;
  };
  yield* electronApp.on("open-url", (event: { preventDefault: () => void }, url: string) => {
    if (handleOpenUrl(url)) event.preventDefault();
  });

  yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        createDesktopClerkBridge(
          path.resolve(environment.stateDir, "clerk"),
          environment.isDevelopment,
        ),
      catch: (cause) =>
        new DesktopClerkBridgeInitializationError({
          stateDir: environment.stateDir,
          isDevelopment: environment.isDevelopment,
          cause,
        }),
    }),
    (bridge) =>
      Effect.try({
        try: () => bridge.cleanup(),
        catch: (cause) =>
          new DesktopClerkBridgeCleanupError({
            stateDir: environment.stateDir,
            isDevelopment: environment.isDevelopment,
            cause,
          }),
      }).pipe(Effect.orDie),
  );

  return DesktopClerk.of({
    configure: Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
      const connectionCatalog = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
      const context = yield* Effect.context<ElectronWindow.ElectronWindow>();
      const runPromise = Effect.runPromiseWith(context);

      const acceptHandoff = (value: string) =>
        connectionCatalog.get.pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(EMPTY_CONNECTION_CATALOG_DOCUMENT),
              onSome: decodeConnectionCatalog,
            }),
          ),
          Effect.catch((cause) =>
            Effect.logWarning("Could not read saved servers for a ChatGPT desktop handoff.", {
              cause,
            }).pipe(Effect.as(EMPTY_CONNECTION_CATALOG_DOCUMENT)),
          ),
          Effect.map((catalog) =>
            acceptCodexAuthHandoff(value, environment.isDevelopment, catalog),
          ),
        );
      const revealMainWindow = Effect.gen(function* () {
        const mainWindow = yield* electronWindow.currentMainOrFirst;
        if (Option.isSome(mainWindow)) yield* electronWindow.reveal(mainWindow.value);
      });

      const startProviderAuthHandoff = (value: string | undefined) => {
        if (!value || !isCodexAuthHandoffLink(value, environment.isDevelopment)) return false;
        void runPromise(
          Effect.gen(function* () {
            yield* electronApp.whenReady;
            const accepted = yield* acceptHandoff(value);
            if (!accepted) {
              yield* Effect.logWarning(
                "Ignored a ChatGPT desktop handoff that is malformed or not for a page and environment this desktop trusts.",
              );
              return yield* revealMainWindow;
            }
            const deliveryUrlIfStillTrusted = async (callbackUrl: string) => {
              const current = await runPromise(acceptHandoff(value));
              if (!current) {
                await runPromise(
                  Effect.logWarning(
                    "Refused a ChatGPT desktop handoff that this desktop no longer trusts now that its code arrived.",
                  ),
                );
                throw new Error("This sign-in's environment is no longer trusted.");
              }
              return codexAuthDeliveryUrl(current.request, callbackUrl, current.trustedOrigins);
            };
            yield* Effect.tryPromise({
              try: (signal) =>
                receiveCodexAuthCallback(
                  accepted.request.authorizationUrl,
                  (url) => runPromise(shell.openExternal(url)),
                  deliveryUrlIfStillTrusted,
                  signal,
                ),
              catch: () =>
                new CodexAuthCallbackError({
                  detail:
                    "Could not receive hosted web ChatGPT sign-in. Retry or use the redirect URL in the web app.",
                }),
            });
          }).pipe(
            Effect.catch(() => Effect.logWarning("Could not complete ChatGPT desktop handoff.")),
          ),
        );
        return true;
      };
      const resumeProviderAuth = (value: string | undefined) => {
        const destination = providerAuthReturnUrl(value);
        const expectedOrigin = `${ElectronProtocol.getDesktopScheme(environment.isDevelopment)}://app`;
        if (!destination?.startsWith(`${expectedOrigin}/`)) return false;
        void runPromise(
          Effect.gen(function* () {
            const mainWindow = yield* electronWindow.currentMainOrFirst;
            if (Option.isNone(mainWindow)) return;
            yield* Effect.promise(() => mainWindow.value.loadURL(destination));
            yield* electronWindow.reveal(mainWindow.value);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not return to provider setup", cause),
            ),
          ),
        );
        return true;
      };
      const openAppLink = (value: string | undefined) => {
        if (!value || (promptLinkAppPath(value) === null && readPairingAppLink(value) === null))
          return false;
        void runPromise(webLinks.receive(value));
        return true;
      };
      const args = yield* HostProcess.Arguments;
      args.some((value) => startProviderAuthHandoff(value) || openAppLink(value));
      const openWebLink = (url: string) => {
        if (!DesktopWebLinks.isWebLink(url)) return false;
        void runPromise(webLinks.receive(url));
        return true;
      };
      handleOpenUrl = (url) =>
        startProviderAuthHandoff(url) ||
        resumeProviderAuth(url) ||
        openWebLink(url) ||
        openAppLink(url);
      for (const url of pendingOpenUrls.splice(0)) handleOpenUrl(url);
      yield* electronApp.on("open-file", (event: { preventDefault: () => void }, path: string) => {
        if (!DesktopWebLinks.isWebPageFile(path)) return;
        event.preventDefault();
        void runPromise(webLinks.receive(NodeURL.pathToFileURL(path).href));
      });
      handleSecondInstance = (argv) => {
        if (
          argv?.some(
            (value) =>
              startProviderAuthHandoff(value) || resumeProviderAuth(value) || openAppLink(value),
          )
        )
          return;
        void runPromise(revealMainWindow);
      };
      for (const argv of pendingSecondInstances.splice(0)) handleSecondInstance(argv);
    }).pipe(Effect.withSpan("desktop.clerk.configure")),
  });
});

export const layer = Layer.effect(DesktopClerk, make);
