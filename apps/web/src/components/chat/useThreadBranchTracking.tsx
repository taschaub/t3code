import type { ScopedThreadRef, VcsStatusResult } from "@t3tools/contracts";
import { GitBranchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  resolveThreadBranchAutoLink,
  resolveThreadBranchMismatch,
  type ThreadBranchMismatch,
} from "../../lib/threadBranchTracking";
import { threadEnvironment } from "../../state/threads";
import { vcsEnvironment } from "../../state/vcs";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

interface UseThreadBranchTrackingInput {
  // Auto-link + relink only fire for server threads. Drafts capture their
  // branch via the createThread bootstrap on first send (see ChatView).
  readonly threadRef: ScopedThreadRef | null;
  readonly threadBranch: string | null;
  readonly worktreePath: string | null;
  readonly projectCwd: string | null;
  readonly gitStatus: VcsStatusResult | null;
  // True while a turn is mid-send so we don't race with thread.turn.start.
  readonly isSendInFlight: boolean;
}

/**
 * Per-chat branch tracking glue:
 * - Auto-links a server thread to the current ref the first time we observe
 *   it without a branch (older chats get tagged transparently on open).
 * - Builds a banner item for ComposerBannerStack when the chat's stored
 *   branch differs from the working tree's ref. The banner exposes two
 *   explicit choices: checkout the chat's branch, or relink to the current.
 */
export function useThreadBranchTracking(input: UseThreadBranchTrackingInput): {
  readonly mismatchBannerItem: ComposerBannerStackItem | null;
} {
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  // Dedupe key — guards StrictMode double-fires and effect re-runs while
  // the dispatched event is still propagating back through the store.
  const lastAutoLinkedRef = useRef<string | null>(null);
  const [isActionPending, setIsActionPending] = useState(false);

  useEffect(() => {
    if (!input.threadRef || input.isSendInFlight) return;
    const autoLink = resolveThreadBranchAutoLink({
      threadBranch: input.threadBranch,
      gitStatus: input.gitStatus,
    });
    if (!autoLink) return;

    const dedupeKey = `${input.threadRef.environmentId}:${input.threadRef.threadId}:${autoLink.branch}`;
    if (lastAutoLinkedRef.current === dedupeKey) return;
    lastAutoLinkedRef.current = dedupeKey;

    // Fire-and-forget; the snapshot pushed back by the server updates the
    // read model (and the sidebar badge) once the command lands.
    void updateThreadMetadata({
      environmentId: input.threadRef.environmentId,
      input: {
        threadId: input.threadRef.threadId,
        branch: autoLink.branch,
        worktreePath: input.worktreePath,
      },
    });
  }, [
    input.gitStatus,
    input.isSendInFlight,
    input.threadBranch,
    input.threadRef,
    input.worktreePath,
    updateThreadMetadata,
  ]);

  const mismatch = useMemo(
    () =>
      resolveThreadBranchMismatch({
        threadBranch: input.threadBranch,
        currentBranch: input.gitStatus?.refName ?? null,
      }),
    [input.gitStatus?.refName, input.threadBranch],
  );

  const handleCheckout = useCallback(
    async (target: ThreadBranchMismatch) => {
      if (!input.threadRef || !input.projectCwd) return;
      // Run checkout against the same working tree the status query points
      // at — worktree path if any, otherwise the project root.
      const checkoutCwd = input.worktreePath ?? input.projectCwd;
      setIsActionPending(true);
      const result = await switchRef({
        environmentId: input.threadRef.environmentId,
        input: { cwd: checkoutCwd, refName: target.threadBranch },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to switch branch.",
            description: error instanceof Error ? error.message : "Unknown error.",
          }),
        );
      }
      setIsActionPending(false);
    },
    [input.projectCwd, input.threadRef, input.worktreePath, switchRef],
  );

  const handleRelink = useCallback(
    async (target: ThreadBranchMismatch) => {
      if (!input.threadRef) return;
      setIsActionPending(true);
      const result = await updateThreadMetadata({
        environmentId: input.threadRef.environmentId,
        input: {
          threadId: input.threadRef.threadId,
          branch: target.currentBranch,
          worktreePath: input.worktreePath,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to relink chat to current branch.",
            description: error instanceof Error ? error.message : "Unknown error.",
          }),
        );
      }
      setIsActionPending(false);
    },
    [input.threadRef, input.worktreePath, updateThreadMetadata],
  );

  const mismatchBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (!mismatch) return null;
    return {
      id: `branch-mismatch:${mismatch.threadBranch}->${mismatch.currentBranch}`,
      variant: "warning",
      icon: <GitBranchIcon />,
      title: (
        <>
          Chat is on <code className="font-mono text-[0.95em]">{mismatch.threadBranch}</code>,
          checkout is on <code className="font-mono text-[0.95em]">{mismatch.currentBranch}</code>
        </>
      ),
      description:
        "Continuing now would run the agent against a different branch. Switch the working tree, or relink this chat to the current branch.",
      actions: (
        <>
          {/* max-w-full + truncate keep long branch names from pushing the
              buttons past the alert edge on narrow (mobile) screens. */}
          <Button
            size="xs"
            className="max-w-full"
            disabled={isActionPending}
            onClick={() => void handleCheckout(mismatch)}
          >
            <span className="truncate">Checkout {mismatch.threadBranch}</span>
          </Button>
          <Button
            size="xs"
            variant="outline"
            className="max-w-full"
            disabled={isActionPending}
            onClick={() => void handleRelink(mismatch)}
          >
            <span className="truncate">Relink to {mismatch.currentBranch}</span>
          </Button>
        </>
      ),
    };
  }, [handleCheckout, handleRelink, isActionPending, mismatch]);

  return { mismatchBannerItem };
}
