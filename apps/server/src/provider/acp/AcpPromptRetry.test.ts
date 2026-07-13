import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  CONTINUE_AFTER_NETWORK_ERROR_PROMPT,
  isRetriableAcpNetworkError,
  promptWithNetworkRetry,
  type AcpPromptRetryAttempt,
} from "./AcpPromptRetry.ts";

const pingTimeoutError = new EffectAcpErrors.AcpRequestError({
  code: -32603,
  errorMessage: "RetriableError: [unavailable] PING timed out",
});

const streamCancelError = new EffectAcpErrors.AcpRequestError({
  code: -32603,
  errorMessage: "RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)",
});

const invalidParamsError = new EffectAcpErrors.AcpRequestError({
  code: -32602,
  errorMessage: "Invalid params",
});

const textPrompt = (text: string): ReadonlyArray<EffectAcpSchema.ContentBlock> => [
  { type: "text", text },
];

const endTurnResponse = { stopReason: "end_turn" } satisfies EffectAcpSchema.PromptResponse;

describe("isRetriableAcpNetworkError", () => {
  it("matches the Cursor CLI network error signatures", () => {
    assert.isTrue(isRetriableAcpNetworkError(pingTimeoutError));
    assert.isTrue(isRetriableAcpNetworkError(streamCancelError));
  });

  it("matches transport errors with socket-level details", () => {
    const transportError = new EffectAcpErrors.AcpTransportError({
      operation: "call-rpc",
      method: "session/prompt",
      detail: "read ECONNRESET",
      cause: new Error("read ECONNRESET"),
    });
    assert.isTrue(isRetriableAcpNetworkError(transportError));
  });

  it("rejects non-network request errors", () => {
    assert.isFalse(isRetriableAcpNetworkError(invalidParamsError));
  });

  it("rejects process-level errors even when the message matches", () => {
    const processExited = new EffectAcpErrors.AcpProcessExitedError({ code: 1 });
    assert.isFalse(isRetriableAcpNetworkError(processExited));
  });
});

interface RetryHarness {
  readonly prompts: Array<ReadonlyArray<EffectAcpSchema.ContentBlock>>;
  readonly retries: Array<AcpPromptRetryAttempt>;
}

function makeHarness(input: {
  /** Errors for the first attempts; once exhausted, the prompt succeeds. */
  readonly failures: ReadonlyArray<EffectAcpErrors.AcpError>;
  /** Activity counter values returned per read (last value repeats). */
  readonly activityCounts?: ReadonlyArray<number>;
  readonly shouldAbort?: boolean;
  readonly maxRetries?: number;
  readonly baseDelay?: Duration.Input;
}) {
  const harness: RetryHarness = { prompts: [], retries: [] };
  let activityReads = 0;
  const activityCounts = input.activityCounts ?? [0];
  const effect = promptWithNetworkRetry({
    originalPrompt: textPrompt("original task"),
    sendPrompt: (prompt) => {
      harness.prompts.push(prompt);
      const failure = input.failures[harness.prompts.length - 1];
      return failure ? Effect.fail(failure) : Effect.succeed(endTurnResponse);
    },
    observedActivityCount: Effect.sync(() => {
      const value = activityCounts[Math.min(activityReads, activityCounts.length - 1)]!;
      activityReads += 1;
      return value;
    }),
    shouldAbort: Effect.succeed(input.shouldAbort ?? false),
    onRetry: (attempt) =>
      Effect.sync(() => {
        harness.retries.push(attempt);
      }),
    policy: {
      ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {}),
      baseDelay: input.baseDelay ?? Duration.zero,
    },
  });
  return { harness, effect };
}

describe("promptWithNetworkRetry", () => {
  it.effect("returns the first successful response without retrying", () =>
    Effect.gen(function* () {
      const { harness, effect } = makeHarness({ failures: [] });
      const result = yield* effect;
      assert.deepStrictEqual(result, endTurnResponse);
      assert.lengthOf(harness.prompts, 1);
      assert.lengthOf(harness.retries, 0);
    }),
  );

  it.effect("resends the same prompt when the failed attempt produced no activity", () =>
    Effect.gen(function* () {
      const { harness, effect } = makeHarness({ failures: [pingTimeoutError] });
      const result = yield* effect;
      assert.deepStrictEqual(result, endTurnResponse);
      assert.deepStrictEqual(harness.prompts, [
        textPrompt("original task"),
        textPrompt("original task"),
      ]);
      assert.lengthOf(harness.retries, 1);
      assert.equal(harness.retries[0]?.resend, "same-prompt");
    }),
  );

  it.effect("sends the continue nudge when the failed attempt produced activity", () =>
    Effect.gen(function* () {
      // Baseline read 0, post-failure read 3: chunks arrived before the drop.
      const { harness, effect } = makeHarness({
        failures: [streamCancelError],
        activityCounts: [0, 3],
      });
      const result = yield* effect;
      assert.deepStrictEqual(result, endTurnResponse);
      assert.deepStrictEqual(harness.prompts, [
        textPrompt("original task"),
        textPrompt(CONTINUE_AFTER_NETWORK_ERROR_PROMPT),
      ]);
      assert.equal(harness.retries[0]?.resend, "continue-nudge");
    }),
  );

  it.effect("does not retry non-retriable errors", () =>
    Effect.gen(function* () {
      const { harness, effect } = makeHarness({ failures: [invalidParamsError] });
      const error = yield* effect.pipe(Effect.flip);
      assert.equal(error.message, "Invalid params");
      assert.lengthOf(harness.prompts, 1);
      assert.lengthOf(harness.retries, 0);
    }),
  );

  it.effect("fails with the last error once the retry budget is exhausted", () =>
    Effect.gen(function* () {
      const { harness, effect } = makeHarness({
        failures: [pingTimeoutError, pingTimeoutError, pingTimeoutError],
        maxRetries: 2,
      });
      const error = yield* effect.pipe(Effect.flip);
      assert.include(error.message, "PING timed out");
      assert.lengthOf(harness.prompts, 3);
      assert.lengthOf(harness.retries, 2);
    }),
  );

  it.effect("does not retry when the session aborted", () =>
    Effect.gen(function* () {
      const { harness, effect } = makeHarness({
        failures: [pingTimeoutError],
        shouldAbort: true,
      });
      const error = yield* effect.pipe(Effect.flip);
      assert.include(error.message, "PING timed out");
      assert.lengthOf(harness.prompts, 1);
      assert.lengthOf(harness.retries, 0);
    }),
  );

  it.effect("grows the retry delay exponentially", () =>
    Effect.gen(function* () {
      const { harness, effect } = makeHarness({
        failures: [pingTimeoutError, pingTimeoutError],
        maxRetries: 2,
        baseDelay: Duration.seconds(2),
      });
      const fiber = yield* effect.pipe(Effect.forkChild);
      // 2s for the first retry, 4s for the second.
      yield* TestClock.adjust("2 seconds");
      yield* TestClock.adjust("4 seconds");
      const result = yield* Fiber.join(fiber);
      assert.deepStrictEqual(result, endTurnResponse);
      assert.deepStrictEqual(
        harness.retries.map((attempt) => Duration.toMillis(attempt.delay)),
        [2000, 4000],
      );
    }),
  );
});
