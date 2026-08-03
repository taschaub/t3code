// @effect-diagnostics nodeBuiltinImport:off - Exercises the synchronous pre-runtime bootstrap with real temp directories.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopClerkBootstrap from "./DesktopClerkBootstrap.ts";

const makeTempHome = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-clerk-boot-"));

const makeApp = (overrides?: Partial<DesktopClerkBootstrap.DesktopClerkBootstrapInput["app"]>) => {
  const setPath = vi.fn();
  return {
    app: {
      isPackaged: false,
      getAppPath: () => "/nonexistent/app-path",
      setPath,
      ...overrides,
    },
    setPath,
  };
};

describe("DesktopClerkBootstrap", () => {
  it("sets userData before creating the bridge and uses the local identity for unpackaged runs", () => {
    const homeDirectory = makeTempHome();
    const { app, setPath } = makeApp();
    const events: string[] = [];
    setPath.mockImplementation((name: string, value: string) => {
      events.push(`setPath:${name}:${value}`);
    });
    const bridge = { cleanup: vi.fn(), isPrimaryInstance: true };
    const createBridge = vi.fn((stateDir: string, isDevelopment: boolean) => {
      events.push(`createBridge:${stateDir}:${isDevelopment}`);
      return bridge as unknown as DesktopClerk.DesktopClerkBridge;
    });

    const bootstrap = DesktopClerkBootstrap.bootstrapDesktopClerk({
      app,
      env: {},
      platform: "darwin",
      homeDirectory,
      createBridge,
    });

    const stateDir = NodePath.join(homeDirectory, ".t3-local", "userdata");
    const userDataPath = NodePath.join(
      homeDirectory,
      "Library",
      "Application Support",
      "t3code-local",
    );
    assert.deepEqual(events, [
      `setPath:userData:${userDataPath}`,
      `createBridge:${stateDir}:false`,
    ]);
    assert.strictEqual(bootstrap.bridge, bridge);
    assert.equal(bootstrap.stateDir, stateDir);
    assert.equal(bootstrap.isDevelopment, false);
  });

  it("prefers an existing legacy userData directory", () => {
    const homeDirectory = makeTempHome();
    const legacyPath = NodePath.join(
      homeDirectory,
      "Library",
      "Application Support",
      "T3 Code (Local)",
    );
    NodeFS.mkdirSync(legacyPath, { recursive: true });
    const { app, setPath } = makeApp();

    DesktopClerkBootstrap.bootstrapDesktopClerk({
      app,
      env: {},
      platform: "darwin",
      homeDirectory,
      createBridge: vi.fn(() => ({}) as DesktopClerk.DesktopClerkBridge),
    });

    assert.deepEqual(setPath.mock.calls, [["userData", legacyPath]]);
  });

  it("resolves the dev identity from VITE_DEV_SERVER_URL", () => {
    const homeDirectory = makeTempHome();
    const { app, setPath } = makeApp();
    const createBridge = vi.fn(() => ({}) as DesktopClerk.DesktopClerkBridge);

    const bootstrap = DesktopClerkBootstrap.bootstrapDesktopClerk({
      app,
      env: { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      platform: "darwin",
      homeDirectory,
      createBridge,
    });

    assert.equal(bootstrap.isDevelopment, true);
    assert.equal(bootstrap.stateDir, NodePath.join(homeDirectory, ".t3", "dev"));
    assert.deepEqual(setPath.mock.calls, [
      ["userData", NodePath.join(homeDirectory, "Library", "Application Support", "t3code-dev")],
    ]);
    assert.deepEqual(createBridge.mock.calls, [[NodePath.join(homeDirectory, ".t3", "dev"), true]]);
  });

  it("detects the packaged local-build marker", () => {
    const homeDirectory = makeTempHome();
    const appPath = NodePath.join(homeDirectory, "app");
    NodeFS.mkdirSync(appPath, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(appPath, "package.json"),
      JSON.stringify({ t3codeLocalBuild: true }),
    );
    const { app } = makeApp({ isPackaged: true, getAppPath: () => appPath });
    const createBridge = vi.fn(() => ({}) as DesktopClerk.DesktopClerkBridge);

    const bootstrap = DesktopClerkBootstrap.bootstrapDesktopClerk({
      app,
      env: {},
      platform: "darwin",
      homeDirectory,
      createBridge,
    });

    assert.equal(bootstrap.stateDir, NodePath.join(homeDirectory, ".t3-local", "userdata"));
  });

  it("uses the release identity for packaged builds without the marker", () => {
    const homeDirectory = makeTempHome();
    const appPath = NodePath.join(homeDirectory, "app");
    NodeFS.mkdirSync(appPath, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(appPath, "package.json"), JSON.stringify({}));
    const { app, setPath } = makeApp({ isPackaged: true, getAppPath: () => appPath });

    const bootstrap = DesktopClerkBootstrap.bootstrapDesktopClerk({
      app,
      env: {},
      platform: "darwin",
      homeDirectory,
      createBridge: vi.fn(() => ({}) as DesktopClerk.DesktopClerkBridge),
    });

    assert.equal(bootstrap.stateDir, NodePath.join(homeDirectory, ".t3", "userdata"));
    assert.deepEqual(setPath.mock.calls, [
      ["userData", NodePath.join(homeDirectory, "Library", "Application Support", "t3code")],
    ]);
  });

  it("preserves bridge initialization failures", () => {
    const homeDirectory = makeTempHome();
    const cause = new Error("bridge initialization failed");
    const { app } = makeApp();

    try {
      DesktopClerkBootstrap.bootstrapDesktopClerk({
        app,
        env: {},
        platform: "darwin",
        homeDirectory,
        createBridge: () => {
          throw cause;
        },
      });
      assert.fail("expected bootstrapDesktopClerk to throw");
    } catch (error) {
      assert.instanceOf(error, DesktopClerk.DesktopClerkBridgeInitializationError);
      assert.equal(error.stateDir, NodePath.join(homeDirectory, ".t3-local", "userdata"));
      assert.equal(error.isDevelopment, false);
      assert.strictEqual(error.cause, cause);
    }
  });
});
