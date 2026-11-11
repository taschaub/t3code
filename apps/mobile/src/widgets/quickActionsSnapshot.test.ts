import { describe, expect, it } from "vite-plus/test";

import { quickActionsSummary, quickActionsTimeline } from "./quickActionsSnapshot";

type SummaryInput = Parameters<typeof quickActionsSummary>[0];

const thread = (
  id: string,
  overrides: Partial<Record<"hasPendingApprovals" | "hasPendingUserInput", boolean>> & {
    readonly running?: boolean;
    readonly pendingSubagentRequest?: "approval";
  } = {},
) =>
  ({
    environmentId: "env",
    id,
    projectId: "project",
    hasPendingApprovals: overrides.hasPendingApprovals ?? false,
    hasPendingUserInput: overrides.hasPendingUserInput ?? false,
    pendingSubagentRequest: overrides.pendingSubagentRequest ?? null,
    hasActionableProposedPlan: false,
    interactionMode: "default",
    latestRun: null,
    runtime: overrides.running ? { status: "running", activeRunId: null } : null,
  }) as unknown as SummaryInput["threads"][number];

const usage = (expiresAt: number): SummaryInput["usage"] => ({
  url: "t3code://settings/usage",
  checkedAt: 1,
  providers: [{ name: "Codex", detail: "", windows: [], expiresAt, totalWindows: 0 }],
});

const summarize = (overrides: Partial<SummaryInput> = {}) =>
  quickActionsSummary({
    origin: "t3code://",
    recents: [],
    threads: [],
    projects: [],
    usage: usage(0),
    ...overrides,
  });

describe("quickActionsSummary", () => {
  it("links the last thread with ids encoded once and names its project", () => {
    const summary = summarize({
      recents: [{ environmentId: "env", threadId: "thread:project:1", title: " " }],
      threads: [thread("thread:project:1")],
      projects: [{ environmentId: "env", id: "project", title: "server" }] as never,
    });
    expect(summary.newThreadUrl).toBe("t3code://new");
    expect(summary.lastThread).toEqual({
      title: "Thread",
      url: "t3code://threads/env/thread%3Aproject%3A1",
      project: "server",
    });
  });

  it("omits the last thread until one was opened", () => {
    expect(summarize()).not.toHaveProperty("lastThread");
  });

  it("counts working threads apart from the ones waiting on the user", () => {
    const summary = summarize({
      threads: [
        thread("a", { running: true }),
        thread("b", { running: true, hasPendingApprovals: true }),
        thread("c", { hasPendingUserInput: true }),
        thread("d", { running: true, pendingSubagentRequest: "approval" }),
        thread("e"),
      ],
    });
    expect(summary.agents).toEqual({ working: 1, waiting: 3 });
  });
});

describe("quickActionsTimeline", () => {
  it("re-renders when the agent count and each usage reading go out of date", () => {
    const now = 1_000_000;
    const timeline = quickActionsTimeline(summarize({ usage: usage(now + 60_000) }), now);
    expect(timeline.map((entry) => entry.date.getTime())).toEqual([
      now,
      now + 60_000,
      now + 10 * 60_000,
    ]);
    expect(timeline[0]?.props.agents?.staleAt).toBe(now + 10 * 60_000);
  });

  it("skips usage readings that already expired", () => {
    const now = 1_000_000;
    expect(quickActionsTimeline(summarize({ usage: usage(now - 1) }), now)).toHaveLength(2);
  });
});
