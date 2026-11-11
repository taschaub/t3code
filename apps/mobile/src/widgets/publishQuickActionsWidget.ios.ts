import { requireOptionalNativeModule } from "expo";
import { Atom } from "effect/reactivity";
import * as Linking from "expo-linking";
import { AppState } from "react-native";

import { environmentCatalog } from "../connection/catalog";
import type { RecentThreadShortcut } from "../persistence/imperative";
import { appAtomRegistry } from "../state/atom-registry";
import { environmentProjects } from "../state/projects";
import { environmentThreadShells } from "../state/threads";
import { quickActionsSummary, quickActionsTimeline } from "./quickActionsSnapshot";
import { subscriptionUsageSnapshotAtom } from "./SubscriptionUsageCoordinator";

const recentThreadsAtom = Atom.make<ReadonlyArray<RecentThreadShortcut> | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:quick-actions-widget-recent-threads"),
);

// Thread shells change far more often than the few values the widget shows.
const summaryAtom = Atom.make((get) => {
  const recents = get(recentThreadsAtom);
  // Publishing before these load would replace a good widget with an empty one.
  if (recents === null || !get(environmentCatalog.catalogValueAtom).isReady) return null;
  return quickActionsSummary({
    origin: Linking.createURL(""),
    recents,
    threads: get(environmentThreadShells.navigationThreadShellsAtom),
    projects: get(environmentProjects.projectsAtom),
    usage: get(subscriptionUsageSnapshotAtom),
  });
}).pipe(Atom.withEquality((a, b) => JSON.stringify(a) === JSON.stringify(b)));

export async function publishQuickActionsWidget(recents: ReadonlyArray<RecentThreadShortcut>) {
  appAtomRegistry.set(recentThreadsAtom, recents);
}

export function installQuickActionsWidget(): () => void {
  if (!requireOptionalNativeModule("ExpoWidgets")) return () => undefined;
  const publish = () => {
    const summary = appAtomRegistry.get(summaryAtom);
    if (summary === null) return;
    void import("./QuickActionsWidget")
      .then(({ default: widget }) =>
        widget.updateTimeline(quickActionsTimeline(summary, Date.now())),
      )
      .catch((error: unknown) => {
        console.warn("Could not update quick actions widget", error);
      });
  };
  const unsubscribe = appAtomRegistry.subscribe(summaryAtom, publish, { immediate: true });
  // Leaving the app restarts the agent count's freshness window from what the app last saw.
  // iOS passes through "inactive" first, while a reload still costs no widget budget.
  const appState = AppState.addEventListener("change", (state) => {
    if (state === "inactive") publish();
  });
  return () => {
    unsubscribe();
    appState.remove();
  };
}
