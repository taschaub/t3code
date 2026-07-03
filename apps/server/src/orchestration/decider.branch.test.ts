import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

const NOW = "2026-01-01T00:00:00.000Z";
const SOURCE_THREAD_ID = asThreadId("thread-branch-source");
const PROJECT_ID = asProjectId("project-branch");
const BRANCH_THREAD_ID = asThreadId("thread-branch-copy");

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

function eventBase(id: string, aggregateId: ProjectId | ThreadId, sequence: number) {
  return {
    sequence,
    eventId: asEventId(id),
    aggregateId,
    occurredAt: NOW,
    commandId: asCommandId(`cmd-${id}`),
    causationEventId: null,
    correlationId: asCommandId(`cmd-${id}`),
    metadata: {},
  };
}

// Source thread: two turns, each with a user message, an activity and an
// assistant message. Uses a shared worktree/branch to verify metadata copies.
const seedReadModel = Effect.gen(function* () {
  let readModel = createEmptyReadModel(NOW);
  let sequence = 0;
  const apply = (event: PlannedEvent) =>
    projectEvent(readModel, { ...event, sequence: ++sequence } as OrchestrationEvent);

  readModel = yield* apply({
    ...eventBase("evt-project", PROJECT_ID, 0),
    aggregateKind: "project",
    type: "project.created",
    payload: {
      projectId: PROJECT_ID,
      title: "Branch Project",
      workspaceRoot: "/tmp/project-branch",
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
  readModel = yield* apply({
    ...eventBase("evt-thread", SOURCE_THREAD_ID, 0),
    aggregateKind: "thread",
    type: "thread.created",
    payload: {
      threadId: SOURCE_THREAD_ID,
      projectId: PROJECT_ID,
      title: "Source Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("cursor"),
        model: "composer-2.5",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: "feature/topic",
      worktreePath: "/tmp/project-branch-worktree",
      createdAt: NOW,
      updatedAt: NOW,
    },
  });

  const turns = [
    { turn: "turn-1", user: "message-user-1", assistant: "message-assistant-1" },
    { turn: "turn-2", user: "message-user-2", assistant: "message-assistant-2" },
  ] as const;
  for (const [index, entry] of turns.entries()) {
    // Timestamps spaced by whole minutes within the seed hour; avoids Date math.
    const at = (offsetMinutes: number) =>
      `2026-01-01T00:${String(index * 10 + offsetMinutes).padStart(2, "0")}:00.000Z`;
    readModel = yield* apply({
      ...eventBase(`evt-${entry.user}`, SOURCE_THREAD_ID, 0),
      aggregateKind: "thread",
      type: "thread.message-sent",
      payload: {
        threadId: SOURCE_THREAD_ID,
        messageId: asMessageId(entry.user),
        role: "user",
        text: `User prompt ${index + 1}`,
        turnId: asTurnId(entry.turn),
        streaming: false,
        createdAt: at(0),
        updatedAt: at(0),
      },
    });
    readModel = yield* apply({
      ...eventBase(`evt-activity-${entry.turn}`, SOURCE_THREAD_ID, 0),
      aggregateKind: "thread",
      type: "thread.activity-appended",
      payload: {
        threadId: SOURCE_THREAD_ID,
        activity: {
          id: asEventId(`activity-${entry.turn}`),
          tone: "tool",
          kind: "tool-call",
          summary: `Tool call in ${entry.turn}`,
          payload: { requestId: `request-${entry.turn}`, command: "ls" },
          turnId: asTurnId(entry.turn),
          sequence: 100 + index,
          createdAt: at(1),
        },
      },
    });
    readModel = yield* apply({
      ...eventBase(`evt-${entry.assistant}`, SOURCE_THREAD_ID, 0),
      aggregateKind: "thread",
      type: "thread.message-sent",
      payload: {
        threadId: SOURCE_THREAD_ID,
        messageId: asMessageId(entry.assistant),
        role: "assistant",
        text: `Assistant answer ${index + 1}`,
        turnId: asTurnId(entry.turn),
        streaming: false,
        createdAt: at(2),
        updatedAt: at(2),
      },
    });
  }

  return readModel;
});

function branchCommand(overrides?: { sourceMessageId?: MessageId; title?: string }) {
  return {
    type: "thread.branch",
    commandId: asCommandId("cmd-branch"),
    sourceThreadId: SOURCE_THREAD_ID,
    ...(overrides?.sourceMessageId !== undefined
      ? { sourceMessageId: overrides.sourceMessageId }
      : {}),
    threadId: BRANCH_THREAD_ID,
    ...(overrides?.title !== undefined ? { title: overrides.title } : {}),
    createdAt: "2026-01-01T05:00:00.000Z",
  } as const;
}

it.layer(NodeServices.layer)("decider thread.branch", (it) => {
  it.effect("copies the whole conversation when no branch point is given", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const decided = yield* decideOrchestrationCommand({
        command: branchCommand(),
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];

      expect(events.map((event) => event.type)).toEqual([
        "thread.created",
        "thread.message-sent",
        "thread.message-sent",
        "thread.message-sent",
        "thread.message-sent",
        "thread.activity-appended",
        "thread.activity-appended",
      ]);

      // Project the events and inspect the branched thread's read model state.
      let projected = readModel;
      let sequence = readModel.snapshotSequence;
      for (const event of events) {
        projected = yield* projectEvent(projected, {
          ...event,
          sequence: ++sequence,
        } as OrchestrationEvent);
      }
      const branched = projected.threads.find((thread) => thread.id === BRANCH_THREAD_ID);
      expect(branched).toBeDefined();
      expect(branched?.title).toBe("Source Thread (Branch)");
      expect(branched?.branch).toBe("feature/topic");
      expect(branched?.worktreePath).toBe("/tmp/project-branch-worktree");
      expect(branched?.session).toBeNull();
      expect(branched?.checkpoints).toEqual([]);
      expect(branched?.messages.map((message) => message.text)).toEqual([
        "User prompt 1",
        "Assistant answer 1",
        "User prompt 2",
        "Assistant answer 2",
      ]);
      // Copies get fresh ids, no turn linkage, and keep original timestamps.
      const sourceThread = readModel.threads.find((thread) => thread.id === SOURCE_THREAD_ID);
      expect(branched?.messages.every((message) => message.turnId === null)).toBe(true);
      expect(branched?.messages.every((message) => !message.streaming)).toBe(true);
      expect(
        branched?.messages.every(
          (message) => !sourceThread?.messages.some((source) => source.id === message.id),
        ),
      ).toBe(true);
      expect(branched?.messages.map((message) => message.createdAt)).toEqual(
        sourceThread?.messages.map((message) => message.createdAt),
      );
      // Copied activities: no sequence, no requestId, turnId cleared.
      expect(branched?.activities.map((activity) => activity.summary)).toEqual([
        "Tool call in turn-1",
        "Tool call in turn-2",
      ]);
      expect(
        branched?.activities.every(
          (activity) => activity.turnId === null && activity.sequence === undefined,
        ),
      ).toBe(true);
      expect(
        branched?.activities.every(
          (activity) =>
            typeof activity.payload === "object" &&
            activity.payload !== null &&
            !("requestId" in (activity.payload as Record<string, unknown>)),
        ),
      ).toBe(true);
    }),
  );

  it.effect("copies only history up to the branch-point assistant message", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const decided = yield* decideOrchestrationCommand({
        command: branchCommand({
          sourceMessageId: asMessageId("message-assistant-1"),
          title: "Alternate take",
        }),
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];

      let projected = readModel;
      let sequence = readModel.snapshotSequence;
      for (const event of events) {
        projected = yield* projectEvent(projected, {
          ...event,
          sequence: ++sequence,
        } as OrchestrationEvent);
      }
      const branched = projected.threads.find((thread) => thread.id === BRANCH_THREAD_ID);
      expect(branched?.title).toBe("Alternate take");
      expect(branched?.messages.map((message) => message.text)).toEqual([
        "User prompt 1",
        "Assistant answer 1",
      ]);
      expect(branched?.activities.map((activity) => activity.summary)).toEqual([
        "Tool call in turn-1",
      ]);
    }),
  );

  it.effect("rejects a user message as branch point", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: branchCommand({ sourceMessageId: asMessageId("message-user-1") }),
          readModel,
        }),
      );
      expect(error.message).toContain("not an assistant message");
    }),
  );

  it.effect("rejects an unknown branch point message", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: branchCommand({ sourceMessageId: asMessageId("message-missing") }),
          readModel,
        }),
      );
      expect(error.message).toContain("does not exist on source thread");
    }),
  );

  it.effect("rejects branching an unknown source thread", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            ...branchCommand(),
            sourceThreadId: asThreadId("thread-missing"),
          },
          readModel,
        }),
      );
      expect(error.message).toContain("does not exist");
    }),
  );
});
