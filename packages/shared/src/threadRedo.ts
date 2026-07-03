/**
 * Redo support for checkpoint reverts.
 *
 * A checkpoint revert truncates a thread's conversation (messages,
 * activities, plans, checkpoints). To make that undoable, the removed slices
 * are stashed on the thread as `redo` state until the history diverges (a new
 * turn starts). The stash travels inside the `thread.reverted` event payload
 * (computed by the checkpoint reactor from the authoritative thread detail)
 * and the restored slices inside `thread.redone`, so the server projector,
 * the SQL projections, and connected clients all apply the same data
 * deterministically — including during event replay.
 *
 * These helpers are pure and shared between the server and the client
 * runtime so both read models stay in lockstep.
 */
import type {
  OrchestrationCheckpointSummary,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationThreadActivity,
  OrchestrationThreadRedoState,
} from "@t3tools/contracts";

/** The truncatable conversation slices of a thread. */
export interface ThreadRedoSlices {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly proposedPlans: ReadonlyArray<OrchestrationProposedPlan>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
}

function removedByKey<T>(
  before: ReadonlyArray<T>,
  after: ReadonlyArray<T>,
  key: (entry: T) => string,
): T[] {
  const retained = new Set(after.map(key));
  return before.filter((entry) => !retained.has(key(entry)));
}

function dedupeByKey<T>(entries: ReadonlyArray<T>, key: (entry: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const entry of entries) {
    const entryKey = key(entry);
    if (seen.has(entryKey)) continue;
    seen.add(entryKey);
    result.push(entry);
  }
  return result;
}

function compareByCreatedAtThenId(
  left: { readonly createdAt: string; readonly id: string },
  right: { readonly createdAt: string; readonly id: string },
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

/** Sequence-aware activity ordering (matches the projector's timeline order). */
function compareActivities(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }
  return compareByCreatedAtThenId(left, right);
}

/**
 * Messages retained by a revert to `turnCount`: system messages, messages of
 * retained turns, plus count-based fallbacks for messages that lost their
 * turn binding. Mirrors the server projections' truncation.
 */
export function retainMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ReadonlyArray<OrchestrationMessage> {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(compareByCreatedAtThenId)
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(compareByCreatedAtThenId)
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

/**
 * Compute the retained conversation slices for a revert to `turnCount`,
 * mirroring the projector's truncation rules.
 */
export function computeRevertRetention(
  slices: ThreadRedoSlices,
  turnCount: number,
): ThreadRedoSlices {
  const checkpoints = slices.checkpoints
    .filter((entry) => entry.checkpointTurnCount <= turnCount)
    .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount);
  const retainedTurnIds = new Set(checkpoints.map((checkpoint) => checkpoint.turnId));
  return {
    checkpoints,
    messages: retainMessagesAfterRevert(slices.messages, retainedTurnIds, turnCount),
    proposedPlans: slices.proposedPlans.filter(
      (plan) => plan.turnId === null || retainedTurnIds.has(plan.turnId),
    ),
    activities: slices.activities.filter(
      (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
    ),
  };
}

/**
 * Build the redo stash for a revert: everything the truncation to `turnCount`
 * removes from the thread, merged with any not-yet-diverged earlier stash so
 * a single redo restores the highest turn count seen. Returns null when there
 * is nothing to redo.
 */
export function computeRedoStashForRevert(input: {
  readonly thread: ThreadRedoSlices & {
    readonly latestTurn: OrchestrationLatestTurn | null;
    readonly redo: OrchestrationThreadRedoState | null;
  };
  readonly turnCount: number;
  readonly filesRestored: boolean;
  readonly revertedAt: string;
}): OrchestrationThreadRedoState | null {
  const { thread, turnCount } = input;
  const previousRedo = thread.redo;
  const retained = computeRevertRetention(thread, turnCount);

  const removedMessages = removedByKey(thread.messages, retained.messages, (entry) => entry.id);
  const removedPlans = removedByKey(
    thread.proposedPlans,
    retained.proposedPlans,
    (entry) => entry.id,
  );
  const removedActivities = removedByKey(
    thread.activities,
    retained.activities,
    (entry) => entry.id,
  );
  const removedCheckpoints = removedByKey(
    thread.checkpoints,
    retained.checkpoints,
    (entry) => entry.turnId,
  );

  const removedAnything =
    removedMessages.length > 0 ||
    removedPlans.length > 0 ||
    removedActivities.length > 0 ||
    removedCheckpoints.length > 0;
  if (!removedAnything && previousRedo === null) {
    return null;
  }

  const currentTurnCount = thread.checkpoints.reduce(
    (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
    0,
  );
  const previousTurnCount = previousRedo?.turnCount ?? 0;

  return {
    turnCount: Math.max(currentTurnCount, previousTurnCount),
    filesRestored: input.filesRestored || (previousRedo?.filesRestored ?? false),
    messages: dedupeByKey(
      [...removedMessages, ...(previousRedo?.messages ?? [])],
      (entry) => entry.id,
    ),
    proposedPlans: dedupeByKey(
      [...removedPlans, ...(previousRedo?.proposedPlans ?? [])],
      (entry) => entry.id,
    ),
    activities: dedupeByKey(
      [...removedActivities, ...(previousRedo?.activities ?? [])],
      (entry) => entry.id,
    ),
    checkpoints: dedupeByKey(
      [...removedCheckpoints, ...(previousRedo?.checkpoints ?? [])],
      (entry) => entry.turnId,
    ),
    // The stash restores the highest state; when merging, the stash taken
    // from the higher turn count wins.
    latestTurn:
      previousTurnCount >= currentTurnCount
        ? (previousRedo?.latestTurn ?? thread.latestTurn)
        : thread.latestTurn,
    revertedAt: input.revertedAt,
  };
}

/**
 * Splice previously stashed conversation slices back into the thread.
 * Duplicates (by id) are dropped, then everything is re-sorted the same way
 * the projector orders live data.
 */
export function applyRedoSlices(
  current: ThreadRedoSlices,
  stash: ThreadRedoSlices,
): ThreadRedoSlices {
  return {
    messages: dedupeByKey([...current.messages, ...stash.messages], (entry) => entry.id).toSorted(
      compareByCreatedAtThenId,
    ),
    proposedPlans: dedupeByKey(
      [...current.proposedPlans, ...stash.proposedPlans],
      (entry) => entry.id,
    ).toSorted(compareByCreatedAtThenId),
    activities: dedupeByKey(
      [...current.activities, ...stash.activities],
      (entry) => entry.id,
    ).toSorted(compareActivities),
    checkpoints: dedupeByKey(
      [...current.checkpoints, ...stash.checkpoints],
      (entry) => entry.turnId,
    ).toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount),
  };
}
