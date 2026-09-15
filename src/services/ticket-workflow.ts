import { createHash } from "node:crypto";
import { CwManageApiError } from "../api-client.js";

const PAGE_SIZE = 1_000;
const MAX_PAGES = 100;
const NOTE_MARKER_PREFIX = "commtech-cwm-mcp";

export interface TicketWorkflowClient {
  get<T = unknown>(
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<T>;
  post<T = unknown>(path: string, body: unknown): Promise<T>;
  patch<T = unknown>(path: string, body: unknown): Promise<T>;
}

export interface Reference {
  id: number;
  name: string;
}

export type OperationStage =
  | "initial_ticket_read"
  | "status_resolution"
  | "initial_note_read"
  | "note_create"
  | "status_patch"
  | "ticket_verification"
  | "note_verification";

export interface OperationError {
  stage: OperationStage;
  code: string;
  message: string;
  httpStatus?: number;
}

export interface SetTicketStatusResult {
  success: boolean;
  outcome: "updated" | "already_correct" | "failed";
  ticketId: number;
  board: Reference | null;
  previousStatus: Reference | null;
  requestedStatus: string;
  resolvedStatus: Reference | null;
  statusUpdateAttempted: boolean;
  statusChanged: boolean;
  verifiedStatus: Reference | null;
  errors: OperationError[];
}

export interface FinalizeTicketResult {
  success: boolean;
  outcome: "completed" | "already_complete" | "partial_failure" | "failed";
  ticketId: number;
  board: Reference | null;
  noteAdded: boolean;
  noteAlreadyExisted: boolean;
  noteVerified: boolean;
  noteId: number | null;
  previousStatus: Reference | null;
  requestedStatus: string;
  resolvedStatus: Reference | null;
  statusUpdateAttempted: boolean;
  statusChanged: boolean;
  verifiedStatus: Reference | null;
  errors: OperationError[];
}

interface ConnectWiseTicket {
  board?: unknown;
  status?: unknown;
}

interface ConnectWiseStatus {
  id?: unknown;
  name?: unknown;
  inactiveFlag?: unknown;
}

interface ConnectWiseNote {
  id?: unknown;
  text?: unknown;
  internalAnalysisFlag?: unknown;
}

class WorkflowError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toReference(value: unknown): Reference | null {
  if (!isRecord(value) || typeof value.id !== "number") return null;
  const name =
    typeof value.name === "string" && value.name.trim().length > 0
      ? value.name
      : `#${value.id}`;
  return { id: value.id, name };
}

function normalizeStatusName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

export function normalizeNoteText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

export function createNoteMarker(
  ticketId: number,
  statusId: number,
  noteText: string,
): string {
  const fingerprint = createHash("sha256")
    .update(`${ticketId}\n${statusId}\n${normalizeNoteText(noteText)}`)
    .digest("hex");
  return `[${NOTE_MARKER_PREFIX}:${fingerprint}]`;
}

function noteMatches(
  value: ConnectWiseNote,
  marker: string,
  normalizedRequestedText: string,
): boolean {
  if (value.internalAnalysisFlag !== true || typeof value.text !== "string") {
    return false;
  }

  return (
    value.text.includes(marker) ||
    normalizeNoteText(value.text) === normalizedRequestedText
  );
}

function noteId(value: ConnectWiseNote | undefined): number | null {
  return typeof value?.id === "number" ? value.id : null;
}

async function getAllPages<T>(
  client: TicketWorkflowClient,
  path: string,
): Promise<T[]> {
  const results: T[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await client.get<unknown>(path, {
      page,
      pageSize: PAGE_SIZE,
    });
    if (!Array.isArray(response)) {
      throw new WorkflowError(
        "UNEXPECTED_RESPONSE",
        "ConnectWise returned an unexpected non-array collection response.",
      );
    }

    results.push(...(response as T[]));
    if (response.length < PAGE_SIZE) return results;
  }

  throw new WorkflowError(
    "PAGINATION_LIMIT",
    `ConnectWise collection exceeded the safe ${MAX_PAGES * PAGE_SIZE} item limit.`,
  );
}

function safeError(
  stage: OperationStage,
  fallbackCode: string,
  fallbackMessage: string,
  error: unknown,
): OperationError {
  if (error instanceof WorkflowError) {
    return { stage, code: error.code, message: error.message };
  }
  if (error instanceof CwManageApiError) {
    return {
      stage,
      code: fallbackCode,
      message: `ConnectWise API ${error.method} ${error.path} returned HTTP ${error.status} after ${error.attempts} attempt(s).`,
      httpStatus: error.status,
    };
  }
  return { stage, code: fallbackCode, message: fallbackMessage };
}

async function resolveStatus(
  client: TicketWorkflowClient,
  boardId: number,
  requestedStatus: string,
): Promise<Reference> {
  const statuses = await getAllPages<ConnectWiseStatus>(
    client,
    `/service/boards/${boardId}/statuses`,
  );
  const normalizedRequested = normalizeStatusName(requestedStatus);
  const matches = statuses.filter(
    (status) =>
      status.inactiveFlag !== true &&
      typeof status.id === "number" &&
      typeof status.name === "string" &&
      normalizeStatusName(status.name) === normalizedRequested,
  );

  if (matches.length === 0) {
    throw new WorkflowError(
      "STATUS_NOT_FOUND",
      `No active status named "${requestedStatus}" exists on the ticket's service board.`,
    );
  }
  if (matches.length > 1) {
    throw new WorkflowError(
      "STATUS_AMBIGUOUS",
      `More than one active status named "${requestedStatus}" exists on the ticket's service board.`,
    );
  }

  return { id: matches[0].id as number, name: matches[0].name as string };
}

async function patchTicketStatus(
  client: TicketWorkflowClient,
  ticketId: number,
  statusId: number,
): Promise<void> {
  await client.patch(`/service/tickets/${ticketId}`, [
    { op: "replace", path: "/status/id", value: statusId },
  ]);
}

function emptyStatusResult(
  ticketId: number,
  requestedStatus: string,
): SetTicketStatusResult {
  return {
    success: false,
    outcome: "failed",
    ticketId,
    board: null,
    previousStatus: null,
    requestedStatus,
    resolvedStatus: null,
    statusUpdateAttempted: false,
    statusChanged: false,
    verifiedStatus: null,
    errors: [],
  };
}

export async function setTicketStatus(
  client: TicketWorkflowClient,
  ticketId: number,
  statusName: string,
): Promise<SetTicketStatusResult> {
  const requestedStatus = statusName.trim();
  const result = emptyStatusResult(ticketId, requestedStatus);

  let ticket: ConnectWiseTicket;
  try {
    ticket = await client.get<ConnectWiseTicket>(`/service/tickets/${ticketId}`);
  } catch (error: unknown) {
    result.errors.push(
      safeError(
        "initial_ticket_read",
        "TICKET_READ_FAILED",
        "Unable to retrieve the ticket.",
        error,
      ),
    );
    return result;
  }

  result.board = toReference(ticket.board);
  result.previousStatus = toReference(ticket.status);
  if (!result.board) {
    result.errors.push({
      stage: "status_resolution",
      code: "TICKET_BOARD_MISSING",
      message: "The ticket does not contain a valid service board reference.",
    });
    return result;
  }

  try {
    result.resolvedStatus = await resolveStatus(
      client,
      result.board.id,
      requestedStatus,
    );
  } catch (error: unknown) {
    result.errors.push(
      safeError(
        "status_resolution",
        "STATUS_LOOKUP_FAILED",
        "Unable to resolve the requested status on the ticket's service board.",
        error,
      ),
    );
    return result;
  }

  const alreadyCorrect = result.previousStatus?.id === result.resolvedStatus.id;
  if (!alreadyCorrect) {
    result.statusUpdateAttempted = true;
    try {
      await patchTicketStatus(client, ticketId, result.resolvedStatus.id);
    } catch (error: unknown) {
      result.errors.push(
        safeError(
          "status_patch",
          "STATUS_UPDATE_FAILED",
          "ConnectWise did not accept the ticket status update.",
          error,
        ),
      );
    }
  }

  try {
    const verifiedTicket = await client.get<ConnectWiseTicket>(
      `/service/tickets/${ticketId}`,
    );
    result.verifiedStatus = toReference(verifiedTicket.status);
    result.statusChanged =
      !alreadyCorrect && result.verifiedStatus?.id === result.resolvedStatus.id;
    if (result.verifiedStatus?.id !== result.resolvedStatus.id) {
      result.errors.push({
        stage: "ticket_verification",
        code: "STATUS_MISMATCH",
        message: "Ticket read-back did not contain the resolved target status.",
      });
    }
  } catch (error: unknown) {
    result.errors.push(
      safeError(
        "ticket_verification",
        "TICKET_VERIFICATION_FAILED",
        "Unable to retrieve the ticket after the status operation.",
        error,
      ),
    );
  }

  result.success =
    result.errors.length === 0 &&
    result.verifiedStatus?.id === result.resolvedStatus.id;
  if (result.success) {
    result.outcome = alreadyCorrect ? "already_correct" : "updated";
  }
  return result;
}

function emptyFinalizeResult(
  ticketId: number,
  requestedStatus: string,
): FinalizeTicketResult {
  return {
    success: false,
    outcome: "failed",
    ticketId,
    board: null,
    noteAdded: false,
    noteAlreadyExisted: false,
    noteVerified: false,
    noteId: null,
    previousStatus: null,
    requestedStatus,
    resolvedStatus: null,
    statusUpdateAttempted: false,
    statusChanged: false,
    verifiedStatus: null,
    errors: [],
  };
}

export async function addInternalNoteAndSetStatus(
  client: TicketWorkflowClient,
  ticketId: number,
  internalNote: string,
  statusName: string,
): Promise<FinalizeTicketResult> {
  const requestedStatus = statusName.trim();
  const normalizedNote = normalizeNoteText(internalNote);
  const result = emptyFinalizeResult(ticketId, requestedStatus);

  let ticket: ConnectWiseTicket;
  try {
    ticket = await client.get<ConnectWiseTicket>(`/service/tickets/${ticketId}`);
  } catch (error: unknown) {
    result.errors.push(
      safeError(
        "initial_ticket_read",
        "TICKET_READ_FAILED",
        "Unable to retrieve the ticket.",
        error,
      ),
    );
    return result;
  }

  result.board = toReference(ticket.board);
  result.previousStatus = toReference(ticket.status);
  if (!result.board) {
    result.errors.push({
      stage: "status_resolution",
      code: "TICKET_BOARD_MISSING",
      message: "The ticket does not contain a valid service board reference.",
    });
    return result;
  }

  try {
    result.resolvedStatus = await resolveStatus(
      client,
      result.board.id,
      requestedStatus,
    );
  } catch (error: unknown) {
    result.errors.push(
      safeError(
        "status_resolution",
        "STATUS_LOOKUP_FAILED",
        "Unable to resolve the requested status on the ticket's service board.",
        error,
      ),
    );
    return result;
  }

  const marker = createNoteMarker(ticketId, result.resolvedStatus.id, normalizedNote);
  let existingNote: ConnectWiseNote | undefined;
  try {
    const notes = await getAllPages<ConnectWiseNote>(
      client,
      `/service/tickets/${ticketId}/notes`,
    );
    existingNote = notes.find((note) => noteMatches(note, marker, normalizedNote));
  } catch (error: unknown) {
    result.errors.push(
      safeError(
        "initial_note_read",
        "NOTE_READ_FAILED",
        "Unable to inspect existing internal notes safely.",
        error,
      ),
    );
    return result;
  }

  if (existingNote) {
    result.noteAlreadyExisted = true;
    result.noteId = noteId(existingNote);
  } else {
    try {
      const createdNote = await client.post<ConnectWiseNote>(
        `/service/tickets/${ticketId}/notes`,
        {
          text: `${normalizedNote}\n\n${marker}`,
          internalAnalysisFlag: true,
        },
      );
      result.noteAdded = true;
      result.noteId = noteId(createdNote);
    } catch (error: unknown) {
      result.errors.push(
        safeError(
          "note_create",
          "NOTE_CREATE_FAILED",
          "ConnectWise did not accept the internal note.",
          error,
        ),
      );
      return result;
    }
  }

  const statusAlreadyCorrect =
    result.previousStatus?.id === result.resolvedStatus.id;
  if (!statusAlreadyCorrect) {
    result.statusUpdateAttempted = true;
    try {
      await patchTicketStatus(client, ticketId, result.resolvedStatus.id);
    } catch (error: unknown) {
      result.errors.push(
        safeError(
          "status_patch",
          "STATUS_UPDATE_FAILED",
          "ConnectWise did not accept the ticket status update.",
          error,
        ),
      );
    }
  }

  try {
    const verifiedTicket = await client.get<ConnectWiseTicket>(
      `/service/tickets/${ticketId}`,
    );
    result.verifiedStatus = toReference(verifiedTicket.status);
    result.statusChanged =
      !statusAlreadyCorrect &&
      result.verifiedStatus?.id === result.resolvedStatus.id;
    if (result.verifiedStatus?.id !== result.resolvedStatus.id) {
      result.errors.push({
        stage: "ticket_verification",
        code: "STATUS_MISMATCH",
        message: "Ticket read-back did not contain the resolved target status.",
      });
    }
  } catch (error: unknown) {
    result.errors.push(
      safeError(
        "ticket_verification",
        "TICKET_VERIFICATION_FAILED",
        "Unable to retrieve the ticket after the finalization operation.",
        error,
      ),
    );
  }

  try {
    const verifiedNotes = await getAllPages<ConnectWiseNote>(
      client,
      `/service/tickets/${ticketId}/notes`,
    );
    const verifiedNote = verifiedNotes.find((note) =>
      noteMatches(note, marker, normalizedNote),
    );
    result.noteVerified = verifiedNote !== undefined;
    if (verifiedNote && result.noteId === null) result.noteId = noteId(verifiedNote);
    if (!verifiedNote) {
      result.errors.push({
        stage: "note_verification",
        code: "NOTE_NOT_FOUND_AFTER_WRITE",
        message: "Internal note read-back did not contain the expected note marker.",
      });
    }
  } catch (error: unknown) {
    result.errors.push(
      safeError(
        "note_verification",
        "NOTE_VERIFICATION_FAILED",
        "Unable to retrieve ticket notes after the finalization operation.",
        error,
      ),
    );
  }

  const statusVerified =
    result.verifiedStatus?.id === result.resolvedStatus.id;
  result.success =
    result.errors.length === 0 && result.noteVerified && statusVerified;
  if (result.success) {
    result.outcome =
      result.noteAlreadyExisted && statusAlreadyCorrect
        ? "already_complete"
        : "completed";
  } else if (result.noteVerified || statusVerified) {
    result.outcome = "partial_failure";
  }

  return result;
}
