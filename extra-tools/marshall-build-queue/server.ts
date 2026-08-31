// Marshall's confirmed-build queue tool (CUP-4838, revised 2026-08-24).
//
// Single tool, mounted on Marshall's INTERNAL group only (never
// MarshallBuilder — this is what Marshall calls after HE decides to build
// something, not something the builder calls about itself). Same stdio
// JSON-RPC transport and gateway-injected-auth model as clickup-mcp: no
// Authorization header leaves this process — the OneCLI gateway injects
// PPHUB_MARSHALL_API_TOKEN in transit, keyed to the pp-hub host.
//
// This tool is the durability backstop, not the trigger. Marshall's real
// dispatch is send_message(to="MarshallBuilder") — a NanoClaw
// agent-to-agent primitive, not a tool this server provides (nothing to
// build for it; it's core). Call confirm_build AFTER that send_message,
// once a human has confirmed the build in Slack — never on a raw ClickUp
// assignment (see marshall-builder/SKILL.md's Architecture section for why).

const HUB_BASE_URL = process.env.MARSHALL_HUB_BASE_URL ?? "";

type FetchImpl = typeof fetch;

export interface ConfirmBuildArgs {
  task_id: string;
  custom_id?: string;
  time_estimate_minutes?: number;
}

// Dispatch-time ClickUp obligations (lifecycle refinement, 2026-08-27). The
// moment a human approves a build IS confirm_build — so the task's handoff
// state is enforced here, in code, never left to the agent remembering:
// status -> todo, assigned to Marshall, time estimate recorded. The builder
// then owns the next transition (prepare_workspace -> in progress) and time
// tracking. Story lifecycle: backlog (filed) -> todo+assigned+estimated
// (confirmed, here) -> in progress (builder) -> in review (finalize).
const CLICKUP_API_V2 = "https://api.clickup.com/api/v2";
const CLICKUP_TEAM_ID = process.env.CLICKUP_TEAM_ID ?? "2385794";
const MARSHALL_CLICKUP_USER_ID = Number(process.env.CLICKUP_MARSHALL_USER_ID ?? "87419960");

export function buildDispatchUpdate(timeEstimateMinutes?: number): Record<string, unknown> {
  const body: Record<string, unknown> = {
    status: "todo",
    assignees: { add: [MARSHALL_CLICKUP_USER_ID] },
  };
  if (timeEstimateMinutes && timeEstimateMinutes > 0) {
    body.time_estimate = Math.round(timeEstimateMinutes) * 60_000; // ClickUp wants ms
  }
  return body;
}

async function applyDispatchUpdate(taskRef: string, timeEstimateMinutes: number | undefined, f: FetchImpl): Promise<string> {
  try {
    const res = await f(
      `${CLICKUP_API_V2}/task/${encodeURIComponent(taskRef.trim())}?custom_task_ids=true&team_id=${CLICKUP_TEAM_ID}`,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildDispatchUpdate(timeEstimateMinutes)) }
    );
    if (!res.ok) return `ClickUp dispatch update FAILED (${res.status}) — set status/assignee/estimate by hand`;
    return timeEstimateMinutes && timeEstimateMinutes > 0
      ? `task -> todo, assigned to Marshall, estimate ${timeEstimateMinutes}m`
      : `task -> todo, assigned to Marshall (no estimate given — pass time_estimate_minutes next time)`;
  } catch (err) {
    return `ClickUp dispatch update FAILED (${err instanceof Error ? err.message : String(err)}) — set status/assignee/estimate by hand`;
  }
}

export async function confirmBuild(args: ConfirmBuildArgs, f: FetchImpl, baseUrl: string = HUB_BASE_URL): Promise<string> {
  if (!baseUrl) {
    throw new Error(
      "MARSHALL_HUB_BASE_URL is not configured on this MCP server registration — set it to pp-hub's production URL."
    );
  }
  if (!args.task_id?.trim()) {
    throw new Error("task_id is required.");
  }

  const res = await f(`${baseUrl.replace(/\/$/, "")}/api/marshall/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId: args.task_id, customId: args.custom_id ?? null }),
  });
  const body = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 401
        ? "Gateway did not authenticate this call — is PPHUB_MARSHALL_API_TOKEN configured in the OneCLI vault for pp-hub's host?"
        : "";
    throw new Error(`pp-hub build queue ${res.status}: ${body.slice(0, 300)}${hint ? ` — ${hint}` : ""}`);
  }

  // Durable job is safe — now enforce the ClickUp dispatch state. Runs even
  // on a deduped re-confirm (idempotent writes; a retry after a half-failed
  // first attempt should still fix the task).
  const dispatchNote = await applyDispatchUpdate(args.custom_id ?? args.task_id, args.time_estimate_minutes, f);

  const parsed = JSON.parse(body) as { jobId: string; deduped?: boolean };
  return parsed.deduped
    ? `Already queued as job ${parsed.jobId} — no duplicate created. ${dispatchNote}. Proceed with send_message(to="MarshallBuilder") as normal.`
    : `Durability backstop recorded as job ${parsed.jobId}. ${dispatchNote}. Now dispatch with send_message(to="MarshallBuilder").`;
}

// ---------------------------------------------------------------------------
// Tool registry + MCP stdio transport — same shape as clickup-mcp and
// marshall-builder's servers, kept independent (different agent groups).
// ---------------------------------------------------------------------------

interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: never, f: FetchImpl) => Promise<string>;
}

export const TOOLS: Record<string, ToolDef> = {
  confirm_build: {
    description:
      "Record a confirmed build (durability backstop) AND enforce the dispatch state on the ClickUp task: status -> todo, assigned to Marshall, time estimate set. Call this ONLY after a human has explicitly confirmed the build with you in Slack — never on a raw ClickUp assignment alone. Always pass time_estimate_minutes (your own estimate from drafting the story). Follow immediately with send_message(to=\"MarshallBuilder\") — this tool does not dispatch the build itself.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "CUP-xxx custom id or internal id" },
        custom_id: { type: "string", description: "The CUP-xxx custom id, if different from task_id" },
        time_estimate_minutes: { type: "number", description: "Your effort estimate for the build, in minutes (e.g. 60, 120). Recorded as the ClickUp time estimate." },
      },
      required: ["task_id"],
    },
    handler: confirmBuild,
  },
};

export function visibleTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return Object.entries(TOOLS).map(([name, def]) => ({ name, description: def.description, inputSchema: def.inputSchema }));
}

export async function callTool(name: string, args: unknown, f: FetchImpl): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const def = TOOLS[name];
  if (!def) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  try {
    const text = await def.handler((args ?? {}) as never, f);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

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
        serverInfo: { name: "marshall-build-queue", version: "0.1.0" },
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
      return null;
  }
}

async function main() {
  console.error(`[marshall-build-queue] up — hub ${HUB_BASE_URL || "(unconfigured!)"}`);
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
        console.log(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } }));
      }
    }
  }
}

if (import.meta.main) main();
