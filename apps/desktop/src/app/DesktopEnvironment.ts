import type {
  DesktopAppBranding,
  DesktopAppStageLabel,
  DesktopRuntimeArch,
  DesktopRuntimeInfo,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import { isNightlyDesktopVersion } from "../updates/updateChannels.ts";

export interface MakeDesktopEnvironmentInput {
  readonly dirname: string;
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly processArch: string;
  readonly appVersion: string;
  readonly appPath: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly runningUnderArm64Translation: boolean;
}

export class DesktopEnvironment extends Context.Service<
  DesktopEnvironment,
  {
    readonly path: Path.Path;
    readonly dirname: string;
    readonly platform: NodeJS.Platform;
    readonly processArch: string;
    readonly isPackaged: boolean;
    readonly isDevelopment: boolean;
    readonly appVersion: string;
    readonly appPath: string;
    readonly resourcesPath: string;
    readonly homeDirectory: string;
    readonly appDataDirectory: string;
    readonly baseDir: string;
    readonly stateDir: string;
    readonly desktopSettingsPath: string;
    readonly clientSettingsPath: string;
    readonly savedEnvironmentRegistryPath: string;
    readonly serverSettingsPath: string;
    readonly logDir: string;
    readonly browserArtifactsDir: string;
    readonly rootDir: string;
    readonly appRoot: string;
    readonly backendEntryPath: string;
    readonly backendCwd: string;
    readonly preloadPath: string;
    readonly appUpdateYmlPath: string;
    readonly devServerUrl: Option.Option<URL>;
    readonly devRemoteT3ServerEntryPath: Option.Option<string>;
    readonly configuredBackendPort: Option.Option<number>;
    readonly commitHashOverride: Option.Option<string>;
    readonly otlpTracesUrl: Option.Option<string>;
    readonly otlpExportIntervalMs: number;
    readonly branding: DesktopAppBranding;
    readonly displayName: string;
    readonly appUserModelId: string;
    readonly linuxDesktopEntryName: string;
    readonly linuxWmClass: string;
    readonly isLocalBuild: boolean;
    readonly userDataDirName: string;
    readonly legacyUserDataDirName: string;
    readonly defaultDesktopSettings: DesktopAppSettings.DesktopSettings;
    readonly runtimeInfo: DesktopRuntimeInfo;
    readonly resolvePickFolderDefaultPath: (rawOptions: unknown) => Option.Option<string>;
    readonly resolveResourcePathCandidates: (fileName: string) => readonly string[];
    readonly developmentDockIconPath: string;
  }
>()("@t3tools/desktop/app/DesktopEnvironment") {}

const APP_BASE_NAME = "T3 Code";

function resolveDesktopAppStageLabel(input: {
  readonly isDevelopment: boolean;
  readonly isLocalBuild: boolean;
  readonly appVersion: string;
}): DesktopAppStageLabel {
  if (input.isDevelopment) {
    return "Dev";
  }
  if (input.isLocalBuild) {
    return "Local";
  }

  return isNightlyDesktopVersion(input.appVersion) ? "Nightly" : "Alpha";
}

function resolveDesktopAppBranding(input: {
  readonly isDevelopment: boolean;
  readonly isLocalBuild: boolean;
  readonly appVersion: string;
}): DesktopAppBranding {
  const stageLabel = resolveDesktopAppStageLabel(input);
  return {
    baseName: APP_BASE_NAME,
    stageLabel,
    displayName: `${APP_BASE_NAME} (${stageLabel})`,
  };
}

// Packaged local builds (scripts/build-desktop-artifact.ts --local) mark their app
// package.json with `t3codeLocalBuild: true`. The marker travels inside the artifact,
// so the identity decision is baked into the build instead of guessed at runtime.
const AppPackageBuildMetadata = Schema.fromJsonString(
  Schema.Struct({ t3codeLocalBuild: Schema.optional(Schema.Boolean) }),
);
const decodeAppPackageBuildMetadata = Schema.decodeEffect(AppPackageBuildMetadata);

const readPackagedLocalBuildMarker = Effect.fn("desktop.environment.readLocalBuildMarker")(
  function* (packageJsonPath: string): Effect.fn.Return<boolean, never, FileSystem.FileSystem> {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(packageJsonPath).pipe(Effect.option);
    return yield* Option.match(raw, {
      onNone: () => Effect.succeed(false),
      onSome: (value) =>
        decodeAppPackageBuildMetadata(value).pipe(
          Effect.map((parsed) => parsed.t3codeLocalBuild === true),
          Effect.orElseSucceed(() => false),
        ),
    });
  },
);

function normalizeDesktopArch(arch: string): DesktopRuntimeArch {
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "x64";
  return "other";
}

function resolveDesktopRuntimeInfo(input: {
  readonly platform: NodeJS.Platform;
  readonly processArch: string;
  readonly runningUnderArm64Translation: boolean;
}): DesktopRuntimeInfo {
  const appArch = normalizeDesktopArch(input.processArch);

  if (input.platform !== "darwin") {
    return {
      hostArch: appArch,
      appArch,
      runningUnderArm64Translation: false,
    };
  }

  const hostArch = appArch === "arm64" || input.runningUnderArm64Translation ? "arm64" : appArch;

  return {
    hostArch,
    appArch,
    runningUnderArm64Translation: input.runningUnderArm64Translation,
  };
}

const make = Effect.fn("desktop.environment.make")(function* (
  input: MakeDesktopEnvironmentInput,
): Effect.fn.Return<
  DesktopEnvironment["Service"],
  Config.ConfigError,
  FileSystem.FileSystem | Path.Path
> {
  const path = yield* Path.Path;
  const config = yield* DesktopConfig.DesktopConfig;
  const homeDirectory = input.homeDirectory;
  const devServerUrl = config.devServerUrl;
  const isDevelopment = Option.isSome(devServerUrl);
  const appDataDirectory =
    input.platform === "win32"
      ? Option.getOrElse(config.appDataDirectory, () =>
          path.join(homeDirectory, "AppData", "Roaming"),
        )
      : input.platform === "darwin"
        ? path.join(homeDirectory, "Library", "Application Support")
        : Option.getOrElse(config.xdgConfigHome, () => path.join(homeDirectory, ".config"));
  const configuredBaseDir = config.t3Home;
  const rootDir = path.resolve(input.dirname, "../../..");
  const appRoot = input.isPackaged ? input.appPath : rootDir;
  // Non-dev runs that are not the released app (repo `start:desktop`, smoke tests,
  // and packaged artifacts carrying the local-build marker) get a separate "Local"
  // identity. Sharing the release identity breaks side-by-side use: the Chromium
  // singleton lock in the shared userData dir makes requestSingleInstanceLock()
  // fail while the installed app runs, so the local instance quits immediately,
  // and a shared ~/.t3 would let two backends race on the same state.
  const isLocalBuild =
    !isDevelopment &&
    (!input.isPackaged ||
      (yield* readPackagedLocalBuildMarker(path.join(appRoot, "package.json"))));
  const baseDir = Option.getOrElse(configuredBaseDir, () =>
    path.join(homeDirectory, isLocalBuild ? ".t3-local" : ".t3"),
  );
  const branding = resolveDesktopAppBranding({
    isDevelopment,
    isLocalBuild,
    appVersion: input.appVersion,
  });
  const displayName = branding.displayName;
  const stateDir = path.join(
    baseDir,
    isDevelopment && Option.isNone(configuredBaseDir) ? "dev" : "userdata",
  );
  const userDataDirName = isDevelopment ? "t3code-dev" : isLocalBuild ? "t3code-local" : "t3code";
  const legacyUserDataDirName = isDevelopment
    ? "T3 Code (Dev)"
    : isLocalBuild
      ? "T3 Code (Local)"
      : "T3 Code (Alpha)";
  const resourcesPath = input.resourcesPath;

  return DesktopEnvironment.of({
    path,
    dirname: input.dirname,
    platform: input.platform,
    processArch: input.processArch,
    isPackaged: input.isPackaged,
    isDevelopment,
    appVersion: input.appVersion,
    appPath: input.appPath,
    resourcesPath,
    homeDirectory,
    appDataDirectory,
    baseDir,
    stateDir,
    desktopSettingsPath: path.join(stateDir, "desktop-settings.json"),
    clientSettingsPath: path.join(stateDir, "client-settings.json"),
    savedEnvironmentRegistryPath: path.join(stateDir, "saved-environments.json"),
    serverSettingsPath: path.join(stateDir, "settings.json"),
    logDir: path.join(stateDir, "logs"),
    browserArtifactsDir: path.join(stateDir, "browser-artifacts"),
    rootDir,
    appRoot,
    backendEntryPath: path.join(appRoot, "apps/server/dist/bin.mjs"),
    backendCwd: input.isPackaged ? homeDirectory : appRoot,
    preloadPath: path.join(input.dirname, "preload.cjs"),
    appUpdateYmlPath: input.isPackaged
      ? path.join(resourcesPath, "app-update.yml")
      : path.join(input.appPath, "dev-app-update.yml"),
    devServerUrl,
    devRemoteT3ServerEntryPath: config.devRemoteT3ServerEntryPath,
    configuredBackendPort: config.configuredBackendPort,
    commitHashOverride: config.commitHashOverride,
    otlpTracesUrl: config.otlpTracesUrl,
    otlpExportIntervalMs: config.otlpExportIntervalMs,
    branding,
    displayName,
    appUserModelId: Option.getOrElse(config.appUserModelIdOverride, () =>
      isDevelopment
        ? "com.t3tools.t3code.dev"
        : isLocalBuild
          ? "com.t3tools.t3code.local"
          : "com.t3tools.t3code",
    ),
    linuxDesktopEntryName: isDevelopment
      ? "t3code-dev.desktop"
      : isLocalBuild
        ? "t3code-local.desktop"
        : "t3code.desktop",
    linuxWmClass: isDevelopment ? "t3code-dev" : isLocalBuild ? "t3code-local" : "t3code",
    isLocalBuild,
    userDataDirName,
    legacyUserDataDirName,
    defaultDesktopSettings: DesktopAppSettings.resolveDefaultDesktopSettings(input.appVersion),
    runtimeInfo: resolveDesktopRuntimeInfo({
      platform: input.platform,
      processArch: input.processArch,
      runningUnderArm64Translation: input.runningUnderArm64Translation,
    }),
    resolvePickFolderDefaultPath: (rawOptions) => {
      if (typeof rawOptions !== "object" || rawOptions === null) {
        return Option.none();
      }

      const { initialPath } = rawOptions as { initialPath?: unknown };
      if (typeof initialPath !== "string") {
        return Option.none();
      }

      const trimmedPath = initialPath.trim();
      if (trimmedPath.length === 0) {
        return Option.none();
      }

      if (trimmedPath === "~") {
        return Option.some(homeDirectory);
      }

      if (trimmedPath.startsWith("~/") || trimmedPath.startsWith("~\\")) {
        return Option.some(path.join(homeDirectory, trimmedPath.slice(2)));
      }

      return Option.some(path.resolve(trimmedPath));
    },
    resolveResourcePathCandidates: (fileName) => [
      path.join(input.dirname, "../resources", fileName),
      path.join(input.dirname, "../prod-resources", fileName),
      path.join(resourcesPath, "resources", fileName),
      path.join(resourcesPath, fileName),
    ],
    developmentDockIconPath: path.join(rootDir, "assets", "dev", "blueprint-macos-1024.png"),
  });
});

export const layer = (input: MakeDesktopEnvironmentInput) =>
  Layer.effect(DesktopEnvironment, make(input));
