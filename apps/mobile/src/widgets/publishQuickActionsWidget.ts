import type { RecentThreadShortcut } from "../persistence/imperative";

export async function publishQuickActionsWidget(_recents: ReadonlyArray<RecentThreadShortcut>) {}

export function installQuickActionsWidget(): () => void {
  return () => undefined;
}
