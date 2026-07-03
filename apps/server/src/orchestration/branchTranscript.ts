/**
 * Transcript injection for branched threads.
 *
 * Providers like Cursor have no native "fork session" API, so a branched
 * thread starts a brand-new provider session that knows nothing about the
 * copied conversation. To keep logical continuity, the first turn of a
 * branched thread prepends a plain-text transcript of the copied history to
 * the prompt. Follow-up turns rely on the provider's own session history.
 */

const DEFAULT_MAX_TRANSCRIPT_CHARS = 50_000;
const TRUNCATION_MARKER = "[Earlier conversation truncated]";

export interface BranchTranscriptMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly streaming: boolean;
}

/**
 * A thread is "branched and awaiting its first provider turn" when it has
 * assistant messages but never had a provider session. Assistant messages are
 * only ever produced by provider turns (which require a session), so their
 * presence without a session means the history was copied by `thread.branch`.
 */
export function isBranchedThreadAwaitingFirstTurn(input: {
  readonly session: unknown | null;
  readonly messages: ReadonlyArray<{ readonly role: string }>;
}): boolean {
  return input.session === null && input.messages.some((message) => message.role === "assistant");
}

function formatTranscriptEntry(message: BranchTranscriptMessage): string {
  return `[${message.role}]: ${message.text.trim()}`;
}

/**
 * Build the transcript block for the copied history of a branched thread.
 *
 * Includes every non-empty message before `currentMessageId` (the user
 * message that starts the first turn). Keeps the most recent messages when
 * the budget is exceeded, dropping the oldest ones and marking truncation.
 * Returns null when there is no history worth injecting.
 */
export function buildBranchContextPrefix(input: {
  readonly messages: ReadonlyArray<BranchTranscriptMessage>;
  readonly currentMessageId: string;
  readonly maxChars?: number;
}): string | null {
  const maxChars = input.maxChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS;
  const currentIndex = input.messages.findIndex((message) => message.id === input.currentMessageId);
  const history = (
    currentIndex === -1 ? input.messages : input.messages.slice(0, currentIndex)
  ).filter((message) => !message.streaming && message.text.trim().length > 0);

  if (!history.some((message) => message.role === "assistant")) {
    return null;
  }

  // Keep the newest messages within budget; drop the oldest ones first.
  const entries: string[] = [];
  let usedChars = 0;
  let truncated = false;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = formatTranscriptEntry(history[index]!);
    const entryChars = entry.length + 1;
    if (usedChars + entryChars > maxChars) {
      // Nothing fits at all: keep a tail slice of the newest message so the
      // provider still gets the most relevant context.
      if (entries.length === 0) {
        entries.push(entry.slice(entry.length - maxChars));
      }
      truncated = true;
      break;
    }
    entries.push(entry);
    usedChars += entryChars;
  }
  entries.reverse();

  const transcript = [...(truncated ? [TRUNCATION_MARKER] : []), ...entries].join("\n\n");

  return [
    "<branched_conversation_context>",
    "This thread was branched from an earlier conversation. The transcript below is the shared history. Continue seamlessly from it; do not summarize or repeat it back.",
    "",
    transcript,
    "</branched_conversation_context>",
  ].join("\n");
}

/** Compose the provider prompt for the first turn of a branched thread. */
export function composeBranchedFirstTurnInput(prefix: string, messageText: string): string {
  return `${prefix}\n\n${messageText}`;
}
