import {
  CheckpointRef,
  EventId,
  MessageId,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyRedoSlices,
  computeRedoStashForRevert,
  computeRevertRetention,
} from "./threadRedo.js";

// ── Fixtures ─────────────────────────────────────────────────────────
// A thread with two completed turns. Reverting to turn 1 removes the
// turn-2 slices; the stash must contain exactly those.

function makeMessage(
  id: string,
  role: "user" | "assistant" | "system",
  turnId: string | null,
  createdAt: string,
): OrchestrationMessage {
  return {
    id: MessageId.make(id),
    role,
    text: `${role} ${id}`,
    turnId: turnId === null ? null : TurnId.make(turnId),
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  };
}

function makeCheckpoint(
  turnId: string,
  checkpointTurnCount: number,
  assistantMessageId: string,
  completedAt: string,
): OrchestrationCheckpointSummary {
  return {
    turnId: TurnId.make(turnId),
    checkpointTurnCount,
    checkpointRef: CheckpointRef.make(`refs/t3/checkpoints/${turnId}`),
    status: "ready",
    files: [],
    assistantMessageId: MessageId.make(assistantMessageId),
    completedAt,
  };
}

function makeActivity(
  id: string,
  turnId: string | null,
  createdAt: string,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind: "checkpoint.captured",
    summary: "Checkpoint captured",
    payload: {},
    turnId: turnId === null ? null : TurnId.make(turnId),
    createdAt,
  };
}

function makeLatestTurn(turnId: string, assistantMessageId: string): OrchestrationLatestTurn {
  return {
    turnId: TurnId.make(turnId),
    state: "completed",
    requestedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:10.000Z",
    assistantMessageId: MessageId.make(assistantMessageId),
  };
}

const messages = [
  makeMessage("msg-user-1", "user", "turn-1", "2026-01-01T00:01:00.000Z"),
  makeMessage("msg-assistant-1", "assistant", "turn-1", "2026-01-01T00:02:00.000Z"),
  makeMessage("msg-user-2", "user", "turn-2", "2026-01-01T00:03:00.000Z"),
  makeMessage("msg-assistant-2", "assistant", "turn-2", "2026-01-01T00:04:00.000Z"),
];
const checkpoints = [
  makeCheckpoint("turn-1", 1, "msg-assistant-1", "2026-01-01T00:02:00.000Z"),
  makeCheckpoint("turn-2", 2, "msg-assistant-2", "2026-01-01T00:04:00.000Z"),
];
const activities = [
  makeActivity("activity-1", "turn-1", "2026-01-01T00:02:00.000Z"),
  makeActivity("activity-2", "turn-2", "2026-01-01T00:04:00.000Z"),
];

const thread = {
  messages,
  proposedPlans: [],
  activities,
  checkpoints,
  latestTurn: makeLatestTurn("turn-2", "msg-assistant-2"),
  redo: null,
};

describe("computeRevertRetention", () => {
  it("keeps only slices belonging to turns at or below the target turn count", () => {
    const retained = computeRevertRetention(thread, 1);

    expect(retained.checkpoints.map((entry) => entry.turnId)).toEqual(["turn-1"]);
    expect(retained.messages.map((entry) => entry.id)).toEqual(["msg-user-1", "msg-assistant-1"]);
    expect(retained.activities.map((entry) => entry.id)).toEqual(["activity-1"]);
  });

  it("keeps everything when reverting to the current turn count", () => {
    const retained = computeRevertRetention(thread, 2);

    expect(retained.checkpoints).toHaveLength(2);
    expect(retained.messages).toHaveLength(4);
    expect(retained.activities).toHaveLength(2);
  });
});

describe("computeRedoStashForRevert", () => {
  it("stashes exactly the removed slices and remembers the pre-revert turn count", () => {
    const stash = computeRedoStashForRevert({
      thread,
      turnCount: 1,
      filesRestored: true,
      revertedAt: "2026-01-01T01:00:00.000Z",
    });

    expect(stash).not.toBeNull();
    expect(stash?.turnCount).toBe(2);
    expect(stash?.filesRestored).toBe(true);
    expect(stash?.messages.map((entry) => entry.id)).toEqual(["msg-user-2", "msg-assistant-2"]);
    expect(stash?.checkpoints.map((entry) => entry.turnId)).toEqual(["turn-2"]);
    expect(stash?.activities.map((entry) => entry.id)).toEqual(["activity-2"]);
    expect(stash?.latestTurn?.turnId).toBe("turn-2");
    expect(stash?.revertedAt).toBe("2026-01-01T01:00:00.000Z");
  });

  it("returns null when the revert removes nothing and there is no earlier stash", () => {
    const stash = computeRedoStashForRevert({
      thread,
      turnCount: 2,
      filesRestored: true,
      revertedAt: "2026-01-01T01:00:00.000Z",
    });

    expect(stash).toBeNull();
  });

  it("merges consecutive reverts so a single redo restores the highest state", () => {
    // First revert: 2 -> 1. The thread now carries that stash.
    const firstStash = computeRedoStashForRevert({
      thread,
      turnCount: 1,
      filesRestored: false,
      revertedAt: "2026-01-01T01:00:00.000Z",
    });
    const revertedOnce = {
      ...computeRevertRetention(thread, 1),
      latestTurn: makeLatestTurn("turn-1", "msg-assistant-1"),
      redo: firstStash,
    };

    // Second revert: 1 -> 0, with files this time.
    const mergedStash = computeRedoStashForRevert({
      thread: revertedOnce,
      turnCount: 0,
      filesRestored: true,
      revertedAt: "2026-01-01T02:00:00.000Z",
    });

    expect(mergedStash?.turnCount).toBe(2);
    // filesRestored is sticky: any revert in the chain that touched files
    // means the redo must restore files too.
    expect(mergedStash?.filesRestored).toBe(true);
    expect(mergedStash?.messages.map((entry) => entry.id).toSorted()).toEqual([
      "msg-assistant-1",
      "msg-assistant-2",
      "msg-user-1",
      "msg-user-2",
    ]);
    expect(mergedStash?.checkpoints.map((entry) => entry.turnId).toSorted()).toEqual([
      "turn-1",
      "turn-2",
    ]);
    // The latest turn from the higher (earlier) stash wins.
    expect(mergedStash?.latestTurn?.turnId).toBe("turn-2");
  });
});

describe("applyRedoSlices", () => {
  it("round-trips: retention plus stash reproduces the original thread", () => {
    const stash = computeRedoStashForRevert({
      thread,
      turnCount: 1,
      filesRestored: true,
      revertedAt: "2026-01-01T01:00:00.000Z",
    });
    const retained = computeRevertRetention(thread, 1);

    const restored = applyRedoSlices(retained, {
      messages: stash?.messages ?? [],
      proposedPlans: stash?.proposedPlans ?? [],
      activities: stash?.activities ?? [],
      checkpoints: stash?.checkpoints ?? [],
    });

    expect(restored.messages.map((entry) => entry.id)).toEqual(messages.map((entry) => entry.id));
    expect(restored.checkpoints.map((entry) => entry.turnId)).toEqual(["turn-1", "turn-2"]);
    expect(restored.activities.map((entry) => entry.id)).toEqual(["activity-1", "activity-2"]);
  });

  it("drops duplicates when a slice is already present", () => {
    const restored = applyRedoSlices(
      { messages, proposedPlans: [], activities: [], checkpoints: [] },
      { messages, proposedPlans: [], activities: [], checkpoints: [] },
    );

    expect(restored.messages).toHaveLength(messages.length);
  });
});
