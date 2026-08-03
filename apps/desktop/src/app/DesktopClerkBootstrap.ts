// @effect-diagnostics nodeBuiltinImport:off - Runs synchronously during module evaluation, before the Effect runtime (and its FileSystem layer) exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type * as Electron from "electron";
import * as Option from "effect/Option";

import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

// The Clerk SDK bridge calls protocol.registerSchemesAsPrivileged, which
// Electron only accepts before the app's ready event. Packaged builds can
// spend longer evaluating main.cjs than Chromium spends starting up, so ready
// is already queued by the time the Effect runtime first yields to the event
// loop — any asynchronous step before bridge creation loses the race and the
// app dies before showing a window. This bootstrap therefore runs fully
// synchronously at module-evaluation time in main.ts, where ready cannot have
// been delivered yet.
//
// It mirrors the identity decisions DesktopEnvironment makes through the
// config layer (shared via resolveDesktopIdentityPaths) because the bridge
// acquires Electron's single-instance lock at creation: userData must already
// point at the real directory, and the bridge storage must live in the same
// stateDir the rest of the app resolves later.

export interface DesktopClerkBootstrapInput {
  readonly app: Pick<Electron.App, "isPackaged" | "getAppPath" | "setPath">;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly createBridge?: typeof DesktopClerk.createDesktopClerkBridge;
}

const trimNonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
};

// Sync twin of DesktopEnvironment's readPackagedLocalBuildMarker.
const readPackagedLocalBuildMarkerSync = (packageJsonPath: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(packageJsonPath, "utf8"));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { t3codeLocalBuild?: unknown }).t3codeLocalBuild === true
    );
  } catch {
    return false;
  }
};

export function bootstrapDesktopClerk(
  input: DesktopClerkBootstrapInput,
): DesktopClerk.DesktopClerkBootstrap {
  const devServerUrl = trimNonEmpty(input.env.VITE_DEV_SERVER_URL);
  const isDevelopment = devServerUrl !== undefined && URL.canParse(devServerUrl);
  const isLocalBuild =
    !isDevelopment &&
    (!input.app.isPackaged ||
      readPackagedLocalBuildMarkerSync(NodePath.join(input.app.getAppPath(), "package.json")));
  const paths = DesktopEnvironment.resolveDesktopIdentityPaths({
    platform: input.platform,
    homeDirectory: input.homeDirectory,
    appDataDirectoryOverride: Option.fromNullishOr(trimNonEmpty(input.env.APPDATA)),
    xdgConfigHome: Option.fromNullishOr(trimNonEmpty(input.env.XDG_CONFIG_HOME)),
    t3Home: Option.fromNullishOr(trimNonEmpty(input.env.T3CODE_HOME)),
    isDevelopment,
    isLocalBuild,
    join: NodePath.join,
  });

  // Electron scopes the single-instance lock to the userData directory and
  // creates that directory when the lock is acquired. The bridge takes the
  // lock at creation, so userData must already point at the real directory
  // here — under the default productName-derived path, acquiring the lock
  // would create "T3 Code (Alpha)" and make the legacy-install detection in
  // DesktopAppIdentity.resolveUserDataPath match on fresh installs.
  const legacyUserDataPath = NodePath.join(paths.appDataDirectory, paths.legacyUserDataDirName);
  const userDataPath = NodeFS.existsSync(legacyUserDataPath)
    ? legacyUserDataPath
    : NodePath.join(paths.appDataDirectory, paths.userDataDirName);
  input.app.setPath("userData", userDataPath);

  const createBridge = input.createBridge ?? DesktopClerk.createDesktopClerkBridge;
  try {
    return {
      bridge: createBridge(paths.stateDir, isDevelopment),
      stateDir: paths.stateDir,
      isDevelopment,
    };
  } catch (cause) {
    throw new DesktopClerk.DesktopClerkBridgeInitializationError({
      stateDir: paths.stateDir,
      isDevelopment,
      cause,
    });
  }
}
