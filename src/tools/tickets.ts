import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";
import { buildTicketCard, TICKET_CARD_META } from "../card.builder.js";
import {
  addInternalNoteAndSetStatus,
  setTicketStatus,
} from "../services/ticket-workflow.js";

const referenceSchema = z.object({
  id: z.number().int(),
  name: z.string(),
});

const operationErrorSchema = z.object({
  stage: z.enum([
    "initial_ticket_read",
    "status_resolution",
    "initial_note_read",
    "note_create",
    "status_patch",
    "ticket_verification",
    "note_verification",
  ]),
  code: z.string(),
  message: z.string(),
  httpStatus: z.number().int().optional(),
});

function structuredToolResult(result: Record<string, unknown> & { success: boolean }) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: !result.success,
  };
}

export function registerTicketTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_search_tickets",
    "Search service tickets in ConnectWise Manage. Use 'conditions' for CW query syntax (e.g. \"status/name != 'Closed'\" or \"company/name = 'Acme'\").",
    {
      conditions: z
        .string()
        .optional()
        .describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z
        .number()
        .optional()
        .describe("Results per page (default: 25, max: 1000)"),
      orderBy: z
        .string()
        .optional()
        .describe("Field to order by (e.g. 'id desc')"),
    },
    async ({ conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/service/tickets", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "cw_get_ticket",
    {
      description: "Get a specific service ticket by ID.",
      inputSchema: {
        id: z.number().describe("Ticket ID"),
      },
      // MCP Apps (SEP-1865): renders as an interactive ticket card in App hosts.
      _meta: TICKET_CARD_META,
    },
    async ({ id }) => {
      const result = await client.get<Record<string, unknown>>(`/service/tickets/${id}`);
      // MCP Apps: attach the normalized card payload the ui:// ticket card
      // renders from. Best-effort — a null card just means no UI surface.
      const card = await buildTicketCard(result, client);
      const payload = card ? { ...result, _card: card } : result;
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    },
  );

  server.tool(
    "cw_create_ticket",
    "Create a new service ticket.",
    {
      summary: z.string().describe("Ticket summary/title"),
      boardId: z.number().optional().describe("Service board ID"),
      companyId: z.number().optional().describe("Company ID to associate"),
      contactId: z.number().optional().describe("Contact ID to associate"),
      statusId: z.number().optional().describe("Status ID"),
      priorityId: z.number().optional().describe("Priority ID"),
      typeId: z.number().optional().describe("Type ID"),
      subTypeId: z.number().optional().describe("SubType ID"),
      initialDescription: z.string().optional().describe("Initial ticket description"),
    },
    async ({ summary, boardId, companyId, contactId, statusId, priorityId, typeId, subTypeId, initialDescription }) => {
      const body: Record<string, unknown> = { summary };
      if (boardId) body.board = { id: boardId };
      if (companyId) body.company = { id: companyId };
      if (contactId) body.contact = { id: contactId };
      if (statusId) body.status = { id: statusId };
      if (priorityId) body.priority = { id: priorityId };
      if (typeId) body.type = { id: typeId };
      if (subTypeId) body.subType = { id: subTypeId };
      if (initialDescription) body.initialDescription = initialDescription;

      const result = await client.post("/service/tickets", body);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_update_ticket",
    "Update an existing service ticket using JSON Patch operations. For status-only changes, prefer cw_set_ticket_status so the server resolves and verifies the board-specific status without client-supplied patch fields.",
    {
      id: z.number().describe("Ticket ID"),
      operations: z
        .array(
          z.object({
            op: z.enum(["replace", "add", "remove"]).describe("Patch operation"),
            path: z.string().describe("JSON path (e.g. 'status/id', 'summary')"),
            value: z.unknown().optional().describe("New value"),
          }),
        )
        .describe("Array of JSON Patch operations"),
    },
    async ({ id, operations }) => {
      const result = await client.patch(`/service/tickets/${id}`, operations);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "cw_set_ticket_status",
    {
      title: "Set ConnectWise ticket status",
      description:
        "Preferred tool for status-only ticket changes. Resolves one exact active status on the ticket's current service board, constructs the JSON Patch internally, and reads the ticket back to verify the resulting status.",
      inputSchema: {
        ticketId: z.number().int().positive().describe("Ticket ID"),
        statusName: z
          .string()
          .trim()
          .min(1)
          .describe("Exact status name on the ticket's current service board"),
      },
      outputSchema: {
        success: z.boolean(),
        outcome: z.enum(["updated", "already_correct", "failed"]),
        ticketId: z.number().int(),
        board: referenceSchema.nullable(),
        previousStatus: referenceSchema.nullable(),
        requestedStatus: z.string(),
        resolvedStatus: referenceSchema.nullable(),
        statusUpdateAttempted: z.boolean(),
        statusChanged: z.boolean(),
        verifiedStatus: referenceSchema.nullable(),
        errors: z.array(operationErrorSchema),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ ticketId, statusName }) => {
      const result = await setTicketStatus(client, ticketId, statusName);
      return structuredToolResult(result as unknown as Record<string, unknown> & { success: boolean });
    },
  );

  server.registerTool(
    "cw_add_internal_note_and_set_status",
    {
      title: "Add internal note and set ConnectWise ticket status",
      description:
        "Preferred unattended finalization tool. Idempotently adds one internal-only note, resolves one exact active status on the ticket's current service board, updates the status, and reads both ticket and notes back before reporting success.",
      inputSchema: {
        ticketId: z.number().int().positive().describe("Ticket ID"),
        internalNote: z
          .string()
          .refine((value) => value.trim().length > 0, "Internal note must not be blank")
          .describe("Internal-only ticket note; formatting is preserved"),
        statusName: z
          .string()
          .trim()
          .min(1)
          .describe("Exact status name on the ticket's current service board"),
      },
      outputSchema: {
        success: z.boolean(),
        outcome: z.enum([
          "completed",
          "already_complete",
          "partial_failure",
          "failed",
        ]),
        ticketId: z.number().int(),
        board: referenceSchema.nullable(),
        noteAdded: z.boolean(),
        noteAlreadyExisted: z.boolean(),
        noteVerified: z.boolean(),
        noteId: z.number().int().nullable(),
        previousStatus: referenceSchema.nullable(),
        requestedStatus: z.string(),
        resolvedStatus: referenceSchema.nullable(),
        statusUpdateAttempted: z.boolean(),
        statusChanged: z.boolean(),
        verifiedStatus: referenceSchema.nullable(),
        errors: z.array(operationErrorSchema),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ ticketId, internalNote, statusName }) => {
      const result = await addInternalNoteAndSetStatus(
        client,
        ticketId,
        internalNote,
        statusName,
      );
      return structuredToolResult(result as unknown as Record<string, unknown> & { success: boolean });
    },
  );

  server.tool(
    "cw_get_ticket_notes",
    "Get all notes/discussions on a service ticket, including notes from any child tickets.",
    {
      id: z.number().describe("Ticket ID"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
    },
    async ({ id, page, pageSize }) => {
      try {
        const result = await client.get(`/service/tickets/${id}/allNotes`, {
          page: page ?? 1,
          pageSize: pageSize ?? 25,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("404") || msg.includes("405")) {
          // allNotes not supported on this CWM version — fall back to /notes
          const result = await client.get(`/service/tickets/${id}/notes`, {
            page: page ?? 1,
            pageSize: pageSize ?? 25,
          });
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        throw err;
      }
    },
  );

  server.registerTool(
    "cw_add_ticket_note",
    {
      description:
        "Add a note to a service ticket. Use detailDescriptionFlag for a description note, internalAnalysisFlag for an internal-only note, or resolutionFlag for a resolution note. Defaults to a plain discussion note visible to the customer.",
      inputSchema: {
        id: z.number().describe("Ticket ID"),
        text: z.string().describe("Note text content"),
        detailDescriptionFlag: z.boolean().optional().describe("Add as detail description (default: false)"),
        internalAnalysisFlag: z.boolean().optional().describe("Mark as internal analysis only (default: false)"),
        resolutionFlag: z.boolean().optional().describe("Mark as resolution note (default: false)"),
        customerUpdatedFlag: z.boolean().optional().describe("Flag that the customer was updated (default: false)"),
      },
      // MCP Apps (SEP-1865): the ticket card's "Add note" round-trip target.
      _meta: TICKET_CARD_META,
    },
    async ({ id, text, detailDescriptionFlag, internalAnalysisFlag, resolutionFlag, customerUpdatedFlag }) => {
      const body: Record<string, unknown> = { text };
      if (detailDescriptionFlag !== undefined) body.detailDescriptionFlag = detailDescriptionFlag;
      if (internalAnalysisFlag !== undefined) body.internalAnalysisFlag = internalAnalysisFlag;
      if (resolutionFlag !== undefined) body.resolutionFlag = resolutionFlag;
      if (customerUpdatedFlag !== undefined) body.customerUpdatedFlag = customerUpdatedFlag;

      const result = await client.post(`/service/tickets/${id}/notes`, body);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
