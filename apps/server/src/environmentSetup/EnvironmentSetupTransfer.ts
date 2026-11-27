// @effect-diagnostics nodeBuiltinImport:off - skill roots are relative to the OS user home.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";
import {
  EnvironmentSetupBundle,
  EnvironmentSetupError,
  EnvironmentThemeFile,
  MAX_ENVIRONMENT_SETUP_BYTES,
  environmentThemeFileHasColors,
  type EnvironmentSetupImportInput,
  type EnvironmentSetupPreview,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { themeCssLoadsRemoteFiles } from "@t3tools/shared/themeCss";
import { MOBILE_THEME_IDS, UNPUBLISHABLE_THEME_IDS } from "@t3tools/shared/themePalettes";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as EnvironmentTheme from "../environmentTheme.ts";
import * as Keybindings from "../keybindings.ts";
import { isServerMaintenanceBusy, withAdmission } from "../serverAdmission.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  hasProviderCredential,
  mergePortableProvider,
  needsLocalProviderSetup,
  providerIdentityConflicts,
  portableProviders,
  portableSettings,
} from "./portableSettings.ts";
import {
  exportSkillFiles,
  inspectSkillFiles,
  validateSkillFileList,
  writeSkillFiles,
} from "./skillFiles.ts";

export class EnvironmentSetupTransfer extends Context.Service<
  EnvironmentSetupTransfer,
  {
    readonly export: <E = never, R = never>(
      check?: Effect.Effect<unknown, E, R>,
    ) => Effect.Effect<EnvironmentSetupBundle, EnvironmentSetupError | E, R>;
    readonly import: <E = never, R = never>(
      input: EnvironmentSetupImportInput,
      check?: Effect.Effect<unknown, E, R>,
    ) => Effect.Effect<EnvironmentSetupPreview, EnvironmentSetupError | E, R>;
  }
>()("t3/environmentSetup/EnvironmentSetupTransfer") {}

const invalid = (message: string) => new EnvironmentSetupError({ message });
const decodeBundle = Schema.decodeUnknownEffect(EnvironmentSetupBundle, {
  onExcessProperty: "error",
});
const encodeBundle = Schema.encodeEffect(Schema.fromJsonString(EnvironmentSetupBundle));
const encodeRevision = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const themeFile = Schema.decodeUnknownSync(EnvironmentThemeFile);
const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

const hasDuplicates = (values: readonly string[]) => new Set(values).size !== values.length;

const validate = Effect.fn("EnvironmentSetupTransfer.validate")(function* (value: unknown) {
  const bundle = yield* decodeBundle(value).pipe(
    Effect.mapError(() => invalid("The setup bundle contains invalid or unsupported fields.")),
  );
  const encoded = yield* encodeBundle(bundle).pipe(
    Effect.mapError(() => invalid("The setup bundle could not be serialized.")),
  );
  if (Buffer.byteLength(encoded) > MAX_ENVIRONMENT_SETUP_BYTES) {
    return yield* invalid("The setup bundle exceeds 5 MB.");
  }
  if (
    hasDuplicates(bundle.providers.map(({ id }) => id)) ||
    bundle.providers.some(
      ({ acp, driver, requiredEnvironment }) =>
        (acp !== undefined && driver !== "acpRegistry") || hasDuplicates(requiredEnvironment),
    ) ||
    hasDuplicates(bundle.themes.map(({ id }) => id)) ||
    !validateSkillFileList(bundle.skills)
  ) {
    return yield* invalid("The setup bundle contains duplicate or incomplete entries.");
  }
  if (
    bundle.themes.some(
      ({ id, file }) =>
        UNPUBLISHABLE_THEME_IDS.has(id) ||
        !environmentThemeFileHasColors(file) ||
        (file.css !== undefined && themeCssLoadsRemoteFiles(file.css)),
    )
  ) {
    return yield* invalid("The setup bundle contains an unsupported theme.");
  }
  return bundle;
});

const make = Effect.fn("EnvironmentSetupTransfer.make")(function* (home: () => string) {
  const platform = yield* HostProcess.Platform;
  const settings = yield* ServerSettings.ServerSettingsService;
  const keybindings = yield* Keybindings.Keybindings;
  const themes = yield* EnvironmentTheme.EnvironmentThemeService;
  const semaphore = yield* Semaphore.make(1);
  const revisionNamespace = NodeCrypto.randomUUID();
  const resolveHome = Effect.tryPromise({
    try: () => NodeFSP.realpath(home()),
    catch: () => invalid("The user skill directories are unavailable."),
  });

  const exportSetup: EnvironmentSetupTransfer["Service"]["export"] = Effect.fn(
    "EnvironmentSetupTransfer.export",
  )(function* <E, R>(check: Effect.Effect<unknown, E, R> = Effect.void) {
    yield* check;
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() => invalid("The source settings could not be read.")),
    );
    const rules = yield* keybindings.exportRules.pipe(
      Effect.mapError(() => invalid("The source shortcuts could not be read.")),
    );
    const published = yield* themes.current;
    const home = yield* resolveHome;
    const skills = yield* Effect.tryPromise({
      try: () => exportSkillFiles(home),
      catch: () =>
        invalid(
          "The source skill folders contain unsupported files or exceed the transfer limits.",
        ),
    });
    const sourceSettings = portableSettings(current);
    const defaultTheme =
      published.some(({ id }) => id === sourceSettings.defaultTheme) ||
      MOBILE_THEME_IDS.some((id) => id === sourceSettings.defaultTheme)
        ? sourceSettings.defaultTheme
        : "";
    return yield* validate({
      version: 1,
      settings: { ...sourceSettings, defaultTheme },
      providers: portableProviders(current),
      keybindings: rules,
      themes: published.map((theme) => ({ id: theme.id, file: themeFile(theme) })),
      skills,
    });
  }, semaphore.withPermits(1));

  const importSetup: EnvironmentSetupTransfer["Service"]["import"] = Effect.fn(
    "EnvironmentSetupTransfer.import",
  )(
    function* <E, R>(
      input: EnvironmentSetupImportInput,
      check: Effect.Effect<unknown, E, R> = Effect.void,
    ) {
      yield* check;
      const bundle = yield* validate(input.bundle);
      const current = yield* settings.getSettings.pipe(
        Effect.mapError(() => invalid("The target settings could not be read.")),
      );
      const currentProviders = portableProviders(current);
      const providers: Array<EnvironmentSetupPreview["providers"][number]> = [];
      for (const provider of bundle.providers) {
        const existing = Object.hasOwn(current.providerInstances, provider.id)
          ? current.providerInstances[provider.id]
          : undefined;
        if (existing !== undefined && providerIdentityConflicts(provider, existing)) {
          return yield* invalid(
            "A target provider uses the same ID with a different driver or registry agent.",
          );
        }
        providers.push({
          id: provider.id,
          name: provider.displayName ?? existing?.displayName ?? provider.id,
          needsLocalSetup: needsLocalProviderSetup(provider, existing?.config),
          changed: !NodeUtil.isDeepStrictEqual(mergePortableProvider(provider, existing), existing),
          missingEnvironment: provider.requiredEnvironment.filter(
            (name) =>
              !existing?.environment?.some(({ name: key, value }) => key === name && value !== ""),
          ),
          ...(provider.requiredCredential !== undefined &&
          !hasProviderCredential(existing?.config, provider.requiredCredential)
            ? { missingCredential: provider.requiredCredential }
            : {}),
        });
      }

      const keybindingError = () =>
        invalid("The target shortcuts could not be copied within the shortcut limit.");
      const keybindingsChanged = yield* keybindings
        .importRules(bundle.keybindings, false)
        .pipe(Effect.mapError(keybindingError));
      const currentRules = yield* keybindings.exportRules.pipe(Effect.mapError(keybindingError));
      const themeSnapshot = yield* themes.current;
      const currentThemes = new Map(themeSnapshot.map((theme) => [theme.id, themeFile(theme)]));
      const currentSettings = portableSettings(current);
      const nextSettings = {
        ...bundle.settings,
        defaultTheme:
          bundle.settings.defaultTheme === "" ||
          MOBILE_THEME_IDS.some((id) => id === bundle.settings.defaultTheme) ||
          currentThemes.has(bundle.settings.defaultTheme) ||
          bundle.themes.some(({ id }) => id === bundle.settings.defaultTheme)
            ? bundle.settings.defaultTheme
            : currentSettings.defaultTheme,
        favorites: bundle.settings.favorites ?? currentSettings.favorites,
        providerModelPreferences:
          bundle.settings.providerModelPreferences ?? currentSettings.providerModelPreferences,
      };
      const settingsChanged = !NodeUtil.isDeepStrictEqual(nextSettings, currentSettings);
      const changedThemes = bundle.themes.filter(
        ({ id, file }) => !NodeUtil.isDeepStrictEqual(currentThemes.get(id), file),
      );
      const home = yield* resolveHome;
      const changedSkills = yield* Effect.tryPromise({
        try: () => inspectSkillFiles(home, bundle.skills, platform),
        catch: () =>
          invalid(
            "The target skill folders contain unsupported files or exceed the transfer limits.",
          ),
      });
      const skillFolders = new Map(
        changedSkills.map(({ file }) => {
          const [folder = ""] = file.path.split("/");
          return [`${file.root}/${folder}`, { root: file.root, folder }];
        }),
      );
      const revision = digest(
        yield* encodeRevision({
          revisionNamespace,
          bundle,
          currentSettings,
          currentProviders,
          currentRules,
          currentThemes: [...currentThemes],
          changedSkills: changedSkills.map(({ file, existing }) => [
            file.root,
            file.path,
            existing ?? null,
          ]),
        }).pipe(Effect.mapError(() => invalid("The copy preview could not be serialized."))),
      );
      const preview: EnvironmentSetupPreview = {
        revision,
        settings: settingsChanged,
        providers,
        keybindings: keybindingsChanged,
        themes: changedThemes.map(({ id }) => id),
        skills: [...skillFolders.values()],
      };
      const changedProviders = bundle.providers.filter((_, index) => providers[index]?.changed);
      const settingsWrite = {
        settings: nextSettings,
        providers: changedProviders,
        expected: { settings: currentSettings, providers: currentProviders },
      };
      const settingsError = () =>
        invalid(
          "The target settings could not be copied. Check its settings policy and preview again.",
        );
      const themeError = () =>
        invalid("The target themes could not be copied within the theme limits.");
      if (settingsChanged || changedProviders.length > 0) {
        yield* settings
          .importPortableSetup({ ...settingsWrite, apply: false })
          .pipe(Effect.mapError(settingsError));
      }
      if (input.action === "preview") {
        if (changedThemes.length > 0) {
          yield* themes
            .publishPortable(changedThemes, false, themeSnapshot)
            .pipe(Effect.mapError(themeError));
        }
        return preview;
      }
      if (
        !settingsChanged &&
        changedProviders.length === 0 &&
        !keybindingsChanged &&
        changedThemes.length === 0 &&
        changedSkills.length === 0
      )
        return preview;
      if (input.revision !== revision) {
        return yield* invalid("The target setup changed. Preview the copy again.");
      }

      yield* check;
      if (changedThemes.length > 0) {
        yield* themes
          .publishPortable(changedThemes, true, themeSnapshot)
          .pipe(Effect.mapError(themeError));
      }
      if (settingsChanged || changedProviders.length > 0) {
        yield* settings
          .importPortableSetup({ ...settingsWrite, apply: true })
          .pipe(Effect.mapError(settingsError));
      }
      if (keybindingsChanged) {
        yield* keybindings
          .importRules(bundle.keybindings, true, currentRules)
          .pipe(Effect.mapError(keybindingError));
      }
      if (changedSkills.length > 0) {
        yield* Effect.tryPromise({
          try: () => writeSkillFiles(home, changedSkills, platform),
          catch: () =>
            invalid("The target skill files could not all be saved. Preview the copy again."),
        }).pipe(Effect.uninterruptible);
      }
      return preview;
    },
    (work, input) =>
      input.action === "apply"
        ? work.pipe(
            withAdmission("root"),
            Effect.catchIf(isServerMaintenanceBusy, (cause) => invalid(cause.message)),
          )
        : work,
    semaphore.withPermits(1),
  );

  return EnvironmentSetupTransfer.of({
    export: exportSetup,
    import: importSetup,
  });
});

export const layer = Layer.effect(EnvironmentSetupTransfer, make(NodeOS.homedir));
export const layerTest = (home: string) =>
  Layer.effect(
    EnvironmentSetupTransfer,
    make(() => home),
  );
