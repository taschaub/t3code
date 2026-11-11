import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";

import { threadShortcutHref, threadShortcutLabel } from "../features/shortcuts/appShortcuts";
import type { RecentThreadShortcut } from "../persistence/imperative";
import type { SubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";

// The widget only refreshes while the app is open, so after this long it stops
// claiming an agent is still working. Matches the Agent Activity widget.
const AGENTS_STALE_AFTER_MS = 10 * 60_000;

// Widget props are stored in UserDefaults, which rejects null: absent values are absent keys.
export interface QuickActionsProps {
  newThreadUrl: string;
  lastThread?: { title: string; url: string; project?: string };
  agents?: { working: number; waiting: number; staleAt: number };
  usage?: Pick<SubscriptionUsageSnapshot, "checkedAt" | "providers"> & { url?: string };
}

export type QuickActionsSummary = Omit<QuickActionsProps, "agents"> & {
  agents: { working: number; waiting: number };
};

type ThreadSummaryInput = Pick<EnvironmentThreadShell, "environmentId" | "id" | "projectId"> &
  Parameters<typeof isThreadWorking>[0];

export function quickActionsSummary(input: {
  /** The app's link prefix, such as `t3code://`. */
  readonly origin: string;
  readonly recents: ReadonlyArray<RecentThreadShortcut>;
  /** The threads the app lists: subagent and archived threads would count their parent twice. */
  readonly threads: ReadonlyArray<ThreadSummaryInput>;
  readonly projects: ReadonlyArray<Pick<EnvironmentProject, "environmentId" | "id" | "title">>;
  readonly usage: SubscriptionUsageSnapshot;
}): QuickActionsSummary {
  const last = input.recents[0];
  let working = 0;
  let waiting = 0;
  let lastShell: ThreadSummaryInput | undefined;
  for (const thread of input.threads) {
    if (
      thread.hasPendingApprovals ||
      thread.hasPendingUserInput ||
      thread.pendingSubagentRequest != null
    ) {
      waiting += 1;
    } else if (isThreadWorking(thread)) {
      working += 1;
    }
    if (last && thread.environmentId === last.environmentId && thread.id === last.threadId) {
      lastShell = thread;
    }
  }
  const project =
    lastShell &&
    input.projects.find(
      (candidate) =>
        candidate.environmentId === lastShell.environmentId && candidate.id === lastShell.projectId,
    )?.title;
  return {
    newThreadUrl: `${input.origin}new`,
    ...(last
      ? {
          lastThread: {
            title: threadShortcutLabel(last),
            // The href's ids are already encoded; a URL builder would encode them again.
            url: `${input.origin}${threadShortcutHref(last).slice(1)}`,
            ...(project ? { project } : {}),
          },
        }
      : {}),
    agents: { working, waiting },
    usage: {
      ...(input.usage.url ? { url: input.usage.url } : {}),
      checkedAt: input.usage.checkedAt,
      providers: input.usage.providers,
    },
  };
}

/** One entry per moment the widget's content goes out of date; the layout compares against these. */
export function quickActionsTimeline(summary: QuickActionsSummary, now: number) {
  const staleAt = now + AGENTS_STALE_AFTER_MS;
  const props: QuickActionsProps = { ...summary, agents: { ...summary.agents, staleAt } };
  const deadlines = [staleAt, ...(summary.usage?.providers ?? []).map((p) => p.expiresAt)];
  return [...new Set([now, ...deadlines.filter((deadline) => deadline > now)])]
    .sort((a, b) => a - b)
    .map((date) => ({ date: new Date(date), props }));
}
