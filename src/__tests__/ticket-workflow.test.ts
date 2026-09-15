import { describe, expect, it, vi } from "vitest";
import {
  addInternalNoteAndSetStatus,
  createNoteMarker,
  setTicketStatus,
  type TicketWorkflowClient,
} from "../services/ticket-workflow.js";

function mockClient() {
  const get = vi.fn();
  const post = vi.fn();
  const patch = vi.fn();
  return {
    get,
    post,
    patch,
    client: { get, post, patch } as unknown as TicketWorkflowClient,
  };
}

const ticket = {
  id: 543754,
  board: { id: 12, name: "Presales" },
  status: { id: 100, name: "Copilot" },
};

const targetStatus = { id: 863, name: "SOW Needs Review" };

describe("setTicketStatus", () => {
  it("resolves against the ticket board, patches internally, and verifies by ID", async () => {
    const { client, get, patch } = mockClient();
    get
      .mockResolvedValueOnce(ticket)
      .mockResolvedValueOnce([targetStatus])
      .mockResolvedValueOnce({ ...ticket, status: targetStatus });
    patch.mockResolvedValue({ status: targetStatus });

    const result = await setTicketStatus(
      client,
      ticket.id,
      "sow needs review",
    );

    expect(result).toMatchObject({
      success: true,
      outcome: "updated",
      board: ticket.board,
      previousStatus: ticket.status,
      resolvedStatus: targetStatus,
      verifiedStatus: targetStatus,
      statusUpdateAttempted: true,
      statusChanged: true,
    });
    expect(get.mock.calls).toEqual([
      [`/service/tickets/${ticket.id}`],
      ["/service/boards/12/statuses", { page: 1, pageSize: 1000 }],
      [`/service/tickets/${ticket.id}`],
    ]);
    expect(patch).toHaveBeenCalledWith(`/service/tickets/${ticket.id}`, [
      { op: "replace", path: "/status/id", value: 863 },
    ]);
  });

  it("fails closed when no exact active status matches", async () => {
    const { client, get, patch, post } = mockClient();
    get.mockResolvedValueOnce(ticket).mockResolvedValueOnce([
      { id: 863, name: "SOW Needs Review - Old", inactiveFlag: false },
      { id: 864, name: "SOW Needs Review", inactiveFlag: true },
    ]);

    const result = await setTicketStatus(
      client,
      ticket.id,
      "SOW Needs Review",
    );

    expect(result.success).toBe(false);
    expect(result.errors[0]?.code).toBe("STATUS_NOT_FOUND");
    expect(patch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("fails closed when case-normalized exact matches are ambiguous", async () => {
    const { client, get, patch } = mockClient();
    get.mockResolvedValueOnce(ticket).mockResolvedValueOnce([
      targetStatus,
      { id: 864, name: "sow needs review" },
    ]);

    const result = await setTicketStatus(
      client,
      ticket.id,
      "SOW Needs Review",
    );

    expect(result.errors[0]?.code).toBe("STATUS_AMBIGUOUS");
    expect(patch).not.toHaveBeenCalled();
  });

  it("treats an already-correct status as success but still reads it back", async () => {
    const { client, get, patch } = mockClient();
    const completed = { ...ticket, status: targetStatus };
    get
      .mockResolvedValueOnce(completed)
      .mockResolvedValueOnce([targetStatus])
      .mockResolvedValueOnce(completed);

    const result = await setTicketStatus(
      client,
      ticket.id,
      "SOW Needs Review",
    );

    expect(result).toMatchObject({
      success: true,
      outcome: "already_correct",
      statusUpdateAttempted: false,
      statusChanged: false,
      verifiedStatus: targetStatus,
    });
    expect(patch).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("does not report success when read-back returns a different status", async () => {
    const { client, get, patch } = mockClient();
    get
      .mockResolvedValueOnce(ticket)
      .mockResolvedValueOnce([targetStatus])
      .mockResolvedValueOnce(ticket);
    patch.mockResolvedValue({ status: targetStatus });

    const result = await setTicketStatus(
      client,
      ticket.id,
      "SOW Needs Review",
    );

    expect(result.success).toBe(false);
    expect(result.verifiedStatus).toEqual(ticket.status);
    expect(result.errors.some((error) => error.code === "STATUS_MISMATCH")).toBe(
      true,
    );
  });
});

describe("addInternalNoteAndSetStatus", () => {
  it("adds an internal note with a stable marker, patches status, and verifies both", async () => {
    const { client, get, post, patch } = mockClient();
    const noteText = "Scope and document: https://example.invalid/document/123";
    const marker = createNoteMarker(ticket.id, targetStatus.id, noteText);
    const createdNote = {
      id: 91,
      text: `${noteText}\n\n${marker}`,
      internalAnalysisFlag: true,
    };
    get
      .mockResolvedValueOnce(ticket)
      .mockResolvedValueOnce([targetStatus])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ ...ticket, status: targetStatus })
      .mockResolvedValueOnce([createdNote]);
    post.mockResolvedValue(createdNote);
    patch.mockResolvedValue({ status: targetStatus });

    const result = await addInternalNoteAndSetStatus(
      client,
      ticket.id,
      noteText,
      targetStatus.name,
    );

    expect(post).toHaveBeenCalledWith(`/service/tickets/${ticket.id}/notes`, {
      text: `${noteText}\n\n${marker}`,
      internalAnalysisFlag: true,
    });
    expect(patch).toHaveBeenCalledWith(`/service/tickets/${ticket.id}`, [
      { op: "replace", path: "/status/id", value: targetStatus.id },
    ]);
    expect(result).toMatchObject({
      success: true,
      outcome: "completed",
      noteAdded: true,
      noteAlreadyExisted: false,
      noteVerified: true,
      noteId: 91,
      verifiedStatus: targetStatus,
    });
  });

  it("is idempotent across sequential retries with the exact same inputs", async () => {
    const { client, get, post, patch } = mockClient();
    const noteText = "Finalized in ScopeStack";
    const marker = createNoteMarker(ticket.id, targetStatus.id, noteText);
    const notes: Array<Record<string, unknown>> = [];
    let currentStatus = ticket.status;

    get.mockImplementation(async (path: string) => {
      if (path.endsWith("/statuses")) return [targetStatus];
      if (path.endsWith("/notes")) return [...notes];
      return { ...ticket, status: currentStatus };
    });
    post.mockImplementation(async (_path: string, body: unknown) => {
      const created = { id: 92, ...(body as Record<string, unknown>) };
      notes.push(created);
      return created;
    });
    patch.mockImplementation(async () => {
      currentStatus = targetStatus;
      return { status: targetStatus };
    });

    const first = await addInternalNoteAndSetStatus(
      client,
      ticket.id,
      noteText,
      targetStatus.name,
    );
    const second = await addInternalNoteAndSetStatus(
      client,
      ticket.id,
      noteText,
      targetStatus.name,
    );

    expect(notes[0]?.text).toBe(`${noteText}\n\n${marker}`);
    expect(first.outcome).toBe("completed");
    expect(second).toMatchObject({
      success: true,
      outcome: "already_complete",
      noteAdded: false,
      noteAlreadyExisted: true,
      statusUpdateAttempted: false,
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("accepts a legacy exact internal note but not fuzzy or customer-visible text", async () => {
    const { client, get, post, patch } = mockClient();
    const completed = { ...ticket, status: targetStatus };
    const exactText = "Missing site count and required completion date";
    get
      .mockResolvedValueOnce(completed)
      .mockResolvedValueOnce([targetStatus])
      .mockResolvedValueOnce([
        { id: 1, text: `${exactText}.`, internalAnalysisFlag: true },
        { id: 2, text: exactText, internalAnalysisFlag: false },
        { id: 3, text: exactText, internalAnalysisFlag: true },
      ])
      .mockResolvedValueOnce(completed)
      .mockResolvedValueOnce([
        { id: 3, text: exactText, internalAnalysisFlag: true },
      ]);

    const result = await addInternalNoteAndSetStatus(
      client,
      ticket.id,
      exactText,
      targetStatus.name,
    );

    expect(result).toMatchObject({
      success: true,
      outcome: "already_complete",
      noteAlreadyExisted: true,
      noteId: 3,
    });
    expect(post).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("returns partial failure when the note succeeds but status update fails", async () => {
    const { client, get, post, patch } = mockClient();
    const noteText = "Scope is ready";
    const marker = createNoteMarker(ticket.id, targetStatus.id, noteText);
    const createdNote = {
      id: 93,
      text: `${noteText}\n\n${marker}`,
      internalAnalysisFlag: true,
    };
    get
      .mockResolvedValueOnce(ticket)
      .mockResolvedValueOnce([targetStatus])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(ticket)
      .mockResolvedValueOnce([createdNote]);
    post.mockResolvedValue(createdNote);
    patch.mockRejectedValue(new Error("private key and note content must not leak"));

    const result = await addInternalNoteAndSetStatus(
      client,
      ticket.id,
      noteText,
      targetStatus.name,
    );

    expect(result).toMatchObject({
      success: false,
      outcome: "partial_failure",
      noteAdded: true,
      noteVerified: true,
      verifiedStatus: ticket.status,
    });
    expect(result.errors.some((error) => error.code === "STATUS_UPDATE_FAILED")).toBe(
      true,
    );
    expect(JSON.stringify(result)).not.toContain("private key");
    expect(JSON.stringify(result)).not.toContain("note content");
  });

  it("does not change status when note creation fails", async () => {
    const { client, get, post, patch } = mockClient();
    get
      .mockResolvedValueOnce(ticket)
      .mockResolvedValueOnce([targetStatus])
      .mockResolvedValueOnce([]);
    post.mockRejectedValue(new Error("write failed"));

    const result = await addInternalNoteAndSetStatus(
      client,
      ticket.id,
      "Missing rack elevation",
      targetStatus.name,
    );

    expect(result.success).toBe(false);
    expect(result.errors[0]?.code).toBe("NOTE_CREATE_FAILED");
    expect(patch).not.toHaveBeenCalled();
  });

  it("performs no writes when existing notes cannot be inspected", async () => {
    const { client, get, post, patch } = mockClient();
    get
      .mockResolvedValueOnce(ticket)
      .mockResolvedValueOnce([targetStatus])
      .mockRejectedValueOnce(new Error("notes unavailable"));

    const result = await addInternalNoteAndSetStatus(
      client,
      ticket.id,
      "Missing site survey",
      targetStatus.name,
    );

    expect(result.success).toBe(false);
    expect(result.errors[0]?.code).toBe("NOTE_READ_FAILED");
    expect(post).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("returns partial failure when status succeeds but ticket verification fails", async () => {
    const { client, get, post, patch } = mockClient();
    const noteText = "Ready for review";
    const marker = createNoteMarker(ticket.id, targetStatus.id, noteText);
    const createdNote = {
      id: 94,
      text: `${noteText}\n\n${marker}`,
      internalAnalysisFlag: true,
    };
    get
      .mockResolvedValueOnce(ticket)
      .mockResolvedValueOnce([targetStatus])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("verification unavailable"))
      .mockResolvedValueOnce([createdNote]);
    post.mockResolvedValue(createdNote);
    patch.mockResolvedValue({ status: targetStatus });

    const result = await addInternalNoteAndSetStatus(
      client,
      ticket.id,
      noteText,
      targetStatus.name,
    );

    expect(result).toMatchObject({
      success: false,
      outcome: "partial_failure",
      noteVerified: true,
      verifiedStatus: null,
    });
    expect(
      result.errors.some((error) => error.code === "TICKET_VERIFICATION_FAILED"),
    ).toBe(true);
  });

  it("does not report success when the final note read-back lacks the marker", async () => {
    const { client, get, post, patch } = mockClient();
    const noteText = "Ready for review";
    get
      .mockResolvedValueOnce(ticket)
      .mockResolvedValueOnce([targetStatus])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ ...ticket, status: targetStatus })
      .mockResolvedValueOnce([]);
    post.mockResolvedValue({ id: 95 });
    patch.mockResolvedValue({ status: targetStatus });

    const result = await addInternalNoteAndSetStatus(
      client,
      ticket.id,
      noteText,
      targetStatus.name,
    );

    expect(result).toMatchObject({
      success: false,
      outcome: "partial_failure",
      noteVerified: false,
      verifiedStatus: targetStatus,
    });
    expect(
      result.errors.some((error) => error.code === "NOTE_NOT_FOUND_AFTER_WRITE"),
    ).toBe(true);
  });
});
