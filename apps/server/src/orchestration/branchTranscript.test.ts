import { describe, expect, it } from "@effect/vitest";

import {
  buildBranchContextPrefix,
  composeBranchedFirstTurnInput,
  isBranchedThreadAwaitingFirstTurn,
} from "./branchTranscript.ts";

function message(input: {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  streaming?: boolean;
}) {
  return {
    id: input.id,
    role: input.role,
    text: input.text,
    streaming: input.streaming ?? false,
  };
}

describe("isBranchedThreadAwaitingFirstTurn", () => {
  it("is true for a sessionless thread with assistant history", () => {
    expect(
      isBranchedThreadAwaitingFirstTurn({
        session: null,
        messages: [message({ id: "m1", role: "user", text: "hi" }), { role: "assistant" }],
      }),
    ).toBe(true);
  });

  it("is false for a fresh thread (no assistant messages)", () => {
    expect(
      isBranchedThreadAwaitingFirstTurn({
        session: null,
        messages: [{ role: "user" }],
      }),
    ).toBe(false);
  });

  it("is false once a provider session exists", () => {
    expect(
      isBranchedThreadAwaitingFirstTurn({
        session: { status: "running" },
        messages: [{ role: "assistant" }],
      }),
    ).toBe(false);
  });
});

describe("buildBranchContextPrefix", () => {
  it("includes history before the current message and skips the rest", () => {
    const prefix = buildBranchContextPrefix({
      messages: [
        message({ id: "m1", role: "user", text: "first question" }),
        message({ id: "m2", role: "assistant", text: "first answer" }),
        message({ id: "m3", role: "user", text: "new prompt after branch" }),
      ],
      currentMessageId: "m3",
    });
    expect(prefix).toContain("[user]: first question");
    expect(prefix).toContain("[assistant]: first answer");
    expect(prefix).not.toContain("new prompt after branch");
    expect(prefix).toContain("<branched_conversation_context>");
  });

  it("returns null when there is no assistant history", () => {
    expect(
      buildBranchContextPrefix({
        messages: [
          message({ id: "m1", role: "user", text: "only user text" }),
          message({ id: "m2", role: "user", text: "current" }),
        ],
        currentMessageId: "m2",
      }),
    ).toBeNull();
  });

  it("skips streaming and empty messages", () => {
    const prefix = buildBranchContextPrefix({
      messages: [
        message({ id: "m1", role: "assistant", text: "kept" }),
        message({ id: "m2", role: "assistant", text: "still streaming", streaming: true }),
        message({ id: "m3", role: "assistant", text: "   " }),
        message({ id: "m4", role: "user", text: "current" }),
      ],
      currentMessageId: "m4",
    });
    expect(prefix).toContain("[assistant]: kept");
    expect(prefix).not.toContain("still streaming");
  });

  it("drops the oldest messages first when over budget and marks truncation", () => {
    const prefix = buildBranchContextPrefix({
      messages: [
        message({ id: "m1", role: "user", text: "oldest ".repeat(10) }),
        message({ id: "m2", role: "assistant", text: "newest answer" }),
        message({ id: "m3", role: "user", text: "current" }),
      ],
      currentMessageId: "m3",
      maxChars: 40,
    });
    expect(prefix).toContain("[Earlier conversation truncated]");
    expect(prefix).toContain("newest answer");
    expect(prefix).not.toContain("oldest oldest");
  });
});

describe("composeBranchedFirstTurnInput", () => {
  it("prepends the prefix to the message text", () => {
    expect(composeBranchedFirstTurnInput("PREFIX", "hello")).toBe("PREFIX\n\nhello");
  });
});
