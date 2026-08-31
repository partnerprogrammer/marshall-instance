// ClickUp MCP server for Marshall (CUP-4776, plan Phase 1.2).
//
// Zero-dependency stdio MCP server, run inside the agent container as
// `bun run /workspace/extra/clickup-mcp/server.ts`. Speaks newline-delimited
// JSON-RPC 2.0 (the MCP stdio transport).
//
// Auth: none here, on purpose. The container's outbound HTTPS goes through the
// OneCLI gateway (HTTPS_PROXY + SSL_CERT_FILE are container-wide), which
// injects Marshall's ClickUp token in transit. Requests leave this process
// with no Authorization header and arrive at api.clickup.com authenticated.
//
// Read tools ship enabled. Write tools exist but are hidden unless
// CLICKUP_MCP_ENABLE_WRITES=1 (plan Phase 2.3 flips that flag).

const TEAM_ID = process.env.CLICKUP_TEAM_ID ?? "2385794";
const API_V2 = "https://api.clickup.com/api/v2";
const API_V3 = "https://api.clickup.com/api/v3";
// PP's Slack workspace team id — public identifier, not a secret, static
// per workspace (same treatment as CLICKUP_TEAM_ID above).
const SLACK_TEAM_ID = process.env.SLACK_TEAM_ID ?? "TB439AUSH";
const WRITES_ENABLED = process.env.CLICKUP_MCP_ENABLE_WRITES === "1";
// Filing is a narrower grant than generic writes: the client-intake group gets
// file_client_request only, never create_task/update_status/assign.
const FILING_ENABLED = WRITES_ENABLED || process.env.CLICKUP_MCP_ENABLE_FILING === "1";
const MAX_DESCRIPTION_CHARS = 4000;
const MAX_SEARCH_RESULTS = 20;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type FetchImpl = typeof fetch;

const HINTS: Record<number, string> = {
  401: "Gateway did not authenticate this call — is the ClickUp secret configured in the OneCLI vault (raw pk_ token, no Bearer prefix)?",
  404: "Not found — check the id. Custom ids (CUP-xxx) only resolve with custom_task_ids=true&team_id, which get_task already sends.",
  429: "Rate limited by ClickUp — wait a minute and retry.",
};

export async function clickupFetch(
  url: string,
  init: RequestInit | undefined,
  fetchImpl: FetchImpl
): Promise<unknown> {
  const res = await fetchImpl(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.text();
  if (!res.ok) {
    const hint = HINTS[res.status] ?? (res.status >= 500 ? "ClickUp server error — retry shortly." : "");
    throw new Error(`ClickUp API ${res.status} on ${url}: ${body.slice(0, 300)}${hint ? ` — ${hint}` : ""}`);
  }
  return body ? JSON.parse(body) : {};
}

// ---------------------------------------------------------------------------
// Formatting helpers (ported from pp-stack tools/clickup: breadcrumb + task)
// ---------------------------------------------------------------------------

interface AnyTask {
  id: string;
  custom_id?: string | null;
  name: string;
  status?: { status: string };
  url?: string;
  parent?: string | null;
  due_date?: string | null;
  priority?: { priority: string } | null;
  assignees?: Array<{ username?: string; email?: string }>;
  list?: { name?: string };
  markdown_description?: string | null;
  description?: string | null;
  subtasks?: AnyTask[];
}

export function displayTaskId(task: AnyTask): string {
  return task.custom_id || task.id;
}

export function formatDue(ms: string | null | undefined): string {
  if (!ms) return "none";
  const d = new Date(Number(ms));
  return isNaN(d.getTime()) ? "none" : d.toISOString().slice(0, 10);
}

export function formatTask(task: AnyTask): string {
  const lines: string[] = [];
  const crumb = [displayTaskId(task), task.list?.name, task.name].filter(Boolean).join(" > ");
  lines.push(`[${task.status?.status ?? "?"}] ${crumb}`);
  const assignees = (task.assignees ?? []).map((a) => a.username ?? a.email ?? "?").join(", ") || "unassigned";
  lines.push(`assignees: ${assignees} | due: ${formatDue(task.due_date)} | priority: ${task.priority?.priority ?? "none"}`);
  if (task.url) lines.push(task.url);
  const desc = task.markdown_description ?? task.description;
  if (desc) {
    lines.push("");
    lines.push(desc.length > MAX_DESCRIPTION_CHARS ? `${desc.slice(0, MAX_DESCRIPTION_CHARS)}\n… [truncated]` : desc);
  }
  if (task.subtasks?.length) {
    lines.push("");
    lines.push("subtasks:");
    for (const st of task.subtasks) {
      lines.push(`- [${st.status?.status ?? "?"}] ${displayTaskId(st)} ${st.name}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

const CUSTOM_ID_PARAMS = `custom_task_ids=true&team_id=${TEAM_ID}`;

export async function getTask(args: { task_id: string }, f: FetchImpl): Promise<string> {
  const id = encodeURIComponent(args.task_id.trim());
  const task = (await clickupFetch(
    `${API_V2}/task/${id}?${CUSTOM_ID_PARAMS}&include_subtasks=true&include_markdown_description=true`,
    undefined,
    f
  )) as AnyTask;
  return formatTask(task);
}

export async function searchTasks(args: { query: string }, f: FetchImpl): Promise<string> {
  const data = (await clickupFetch(
    `${API_V2}/team/${TEAM_ID}/task?name=${encodeURIComponent(args.query)}&include_closed=true`,
    undefined,
    f
  )) as { tasks: AnyTask[] };
  if (!data.tasks?.length) return `No tasks matched "${args.query}" (server-side name match only).`;
  return data.tasks
    .slice(0, MAX_SEARCH_RESULTS)
    .map((t) => `[${t.status?.status ?? "?"}] ${displayTaskId(t)} ${[t.list?.name, t.name].filter(Boolean).join(" > ")}\n  ${t.url ?? ""}`)
    .join("\n");
}

export async function listStructure(_args: Record<never, never>, f: FetchImpl): Promise<string> {
  const { spaces } = (await clickupFetch(`${API_V2}/team/${TEAM_ID}/space`, undefined, f)) as {
    spaces: Array<{ id: string; name: string }>;
  };
  const out: string[] = [];
  for (const space of spaces) {
    out.push(`space: ${space.name} (${space.id})`);
    const { folders } = (await clickupFetch(`${API_V2}/space/${space.id}/folder`, undefined, f)) as {
      folders: Array<{ id: string; name: string; lists: Array<{ id: string; name: string }> }>;
    };
    const { lists: folderless } = (await clickupFetch(`${API_V2}/space/${space.id}/list`, undefined, f)) as {
      lists: Array<{ id: string; name: string }>;
    };
    const allLists: Array<{ id: string; name: string; folder?: string }> = [
      ...folders.flatMap((fo) => fo.lists.map((l) => ({ ...l, folder: fo.name }))),
      ...folderless,
    ];
    for (const list of allLists) {
      // The list description ("content") is the team's routing rule — worth one call each.
      let description = "";
      try {
        const detail = (await clickupFetch(`${API_V2}/list/${list.id}`, undefined, f)) as { content?: string };
        description = detail.content?.trim() ?? "";
      } catch {
        // description is best-effort; the list itself still gets reported
      }
      out.push(`  list: ${list.name} (${list.id})${list.folder ? ` [folder: ${list.folder}]` : ""}`);
      if (description) out.push(`    ${description.split("\n")[0].slice(0, 200)}`);
    }
  }
  return out.join("\n");
}

export async function getDocPage(args: { doc_id: string; page_id?: string }, f: FetchImpl): Promise<string> {
  const pages = (await clickupFetch(
    `${API_V3}/workspaces/${TEAM_ID}/docs/${encodeURIComponent(args.doc_id)}/pages?content_format=text/md`,
    undefined,
    f
  )) as Array<{ id: string; name?: string; content?: string; pages?: unknown }> | { pages: Array<{ id: string; name?: string; content?: string }> };
  const flat: Array<{ id: string; name?: string; content?: string }> = [];
  const walk = (nodes: unknown) => {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes as Array<{ id: string; name?: string; content?: string; pages?: unknown }>) {
      flat.push({ id: n.id, name: n.name, content: n.content });
      walk(n.pages);
    }
  };
  walk(Array.isArray(pages) ? pages : (pages as { pages: unknown }).pages);
  if (args.page_id) {
    const page = flat.find((p) => p.id === args.page_id);
    if (!page) return `Page ${args.page_id} not found in doc ${args.doc_id}. Available: ${flat.map((p) => `${p.id} (${p.name ?? "?"})`).join(", ")}`;
    return `# ${page.name ?? page.id}\n\n${page.content ?? "(empty)"}`;
  }
  return flat.map((p) => `${p.id}  ${p.name ?? "?"}${p.content ? ` — ${p.content.length} chars` : ""}`).join("\n");
}

// --- Client-intake filing (Phase 2.1/2.3, ported from marshall-cli triage.ts) --
// The gate and the task shape are process guarantees — they live here in code,
// never in prompts (lesson from incident CUP-4702).

const MARSHALL_USER_ID = Number(process.env.CLICKUP_MARSHALL_USER_ID ?? "87419960");
const PM_USER_ID = Number(process.env.CLICKUP_PM_USER_ID ?? "6351523");
const PROBLEM_TASK_TYPE_ID = 1011;
const INBOUND_DB_PATH = process.env.MARSHALL_INBOUND_DB_PATH ?? "/workspace/inbound.db";

export type GateDecision = "auto_approved" | "pm_approval";

export function decideGate(complexity: string, impact: string): GateDecision {
  return complexity === "simple" && impact === "low" ? "auto_approved" : "pm_approval";
}

// --- Origin conversation link -----------------------------------------------
// The model is never told platform_id/channel_type/thread_id — NanoClaw's
// formatter strips routing fields from what the agent sees by design
// (container/agent-runner/src/formatter.ts). So the origin link can't be a
// model-supplied field; it has to be resolved here, in code, from the
// session's own inbound.db (mounted read-only at /workspace/inbound.db —
// the same file the agent-runner reads inbound messages from). No new
// credential surface: this is a local file read, not a Slack API call.

export function buildSlackPermalink(platformId: string, threadId: string, teamId: string): string | null {
  // platform_id: "slack:C0XXXXXXX" | thread_id: "slack:C0XXXXXXX:1234567890.123456"
  const chanMatch = /^slack:([A-Z0-9]+)$/.exec(platformId);
  const threadMatch = /^slack:[A-Z0-9]+:(\d+\.\d+)$/.exec(threadId);
  if (!chanMatch || !threadMatch) return null;
  const channel = chanMatch[1];
  const ts = threadMatch[1];
  return `https://app.slack.com/client/${teamId}/${channel}/thread/${channel}-${ts}`;
}

export async function resolveOriginPermalink(dbPath: string = INBOUND_DB_PATH): Promise<string | null> {
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .query(
          "SELECT platform_id, thread_id FROM messages_in WHERE channel_type = 'slack' AND platform_id IS NOT NULL AND thread_id IS NOT NULL ORDER BY seq DESC LIMIT 1"
        )
        .get() as { platform_id: string; thread_id: string } | null;
      if (!row) return null;
      return buildSlackPermalink(row.platform_id, row.thread_id, SLACK_TEAM_ID);
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`[clickup-mcp] origin permalink resolution failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export interface ClientRequestInput {
  kind: "bug" | "feature";
  title: string;
  summary: string;
  given?: string;
  when?: string;
  then?: string;
  complexity: "simple" | "complex";
  impact: "low" | "high";
  assessment: string;
  list_id: string;
}

export function buildTaskDescription(input: ClientRequestInput, originPermalink: string | null): string {
  const sections: string[] = [];
  sections.push(`**Reported via Marshall (Slack client support)**`);
  sections.push(input.summary);
  if (input.kind === "bug" && (input.given || input.when || input.then)) {
    sections.push(
      [
        "**Given**",
        input.given ?? "_not established_",
        "",
        "**When**",
        input.when ?? "_not established_",
        "",
        "**Then**",
        input.then ?? "_not established_",
      ].join("\n")
    );
  }
  const gate = decideGate(input.complexity, input.impact);
  sections.push(
    [
      "**Marshall — triage assessment**",
      `- Complexity: ${input.complexity} · Impact: ${input.impact}`,
      gate === "auto_approved"
        ? "- Gate: auto-approved (simple + low risk) — queued for execution"
        : "- Gate: awaiting PM approval",
      `- Assessment: ${input.assessment}`,
    ].join("\n")
  );
  sections.push(`**Origin conversation**\n${originPermalink ?? "_could not be resolved — check the client channel directly_"}`);
  return sections.join("\n\n");
}

export async function fileClientRequest(args: ClientRequestInput, f: FetchImpl): Promise<string> {
  const listId = args.list_id || process.env.CLICKUP_INTAKE_LIST_ID;
  if (!listId) {
    throw new Error("No target list: pass list_id or configure CLICKUP_INTAKE_LIST_ID on the MCP server registration.");
  }
  const gate = decideGate(args.complexity, args.impact);
  const originPermalink = await resolveOriginPermalink();
  const body: Record<string, unknown> = {
    name: args.title,
    markdown_description: buildTaskDescription(args, originPermalink),
    status: gate === "auto_approved" ? "todo" : "inbox",
    assignees: [gate === "auto_approved" ? MARSHALL_USER_ID : PM_USER_ID],
  };
  if (args.kind === "bug") body.custom_item_id = PROBLEM_TASK_TYPE_ID;
  const task = (await clickupFetch(`${API_V2}/list/${listId}/task`, { method: "POST", body: JSON.stringify(body) }, f)) as AnyTask;
  return [
    `gate: ${gate}`,
    `filed: ${displayTaskId(task)} "${task.name}" (${gate === "auto_approved" ? "todo, assigned to Marshall" : "inbox, assigned to the PM"})`,
    task.url ?? "",
    gate === "auto_approved"
      ? `Tell the client: "we're on it, I'll keep you posted here."`
      : `Tell the client: "I've passed this to the team, I'll update you here." The PM has the task in their inbox.`,
    `NEVER mention ClickUp, tasks, tickets, IDs, or internal tooling to the client.`,
  ].join("\n");
}

// --- Client-reply review (Phase 2.2) ----------------------------------------
// A deterministic scan the client persona is instructed to run on every draft
// before sending it — same regexes marshall-cli's sanitizeClientReply used.
// This is a review step the model chooses to call, NOT a delivery-path
// interceptor: by design (CUP-4776 decision 2026-08-21) we're not patching
// NanoClaw core to force this on every outbound message. The trade-off is
// explicit — this catches a draft only if the model runs it, same class of
// guarantee as the "never mention ClickUp" persona rule itself, just
// deterministic about WHAT counts as a leak rather than relying on the
// model's own judgment call.

const CLICKUP_URL_PATTERN = /https?:\/\/(?:app\.)?clickup\.com\/\S*/gi;
const CUP_ID_PATTERN = /\bCUP-\d+\b/g;
const RAW_TASK_ID_PATTERN = /\b868[a-z0-9]{6,}\b/g;

export interface ReviewResult {
  text: string;
  clean: boolean;
  redactions: number;
}

export function reviewClientReplyText(text: string): ReviewResult {
  let redactions = 0;
  const count = (m: RegExpMatchArray | null) => (m ? m.length : 0);
  redactions += count(text.match(CLICKUP_URL_PATTERN));
  redactions += count(text.match(CUP_ID_PATTERN));
  redactions += count(text.match(RAW_TASK_ID_PATTERN));
  const cleaned = text
    .replace(CLICKUP_URL_PATTERN, "[link removed]")
    .replace(CUP_ID_PATTERN, "your request")
    .replace(RAW_TASK_ID_PATTERN, "your request");
  return { text: cleaned, clean: redactions === 0, redactions };
}

export async function reviewClientReply(args: { draft: string }, _f: FetchImpl): Promise<string> {
  const { text, clean, redactions } = reviewClientReplyText(args.draft);
  if (clean) return "clean — send the draft as-is.";
  return [
    `FLAGGED — ${redactions} internal reference(s) found in the draft. Do not send the original.`,
    "Send this instead (already redacted, but rewrite naturally rather than pasting it verbatim):",
    text,
  ].join("\n");
}

// --- Write tools (hidden unless CLICKUP_MCP_ENABLE_WRITES=1) ----------------

export async function createTask(
  args: { list_id: string; name: string; description_md?: string; parent?: string; status?: string; assignee_ids?: number[] },
  f: FetchImpl
): Promise<string> {
  const body: Record<string, unknown> = { name: args.name };
  if (args.description_md) body.markdown_description = args.description_md;
  if (args.parent) body.parent = args.parent;
  if (args.status) body.status = args.status;
  if (args.assignee_ids?.length) body.assignees = args.assignee_ids;
  const task = (await clickupFetch(`${API_V2}/list/${args.list_id}/task`, { method: "POST", body: JSON.stringify(body) }, f)) as AnyTask;
  return `Created ${displayTaskId(task)}: ${task.name}\n${task.url ?? ""}`;
}

export async function updateStatus(args: { task_id: string; status: string }, f: FetchImpl): Promise<string> {
  const id = encodeURIComponent(args.task_id.trim());
  const task = (await clickupFetch(
    `${API_V2}/task/${id}?${CUSTOM_ID_PARAMS}`,
    { method: "PUT", body: JSON.stringify({ status: args.status }) },
    f
  )) as AnyTask;
  return `${displayTaskId(task)} → ${task.status?.status}`;
}

export async function assignTask(args: { task_id: string; assignee_ids: number[] }, f: FetchImpl): Promise<string> {
  const id = encodeURIComponent(args.task_id.trim());
  const task = (await clickupFetch(
    `${API_V2}/task/${id}?${CUSTOM_ID_PARAMS}`,
    { method: "PUT", body: JSON.stringify({ assignees: { add: args.assignee_ids, rem: [] } }) },
    f
  )) as AnyTask;
  return `${displayTaskId(task)} assignees updated.`;
}

export async function appendDescription(args: { task_id: string; text_md: string }, f: FetchImpl): Promise<string> {
  const id = encodeURIComponent(args.task_id.trim());
  const current = (await clickupFetch(
    `${API_V2}/task/${id}?${CUSTOM_ID_PARAMS}&include_markdown_description=true`,
    undefined,
    f
  )) as AnyTask;
  const existing = current.markdown_description ?? current.description ?? "";
  const updated = existing ? `${existing}\n\n---\n${args.text_md}` : args.text_md;
  await clickupFetch(
    `${API_V2}/task/${id}?${CUSTOM_ID_PARAMS}`,
    { method: "PUT", body: JSON.stringify({ markdown_description: updated }) },
    f
  );
  return `${displayTaskId(current)} description appended (${args.text_md.length} chars).`;
}

export async function rewriteDescription(args: { task_id: string; markdown: string }, f: FetchImpl): Promise<string> {
  const id = encodeURIComponent(args.task_id.trim());
  const current = (await clickupFetch(`${API_V2}/task/${id}?${CUSTOM_ID_PARAMS}`, undefined, f)) as AnyTask & {
    creator?: { id: number };
  };
  // The append-only rule exists to protect HUMAN-authored rich descriptions
  // (a rewrite flattens their formatting and erases their words). A story
  // Marshall himself drafted has neither problem — redrafts (SOP reformats,
  // superseded scope) should replace the text, not stack below it (the
  // CUP-4987 draft-below-draft mess, 2026-08-29, is exactly this gap).
  if (current.creator?.id !== MARSHALL_USER_ID) {
    throw new Error(
      `Refusing to rewrite: ${displayTaskId(current)} was created by user ${current.creator?.id ?? "unknown"}, not Marshall. Human-authored descriptions are never rewritten — use append_description or a comment instead.`
    );
  }
  await clickupFetch(
    `${API_V2}/task/${id}?${CUSTOM_ID_PARAMS}`,
    { method: "PUT", body: JSON.stringify({ markdown_description: args.markdown }) },
    f
  );
  return `${displayTaskId(current)} description REWRITTEN (${args.markdown.length} chars) — previous content replaced.`;
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: never, f: FetchImpl) => Promise<string>;
  write?: boolean;
  filing?: boolean;
}

function toolEnabled(def: ToolDef): boolean {
  if (def.filing) return FILING_ENABLED;
  if (def.write) return WRITES_ENABLED;
  return true;
}

export const TOOLS: Record<string, ToolDef> = {
  get_task: {
    description:
      "Fetch a ClickUp task by id (custom ids like CUP-4776 or internal 868… ids both work). Returns status, assignees, due date, url, markdown description, and subtasks.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string", description: "Task id — CUP-xxx custom id or internal id" } },
      required: ["task_id"],
    },
    handler: getTask,
  },
  search_tasks: {
    description: "Search ClickUp tasks by name (server-side name match, includes closed). Returns up to 20 matches with status, id, list, and url.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Text to match against task names" } },
      required: ["query"],
    },
    handler: searchTasks,
  },
  list_structure: {
    description: "List the ClickUp workspace structure: spaces, folders, and lists with ids and each list's description (the team's routing rule for what belongs there).",
    inputSchema: { type: "object", properties: {} },
    handler: listStructure,
  },
  get_doc_page: {
    description: "Read a ClickUp Doc. Without page_id: lists the doc's pages (id, name, size). With page_id: returns that page's markdown content.",
    inputSchema: {
      type: "object",
      properties: {
        doc_id: { type: "string", description: "Doc id, e.g. 28tw2-10671" },
        page_id: { type: "string", description: "Optional page id, e.g. 28tw2-3251" },
      },
      required: ["doc_id"],
    },
    handler: getDocPage,
  },
  create_task: {
    description: "Create a ClickUp task in a list. Requires human approval per Marshall's autonomy rules.",
    inputSchema: {
      type: "object",
      properties: {
        list_id: { type: "string" },
        name: { type: "string" },
        description_md: { type: "string", description: "Markdown description" },
        parent: { type: "string", description: "Parent task id to create a subtask" },
        status: { type: "string" },
        assignee_ids: { type: "array", items: { type: "number" } },
      },
      required: ["list_id", "name"],
    },
    handler: createTask,
    write: true,
  },
  update_status: {
    description: "Change a ClickUp task's status. Requires human approval per Marshall's autonomy rules.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" }, status: { type: "string" } },
      required: ["task_id", "status"],
    },
    handler: updateStatus,
    write: true,
  },
  assign: {
    description: "Add assignees to a ClickUp task by numeric user id. Requires human approval per Marshall's autonomy rules.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" }, assignee_ids: { type: "array", items: { type: "number" } } },
      required: ["task_id", "assignee_ids"],
    },
    handler: assignTask,
    write: true,
  },
  append_description: {
    description: "Append markdown to the end of a task's description (never rewrites existing content). Requires human approval per Marshall's autonomy rules.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" }, text_md: { type: "string" } },
      required: ["task_id", "text_md"],
    },
    handler: appendDescription,
    write: true,
  },
  rewrite_description: {
    description:
      "REPLACE a task's entire description with new markdown. Guarded in code: only works on tasks Marshall himself created (story redrafts, SOP reformats, superseded scope) — refuses on human-created tasks, whose descriptions are NEVER rewritten (append_description or a comment there instead). Requires human approval per Marshall's autonomy rules.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        markdown: { type: "string", description: "The complete new description — replaces everything" },
      },
      required: ["task_id", "markdown"],
    },
    handler: rewriteDescription,
    write: true,
  },
  file_client_request: {
    description:
      "File a client request (bug or feature) with the deterministic triage gate: simple + low impact auto-approves (todo, assigned to Marshall); everything else waits for the PM (inbox, assigned to the PM). Bugs become Problem tasks with Given/When/Then. Use exactly once per distinct request, after confirming your understanding with the client.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["bug", "feature"] },
        title: { type: "string" },
        summary: { type: "string", description: "Plain-language summary of what the client wants and why" },
        given: { type: "string", description: "Bug-only: the starting state" },
        when: { type: "string", description: "Bug-only: the action taken" },
        then: { type: "string", description: "Bug-only: expected vs actual" },
        complexity: { type: "string", enum: ["simple", "complex"], description: "When in doubt, complex" },
        impact: { type: "string", enum: ["low", "high"], description: "When in doubt, high" },
        assessment: { type: "string", description: "2-4 sentences for the PM: request, proposed approach, why this gate" },
        list_id: { type: "string", description: "Target ClickUp list id (defaults to the group's configured intake list)" },
      },
      required: ["kind", "title", "summary", "complexity", "impact", "assessment"],
    },
    handler: fileClientRequest,
    filing: true,
  },
  review_client_reply: {
    description:
      "Scan a draft reply for ClickUp URLs, CUP-xxx ids, and internal task ids before sending it to a client. Call this on EVERY message you're about to send in a client channel — required, not optional. If flagged, do not send the original; rewrite naturally using the reasons/status it gives you, never mentioning internal tooling.",
    inputSchema: {
      type: "object",
      properties: { draft: { type: "string", description: "The exact text you're about to send" } },
      required: ["draft"],
    },
    handler: reviewClientReply,
    filing: true,
  },
};

export function visibleTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return Object.entries(TOOLS)
    .filter(([, def]) => toolEnabled(def))
    .map(([name, def]) => ({ name, description: def.description, inputSchema: def.inputSchema }));
}

export async function callTool(name: string, args: unknown, f: FetchImpl): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const def = TOOLS[name];
  if (!def || !toolEnabled(def)) {
    return { content: [{ type: "text", text: `Unknown or disabled tool: ${name}` }], isError: true };
  }
  try {
    const text = await def.handler((args ?? {}) as never, f);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

// ---------------------------------------------------------------------------
// MCP stdio transport (newline-delimited JSON-RPC 2.0)
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export function handleRequest(req: JsonRpcRequest): Promise<Record<string, unknown> | null> | Record<string, unknown> | null {
  switch (req.method) {
    case "initialize":
      return {
        protocolVersion: (req.params?.protocolVersion as string) ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "clickup", version: "0.1.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: visibleTools() };
    case "tools/call": {
      const { name, arguments: args } = (req.params ?? {}) as { name: string; arguments?: unknown };
      return callTool(name, args, fetch) as Promise<Record<string, unknown>>;
    }
    default:
      return null; // notifications and unknown methods
  }
}

async function main() {
  console.error(`[clickup-mcp] up — team ${TEAM_ID}, writes ${WRITES_ENABLED ? "ENABLED" : "disabled"}`);
  for await (const line of console) {
    if (!line.trim()) continue;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    const isNotification = req.id === undefined || req.id === null;
    try {
      const result = await handleRequest(req);
      if (isNotification) continue;
      if (result === null) {
        console.log(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } }));
      } else {
        console.log(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
      }
    } catch (err) {
      if (!isNotification) {
        console.log(
          JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } })
        );
      }
    }
  }
}

if (import.meta.main) main();
