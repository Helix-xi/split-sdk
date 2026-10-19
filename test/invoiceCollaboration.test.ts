import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  InvoiceCollaborationManager,
} from "../src/invoiceCollaboration.js";
import {
  CommentNotFoundError,
  ApprovalRequestNotFoundError,
  UnauthorizedCollaborationError,
} from "../src/errors.js";

const CREATOR = "GCREATOR1111111111111111111111111111111111111111111111111111";
const APPROVER_A = "GAPPROVER_A1111111111111111111111111111111111111111111111111";
const APPROVER_B = "GAPPROVER_B2222222222222222222222222222222222222222222222222";
const COLLABORATOR = "GCOLLABORATOR3333333333333333333333333333333333333333333333";

describe("Invoice Collaboration Features (#1053)", () => {
  let collab: InvoiceCollaborationManager;

  beforeEach(() => {
    collab = new InvoiceCollaborationManager();
  });

  describe("Comments work & Threading clear", () => {
    it("adds top-level comments and parses mentions", () => {
      const comment = collab.addComment({
        invoiceId: "inv-001",
        author: CREATOR,
        content: `Please review payment split @${APPROVER_A}`,
      });

      expect(comment.id).toBeDefined();
      expect(comment.author).toBe(CREATOR);
      expect(comment.mentions).toEqual([APPROVER_A]);

      const list = collab.getComments("inv-001");
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe(comment.id);
    });

    it("adds replies and organizes clear hierarchical threads", () => {
      const root1 = collab.addComment({
        invoiceId: "inv-001",
        author: CREATOR,
        content: "Root question 1",
      });
      const root2 = collab.addComment({
        invoiceId: "inv-001",
        author: COLLABORATOR,
        content: "Root question 2",
      });

      const reply1 = collab.addComment({
        invoiceId: "inv-001",
        author: APPROVER_A,
        content: "Reply to question 1",
        parentId: root1.id,
      });

      const nestedReply = collab.addComment({
        invoiceId: "inv-001",
        author: CREATOR,
        content: "Follow-up to reply 1",
        parentId: reply1.id,
      });

      const threads = collab.getThreadedComments("inv-001");
      expect(threads).toHaveLength(2); // Two root threads

      const thread1 = threads.find((t) => t.id === root1.id)!;
      expect(thread1.replies).toHaveLength(1);
      expect(thread1.replies[0]!.id).toBe(reply1.id);
      expect(thread1.replies[0]!.replies).toHaveLength(1);
      expect(thread1.replies[0]!.replies[0]!.id).toBe(nestedReply.id);
    });

    it("allows editing comments by original author only", () => {
      const comment = collab.addComment({
        invoiceId: "inv-001",
        author: CREATOR,
        content: "Original text",
      });

      expect(() => {
        collab.editComment(comment.id, COLLABORATOR, "Hacked text");
      }).toThrow(UnauthorizedCollaborationError);

      const edited = collab.editComment(comment.id, CREATOR, "Updated text");
      expect(edited.content).toBe("Updated text");
      expect(edited.updatedAt).toBeDefined();
    });

    it("allows soft-deleting comments by author", () => {
      const comment = collab.addComment({
        invoiceId: "inv-001",
        author: CREATOR,
        content: "To be deleted",
      });

      expect(() => {
        collab.deleteComment(comment.id, COLLABORATOR);
      }).toThrow(UnauthorizedCollaborationError);

      const deleted = collab.deleteComment(comment.id, CREATOR);
      expect(deleted).toBe(true);

      const comments = collab.getComments("inv-001");
      expect(comments).toHaveLength(0);
    });
  });

  describe("Approvals flow", () => {
    it("manages multi-approver quorum workflow to approved state", () => {
      const req = collab.requestApproval({
        invoiceId: "inv-flow",
        requestedBy: CREATOR,
        requiredApprovers: [APPROVER_A, APPROVER_B],
        minApprovals: 2,
        title: "Release Milestone 1",
      });

      expect(req.status).toBe("pending");

      // First approval
      const req1 = collab.submitDecision({
        requestId: req.id,
        approver: APPROVER_A,
        decision: "approved",
        notes: "Looks good to me",
      });
      expect(req1.status).toBe("pending");

      // Second approval completes quorum
      const req2 = collab.submitDecision({
        requestId: req.id,
        approver: APPROVER_B,
        decision: "approved",
      });
      expect(req2.status).toBe("approved");

      const summary = collab.getApprovalStatus("inv-flow");
      expect(summary.isApproved).toBe(true);
      expect(summary.approvedCount).toBe(2);
      expect(summary.pendingApprovers).toHaveLength(0);
    });

    it("transitions workflow to rejected when approval threshold cannot be reached", () => {
      const req = collab.requestApproval({
        invoiceId: "inv-reject",
        requestedBy: CREATOR,
        requiredApprovers: [APPROVER_A, APPROVER_B],
        minApprovals: 2,
      });

      const updated = collab.submitDecision({
        requestId: req.id,
        approver: APPROVER_A,
        decision: "rejected",
        notes: "Amount mismatch",
      });

      expect(updated.status).toBe("rejected");
      const summary = collab.getApprovalStatus("inv-reject");
      expect(summary.isRejected).toBe(true);
      expect(summary.rejectedBy).toEqual([APPROVER_A]);
    });

    it("prevents unauthorized accounts from submitting decisions", () => {
      const req = collab.requestApproval({
        invoiceId: "inv-auth",
        requestedBy: CREATOR,
        requiredApprovers: [APPROVER_A],
      });

      expect(() => {
        collab.submitDecision({
          requestId: req.id,
          approver: COLLABORATOR,
          decision: "approved",
        });
      }).toThrow(UnauthorizedCollaborationError);
    });
  });

  describe("Notifications sent", () => {
    it("dispatches notifications for mentions and approval requests", () => {
      const handler = vi.fn();
      collab.onNotification(handler);

      // Mention
      collab.addComment({
        invoiceId: "inv-notif",
        author: CREATOR,
        content: `Check this out @${APPROVER_A}`,
      });

      const notifsA = collab.getNotifications(APPROVER_A);
      expect(notifsA.some((n) => n.type === "mention")).toBe(true);
      expect(handler).toHaveBeenCalled();

      // Approval Request
      collab.requestApproval({
        invoiceId: "inv-notif",
        requestedBy: CREATOR,
        requiredApprovers: [APPROVER_B],
        title: "Sign-off needed",
      });

      const notifsB = collab.getNotifications(APPROVER_B);
      expect(notifsB.some((n) => n.type === "approval_requested")).toBe(true);
    });

    it("notifies parent comment author on reply", () => {
      const root = collab.addComment({
        invoiceId: "inv-reply-notif",
        author: COLLABORATOR,
        content: "Root question",
      });

      collab.addComment({
        invoiceId: "inv-reply-notif",
        author: CREATOR,
        content: "Here is your answer",
        parentId: root.id,
      });

      const notifs = collab.getNotifications(COLLABORATOR);
      expect(notifs.some((n) => n.type === "reply")).toBe(true);
    });

    it("allows marking notifications as read", () => {
      collab.addComment({
        invoiceId: "inv-read",
        author: CREATOR,
        content: `@${APPROVER_A} please check`,
      });

      const unread = collab.getNotifications(APPROVER_A, true);
      expect(unread).toHaveLength(1);

      collab.markNotificationAsRead(unread[0]!.id);
      expect(collab.getNotifications(APPROVER_A, true)).toHaveLength(0);
      expect(collab.getNotifications(APPROVER_A, false)).toHaveLength(1);
    });
  });
});
