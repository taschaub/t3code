import { createClerkBridge } from "@clerk/electron";
import { storage } from "@clerk/electron/storage";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { clerkFrontendApiHostnameFromPublishableKey } from "@t3tools/shared/relayAuth";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";

declare const __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: string | undefined;

export class DesktopClerkBridgeInitializationError extends Schema.TaggedErrorClass<DesktopClerkBridgeInitializationError>()(
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

export class DesktopClerkBridgeCleanupError extends Schema.TaggedErrorClass<DesktopClerkBridgeCleanupError>()(
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
      ElectronApp.ElectronApp | ElectronWindow.ElectronWindow | Scope.Scope
    >;
  }
>()("@t3tools/desktop/app/DesktopClerk") {}

export function resolveDesktopClerkFrontendApiHostname(
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

export function createDesktopClerkBridge(stateDir: string, isDevelopment: boolean) {
  return createClerkBridge({
    storage: storage({ path: stateDir }),
    passkeys: true,
    renderer: {
      scheme: ElectronProtocol.getDesktopScheme(isDevelopment),
      host: ElectronProtocol.DESKTOP_HOST,
    },
  });
}

export type DesktopClerkBridge = ReturnType<typeof createDesktopClerkBridge>;

// The bridge registers privileged schemes, which Electron only accepts before
// the app's ready event. Packaged builds can spend longer loading modules than
// Chromium spends starting up, so ready is already queued once the Effect
// runtime first yields to the event loop — the bridge therefore has to be
// created synchronously during module evaluation (see DesktopClerkBootstrap)
// and is handed in here, where the layer scope owns its cleanup.
export interface DesktopClerkBootstrap {
  readonly bridge: DesktopClerkBridge;
  readonly stateDir: string;
  readonly isDevelopment: boolean;
}

export const make = (bootstrap: DesktopClerkBootstrap) =>
  Effect.gen(function* () {
    const bridge = yield* Effect.acquireRelease(Effect.succeed(bootstrap.bridge), (bridge) =>
      Effect.try({
        try: () => bridge.cleanup(),
        catch: (cause) =>
          new DesktopClerkBridgeCleanupError({
            stateDir: bootstrap.stateDir,
            isDevelopment: bootstrap.isDevelopment,
            cause,
          }),
      }).pipe(Effect.orDie),
    );

    return DesktopClerk.of({
      configure: Effect.gen(function* () {
        const electronApp = yield* ElectronApp.ElectronApp;
        const electronWindow = yield* ElectronWindow.ElectronWindow;
        const context = yield* Effect.context<ElectronWindow.ElectronWindow>();
        const runPromise = Effect.runPromiseWith(context);

        // The SDK bridge holds Electron's single-instance lock (acquired at
        // bridge creation) so OAuth deep-link callbacks on Windows/Linux are
        // forwarded to the running app. In a secondary instance the bridge has
        // already begun quitting the app; app.quit() is asynchronous, so stop
        // bootstrap here before whenReady can fire.
        if (!bridge.isPrimaryInstance) {
          yield* electronApp.quit;
          return yield* Effect.interrupt;
        }

        yield* electronApp.on("second-instance", () => {
          void runPromise(
            Effect.gen(function* () {
              const mainWindow = yield* electronWindow.currentMainOrFirst;
              if (Option.isSome(mainWindow)) {
                yield* electronWindow.reveal(mainWindow.value);
              }
            }),
          );
        });
      }).pipe(Effect.withSpan("desktop.clerk.configure")),
    });
  });

export const layer = (bootstrap: DesktopClerkBootstrap) =>
  Layer.effect(DesktopClerk, make(bootstrap));
