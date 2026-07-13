/**
 * AcpPromptRetry — bounded automatic recovery for transient network failures
 * during ACP `session/prompt` turns.
 *
 * ACP CLIs like Cursor's `agent` talk to their backend over a single
 * long-lived HTTP/2 connection. When that connection dies mid-turn (NAT
 * timeout, sleep/wake, VPN rekey, proxy stream reset) the CLI fails the
 * prompt RPC with errors like:
 *
 *   - "RetriableError: [unavailable] PING timed out"
 *   - "RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)"
 *
 * The ACP session itself survives — the child process keeps running and the
 * provider retains all completed work — so re-prompting resumes the turn
 * instead of losing it. This module classifies those errors and drives a
 * bounded retry loop:
 *
 *   - If the failed attempt produced no observable session activity, the
 *     same prompt is re-sent (the provider likely never received it).
 *   - If activity was observed, the provider already has the prompt, so a
 *     short "continue" nudge resumes the interrupted work instead of
 *     duplicating the user message.
 *
 * @module provider/acp/AcpPromptRetry
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);
const isAcpTransportError = Schema.is(EffectAcpErrors.AcpTransportError);

/** Total retry attempts after the initial prompt. */
export const DEFAULT_PROMPT_NETWORK_MAX_RETRIES = 2;
/** First retry delay; doubles per retry (2s, 4s, ...). */
export const DEFAULT_PROMPT_NETWORK_RETRY_BASE_DELAY: Duration.Input = Duration.seconds(2);

/**
 * Nudge sent instead of the original prompt when the provider already
 * received it (mirrors what Cursor's own "Continue" button does).
 */
export const CONTINUE_AFTER_NETWORK_ERROR_PROMPT =
  "The previous response was interrupted by a temporary network error. " +
  "Continue exactly where you left off. Do not repeat work that already completed.";

/**
 * Error signatures of transient connection failures between an ACP CLI and
 * its backend. Deliberately narrow: anything not matched here fails the turn
 * immediately, as before.
 */
const RETRIABLE_NETWORK_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /retriable\s*error/i,
  /ping timed out/i,
  // HTTP/2 RST_STREAM resets, e.g. "stream closed with error code CANCEL (0x8)".
  /stream closed with error code/i,
  // ConnectRPC/gRPC transient status.
  /\[unavailable\]/i,
  /econnreset/i,
  /etimedout/i,
  /socket hang up/i,
  /network error/i,
  // Undici's generic network failure message.
  /fetch failed/i,
];

/**
 * Whether an ACP error looks like a transient network failure worth
 * retrying. Process-level errors (spawn failure, process exit) are excluded:
 * the child is gone, so re-prompting the same runtime cannot succeed.
 */
export function isRetriableAcpNetworkError(error: EffectAcpErrors.AcpError): boolean {
  if (!isAcpRequestError(error) && !isAcpTransportError(error)) {
    return false;
  }
  const searchText = [error.message, isAcpTransportError(error) ? error.detail : undefined]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
  return RETRIABLE_NETWORK_ERROR_PATTERNS.some((pattern) => pattern.test(searchText));
}

export interface AcpPromptNetworkRetryPolicy {
  readonly maxRetries?: number;
  readonly baseDelay?: Duration.Input;
}

export interface AcpPromptRetryAttempt {
  /** 1-based retry number (the initial prompt is not counted). */
  readonly retry: number;
  readonly maxRetries: number;
  readonly error: EffectAcpErrors.AcpError;
  readonly delay: Duration.Duration;
  readonly resend: "same-prompt" | "continue-nudge";
}

export interface AcpPromptNetworkRetryInput {
  readonly originalPrompt: ReadonlyArray<EffectAcpSchema.ContentBlock>;
  readonly sendPrompt: (
    prompt: ReadonlyArray<EffectAcpSchema.ContentBlock>,
  ) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
  /**
   * Monotonic count of session activity (content deltas, tool calls, ...)
   * observed so far. Must drain pending session updates before reading so a
   * failure that raced ahead of queued chunks is still classified correctly.
   */
  readonly observedActivityCount: Effect.Effect<number>;
  /** Stops retrying when the session was torn down or the user cancelled. */
  readonly shouldAbort: Effect.Effect<boolean>;
  /** Invoked before each retry sleep, e.g. to surface a runtime warning. */
  readonly onRetry: (attempt: AcpPromptRetryAttempt) => Effect.Effect<void>;
  readonly policy?: AcpPromptNetworkRetryPolicy;
}

/**
 * Runs an ACP prompt with bounded retries on transient network failures.
 * Non-retriable errors, aborts, and exhausted budgets fail with the last
 * prompt error, preserving the previous failure behavior.
 */
export function promptWithNetworkRetry(
  input: AcpPromptNetworkRetryInput,
): Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError> {
  const maxRetries = input.policy?.maxRetries ?? DEFAULT_PROMPT_NETWORK_MAX_RETRIES;
  const baseDelay = Duration.fromInputUnsafe(
    input.policy?.baseDelay ?? DEFAULT_PROMPT_NETWORK_RETRY_BASE_DELAY,
  );

  const attempt = (
    retriesUsed: number,
    prompt: ReadonlyArray<EffectAcpSchema.ContentBlock>,
  ): Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError> =>
    Effect.gen(function* () {
      const activityBefore = yield* input.observedActivityCount;
      return yield* input.sendPrompt(prompt).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (retriesUsed >= maxRetries || !isRetriableAcpNetworkError(error)) {
              return yield* error;
            }
            if (yield* input.shouldAbort) {
              return yield* error;
            }
            // Activity since this attempt started means the provider received
            // the prompt before the connection died — resume with a nudge
            // instead of delivering the same message twice.
            const activityAfter = yield* input.observedActivityCount;
            const resend = activityAfter > activityBefore ? "continue-nudge" : "same-prompt";
            const retry = retriesUsed + 1;
            const delay = Duration.times(baseDelay, 2 ** retriesUsed);
            yield* input.onRetry({ retry, maxRetries, error, delay, resend });
            if (Duration.toMillis(delay) > 0) {
              yield* Effect.sleep(delay);
            }
            if (yield* input.shouldAbort) {
              return yield* error;
            }
            return yield* attempt(
              retry,
              resend === "continue-nudge"
                ? [{ type: "text", text: CONTINUE_AFTER_NETWORK_ERROR_PROMPT }]
                : prompt,
            );
          }),
        ),
      );
    });

  return attempt(0, input.originalPrompt);
}
