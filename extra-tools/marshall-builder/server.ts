// MarshallBuilder MCP server (CUP-4838, plan Phase 3.1).
//
// Deterministic terminal-obligation tools ported from marshall-cli, run
// inside the MarshallBuilder agent container as
// `bun run /workspace/extra/marshall-builder/server.ts`. Same stdio
// JSON-RPC transport and auth model as clickup-mcp: no Authorization header
// leaves this process — the container-wide OneCLI gateway proxy injects
// Marshall's ClickUp token in transit.
//
// What's ported and why (CUP-4702 lesson: terminal obligations live in
// code, never a prompt — a GitHub outage once killed a build session
// mid-handoff and left the task silently stuck "in progress" on Marshall,
// its merged PR invisible to pp-hub's post-review lifecycle):
//   - prepare_workspace: catalog whitelist + worktree/branch enforcement
//     (marshall-cli src/workspace/git.ts)
//   - finalize_handoff: PR-link-in-description / status->review / reassign
//     enforcement (marshall-cli src/cli/finalize.ts)
//   - record_work_time: one completed time entry per run, never throws
//     (marshall-cli src/clickup/time-tracking.ts)
//   - bounce_to_pm: revert status, reassign, "needs your input" note
//     (marshall-cli src/clickup/tasks.ts#bounceToPM)
//
// What's deliberately NOT ported: project routing (marshall-cli's
// resolveProject two-stage LLM pass). MarshallBuilder is itself a Claude
// Code agent with Read/Grep already mounted on every catalog repo — it
// reads repo-map.json + each project's CLAUDE.md and decides project_key
// the same way a human developer would, no nested session needed.
// prepare_workspace only *enforces* that choice (whitelist, readonly, one
// worktree per task, correct branch) — it never makes it.

import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import repoMap from "./repo-map.json";

const execFileAsync = promisify(execFile);

const TEAM_ID = process.env.CLICKUP_TEAM_ID ?? "2385794";
const API_V2 = "https://api.clickup.com/api/v2";
const WORKSPACE_ROOT = process.env.MARSHALL_BUILD_WORKSPACE_ROOT ?? "/workspace/build";
const MARSHALL_USER_ID = Number(process.env.CLICKUP_MARSHALL_USER_ID ?? "87419960");
const FALLBACK_PM_USER_ID = Number(process.env.CLICKUP_PM_USER_ID ?? "6351523");
export const REVIEW_STATUS = "in review";

// ---------------------------------------------------------------------------
// HTTP (same shape as clickup-mcp/assets/server.ts — kept independent on
// purpose rather than imported: these two MCP servers are mounted into
// different, isolated agent groups and must never share a module graph)
// ---------------------------------------------------------------------------

type FetchImpl = typeof fetch;

const HINTS: Record<number, string> = {
  401: "Gateway did not authenticate this call — is the ClickUp secret configured in the OneCLI vault?",
  404: "Not found — check the id. Custom ids (CUP-xxx) only resolve with custom_task_ids=true&team_id.",
  429: "Rate limited by ClickUp — wait a minute and retry.",
};

export async function clickupFetch(url: string, init: RequestInit | undefined, f: FetchImpl): Promise<unknown> {
  const res = await f(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body = await res.text();
  if (!res.ok) {
    const hint = HINTS[res.status] ?? (res.status >= 500 ? "ClickUp server error — retry shortly." : "");
    throw new Error(`ClickUp API ${res.status} on ${url}: ${body.slice(0, 300)}${hint ? ` — ${hint}` : ""}`);
  }
  return body ? JSON.parse(body) : {};
}

const CUSTOM_ID_PARAMS = `custom_task_ids=true&team_id=${TEAM_ID}`;

interface ClickUpTaskLite {
  id: string;
  custom_id?: string | null;
  markdown_description?: string | null;
  description?: string | null;
  status: { status: string };
  assignees: Array<{ id: number }>;
  creator: { id: number };
}

async function getTask(taskId: string, f: FetchImpl): Promise<ClickUpTaskLite> {
  return (await clickupFetch(
    `${API_V2}/task/${encodeURIComponent(taskId.trim())}?${CUSTOM_ID_PARAMS}&include_markdown_description=true`,
    undefined,
    f
  )) as ClickUpTaskLite;
}

interface UpdateTaskBody {
  status?: string;
  markdown_content?: string;
  assignees?: { add?: number[]; rem?: number[] };
}

async function updateTask(taskId: string, body: UpdateTaskBody, f: FetchImpl): Promise<ClickUpTaskLite> {
  return (await clickupFetch(
    `${API_V2}/task/${encodeURIComponent(taskId.trim())}?${CUSTOM_ID_PARAMS}`,
    { method: "PUT", body: JSON.stringify(body) },
    f
  )) as ClickUpTaskLite;
}

function displayTaskId(task: { id: string; custom_id?: string | null }): string {
  return task.custom_id || task.id;
}

// ---------------------------------------------------------------------------
// Who's the PM (marshall-cli src/clickup/tasks.ts — same rule, ported
// verbatim: no ClickUp field for "who approves this", the task creator is
// the one identity every task carries — EXCEPT when Marshall himself
// created it, which would otherwise hand a stuck task back to Marshall,
// the exact CUP-4702 shape)
// ---------------------------------------------------------------------------

export function resolvePmUserId(creatorId: number, opts: { pmUserId?: number; marshallUserId?: number }): number {
  if (opts.marshallUserId !== undefined && creatorId === opts.marshallUserId) {
    return opts.pmUserId ?? FALLBACK_PM_USER_ID;
  }
  return creatorId;
}

export function pmUserIdFor(task: ClickUpTaskLite): number {
  return resolvePmUserId(task.creator.id, { pmUserId: FALLBACK_PM_USER_ID, marshallUserId: MARSHALL_USER_ID });
}

// ---------------------------------------------------------------------------
// prepare_workspace (marshall-cli src/workspace/git.ts)
// ---------------------------------------------------------------------------

interface RepoMapProject {
  git_url: string;
  subpath: string;
  description: string;
  readonly?: boolean;
}

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export function branchNameForTask(taskCustomId: string): string {
  return `marshall/${slugify(taskCustomId)}`;
}

function cacheDirFor(gitUrl: string): string {
  const slug = slugify(gitUrl.replace(/^git@/, "").replace(/^https?:\/\//, "").replace(/\.git$/, ""));
  return join(WORKSPACE_ROOT, "repos", slug);
}

function worktreeDirFor(projectKey: string, branch: string): string {
  return join(WORKSPACE_ROOT, "worktrees", projectKey, slugify(branch));
}

function ensureClone(gitUrl: string, cacheDir: string): void {
  if (existsSync(cacheDir)) {
    execFileSync("git", ["fetch", "origin"], { cwd: cacheDir, stdio: "inherit" });
    execFileSync("git", ["reset", "--hard", "origin/main"], { cwd: cacheDir, stdio: "inherit" });
  } else {
    execFileSync("git", ["clone", gitUrl, cacheDir], { stdio: "inherit" });
  }
  // Repo-LOCAL identity, stomped on every run — local config outranks the
  // global default ensureGitSetup writes, and clones persist across container
  // respawns in the session dir. Bit us on CUP-4925: the agent had hand-set
  // "MarshallBuilder <marshall-builder@...>" locally during the first build,
  // the clone survived, and every later commit silently kept the stale
  // unlinked identity despite the new global. Worktrees share the parent
  // repo's config, so setting it here covers them all.
  execFileSync("git", ["config", "user.name", GIT_AUTHOR_NAME], { cwd: cacheDir, stdio: "inherit" });
  execFileSync("git", ["config", "user.email", GIT_AUTHOR_EMAIL], { cwd: cacheDir, stdio: "inherit" });
}

function createTaskWorktree(cacheDir: string, worktreeDir: string, branch: string): void {
  if (existsSync(worktreeDir)) return; // resuming a previous run on the same task/branch
  execFileSync("git", ["worktree", "add", "-b", branch, worktreeDir, "origin/main"], { cwd: cacheDir, stdio: "inherit" });
}

// A reused worktree's checked-out branch isn't guaranteed to still match its
// folder name (Bash access can `git checkout -b` inside it) — verify and
// correct before handing control back, so a stray branch switch from one
// run doesn't silently redirect the next task's commits.
function ensureOnBranch(worktreeDir: string, branch: string): void {
  const actual = execFileSync("git", ["branch", "--show-current"], { cwd: worktreeDir, encoding: "utf-8" }).trim();
  if (actual === branch) return;
  execFileSync("git", ["checkout", branch], { cwd: worktreeDir, stdio: "inherit" });
}

export function resolveCatalogProject(projectKey: string): RepoMapProject {
  const projects = (repoMap as { projects: Record<string, RepoMapProject> }).projects;
  const project = projects[projectKey];
  if (!project) {
    throw new Error(
      `"${projectKey}" is not in the catalog (repo-map.json). Whitelisted: ${Object.keys(projects).join(", ")}. Never guess — call bounce_to_pm instead.`
    );
  }
  if (project.readonly) {
    throw new Error(
      `"${projectKey}" is marked read-only in the catalog — Marshall can read it for context but can never open a PR against it. Call bounce_to_pm instead.`
    );
  }
  return project;
}

// Global git setup (CUP-4838). Everything here is idempotent — safe to
// repeat on every prepare_workspace call — and everything here exists
// because its absence broke (or would silently degrade) a real build:
//
// - credential.helper: fallback auth layer. The PRIMARY github.com auth is
//   the OneCLI gateway's github-app connection injecting the installation
//   token in transit (confirmed live 2026-08-26); the helper only matters
//   if that connection is ever removed/broken, minting its own token from
//   pp-hub. See assets/bin/git-credential-marshall.
// - http.sslCAInfo: git does NOT read SSL_CERT_FILE (that's an OpenSSL-tool
//   convention curl/node honor, not git's) — without this, every git HTTPS
//   call through the gateway's MITM proxy fails TLS verification. Bit the
//   first live build (CUP-4918); the agent had to discover and set it by
//   hand mid-run.
// - user.name/email: containers spawn with no git identity, so the first
//   `git commit` errors out. Same first live build, same manual fix.
//   MarshallBuilder commits under its own name — auditable, and consistent
//   with PP's no-Claude-attribution convention.
//
// All overridable via env for testability/config — never actually invoked
// by the current test suite (prepareWorkspace tests reject before this);
// gitConfigEntries is the pure, tested part.
const GIT_CREDENTIAL_HELPER = process.env.GIT_CREDENTIAL_HELPER ?? "/workspace/extra/marshall-builder/bin/git-credential-marshall";
// GitHub attributes commits to the pp-marshall App (name, avatar, [bot]
// badge) by matching the committer email against the App's bot-user noreply
// address — <bot-user-id>+<slug>[bot]@users.noreply.github.com. An arbitrary
// email renders as an unlinked gray identity (bit PR #111, the first live
// build). 277097953 is pp-marshall[bot]'s user id (GET /users/pp-marshall[bot]).
const GIT_AUTHOR_NAME = process.env.MARSHALL_GIT_AUTHOR_NAME ?? "pp-marshall[bot]";
const GIT_AUTHOR_EMAIL = process.env.MARSHALL_GIT_AUTHOR_EMAIL ?? "277097953+pp-marshall[bot]@users.noreply.github.com";

export function gitConfigEntries(env: { sslCertFile?: string } = {}): Array<[string, string]> {
  const entries: Array<[string, string]> = [
    ["credential.helper", GIT_CREDENTIAL_HELPER],
    ["user.name", GIT_AUTHOR_NAME],
    ["user.email", GIT_AUTHOR_EMAIL],
  ];
  if (env.sslCertFile) entries.push(["http.sslCAInfo", env.sslCertFile]);
  return entries;
}

function ensureGitSetup(): void {
  for (const [key, value] of gitConfigEntries({ sslCertFile: process.env.SSL_CERT_FILE })) {
    execFileSync("git", ["config", "--global", key, value], { stdio: "inherit" });
  }
}

export async function prepareWorkspace(args: { task_id: string; project_key: string }, f: FetchImpl): Promise<string> {
  const project = resolveCatalogProject(args.project_key);
  ensureGitSetup();
  const task = await getTask(args.task_id, f);
  const taskRef = displayTaskId(task);
  const branch = branchNameForTask(taskRef);
  const cacheDir = cacheDirFor(project.git_url);
  const worktreeDir = worktreeDirFor(args.project_key, branch);

  ensureClone(project.git_url, cacheDir);
  createTaskWorktree(cacheDir, worktreeDir, branch);
  ensureOnBranch(worktreeDir, branch);

  // Marks when Marshall's work window opens, in code — not left to the
  // agent's own freeform judgment (same reasoning as ensureOnBranch): the
  // moment that determines "is Marshall working on this right now" must
  // never rest on the session alone. record_work_time closes the window.
  await updateTask(task.id, { status: "in progress" }, f);

  const workDir = join(worktreeDir, project.subpath);
  return [
    `workspace ready for ${taskRef} on branch ${branch}`,
    `worktree: ${worktreeDir}`,
    `work_dir: ${workDir}`,
    `status: in progress (started_at ${Date.now()} — pass this to record_work_time when the run ends)`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// finalize_handoff (marshall-cli src/cli/finalize.ts)
// ---------------------------------------------------------------------------

interface PrInfo {
  url: string;
  state: string; // OPEN | MERGED | CLOSED
}

// Container path is /workspace/extra/gh/bin/gh, not bare "gh" on PATH (the
// mount exists but PATH isn't extended for it — same reason Marshall's own
// persona tells him to use the full path). Overridable so local dev/tests
// keep using whatever "gh" resolves to on PATH.
const GH_BIN = process.env.GH_BIN ?? "gh";

async function findPrForBranch(worktreeDir: string, branch: string): Promise<PrInfo | null> {
  try {
    const { stdout } = await execFileAsync(GH_BIN, ["pr", "view", branch, "--json", "url,state"], { cwd: worktreeDir });
    const { url, state } = JSON.parse(stdout) as { url?: string; state?: string };
    return typeof url === "string" && typeof state === "string" ? { url, state } : null;
  } catch {
    return null;
  }
}

/**
 * Pure — unit-tested against every intervention scenario. PR link missing
 * from the description → append it (pp-hub's post-review lifecycle
 * discovers the PR by this link). Status still "in progress" (what
 * prepare_workspace itself set) → the session never handed off: move to
 * review and reassign to the PM. Any other status means the session or a
 * human already acted — leave status/assignees alone, append-only.
 */
export function planHandoff(task: ClickUpTaskLite, prUrl: string, pmUserId: number): UpdateTaskBody | null {
  const body: UpdateTaskBody = {};
  const description = task.markdown_description ?? task.description ?? "";
  if (!description.includes(prUrl)) {
    body.markdown_content = `${description}\n\n---\n**Marshall — PR**: ${prUrl}\n`;
  }
  if (task.status.status.toLowerCase() === "in progress") {
    body.status = REVIEW_STATUS;
    body.assignees = { add: [pmUserId], rem: task.assignees.map((a) => a.id).filter((id) => id !== pmUserId) };
  }
  return Object.keys(body).length > 0 ? body : null;
}

// Terminal half of the confirmed-build durability loop (CUP-4838). Marshall's
// confirm_build wrote a task_run row into pp-hub's marshall_jobs at dispatch;
// marking it done here (on BOTH terminal outcomes — handoff and bounce) is
// what lets the queue sweep treat a still-queued row past its build budget as
// the real signal: "dispatched but never finished". Best-effort, never
// throws — losing the marker must not fail a handoff that already succeeded
// (same principle as record_work_time). No Authorization header on purpose:
// the OneCLI gateway injects PPHUB_MARSHALL_API_TOKEN in transit.
const HUB_BASE_URL = process.env.MARSHALL_HUB_BASE_URL ?? "https://hub.partnerprogrammer.com";

async function completeBuildJob(task: { id: string; custom_id?: string | null }, f: FetchImpl): Promise<string> {
  try {
    const res = await f(`${HUB_BASE_URL.replace(/\/$/, "")}/api/marshall/jobs/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: task.id, customId: task.custom_id ?? undefined }),
    });
    if (!res.ok) return `backstop job not closed (pp-hub ${res.status}) — harmless unless the queue sweep alerts later`;
    const { completed } = (await res.json()) as { completed?: number };
    return completed ? `backstop job closed` : `no pending backstop job (ad-hoc dispatch or already closed)`;
  } catch (err) {
    return `backstop job not closed (${err instanceof Error ? err.message : String(err)}) — harmless unless the queue sweep alerts later`;
  }
}

/**
 * Verify the session's terminal obligations and enforce whatever it
 * skipped. Throws when no PR exists (or only a CLOSED one) — a "successful"
 * session without an open PR is a silent give-up; the caller's next move
 * should be bounce_to_pm, not a retry.
 */
export async function finalizeHandoff(args: { task_id: string; worktree_dir: string; branch: string }, f: FetchImpl): Promise<string> {
  const pr = await findPrForBranch(args.worktree_dir, args.branch);
  if (!pr || pr.state === "CLOSED") {
    throw new Error(
      pr
        ? `Session ended with PR ${pr.url} closed and unmerged — nothing to hand off. Call bounce_to_pm.`
        : "Session ended without opening a PR — nothing to hand off. Call bounce_to_pm."
    );
  }
  const task = await getTask(args.task_id, f); // re-fetch: a human may have already moved it
  const body = planHandoff(task, pr.url, pmUserIdFor(task));
  const jobNote = await completeBuildJob(task, f);
  if (body) {
    await updateTask(task.id, body, f);
    return `${displayTaskId(task)}: enforced handoff (${Object.keys(body).join(", ")}) — PR ${pr.url} (${jobNote})`;
  }
  return `${displayTaskId(task)}: handoff already complete — PR ${pr.url} (${jobNote})`;
}

// ---------------------------------------------------------------------------
// record_work_time (marshall-cli src/clickup/time-tracking.ts)
// ---------------------------------------------------------------------------

/**
 * Marshall measures his own work window locally (wall-clock) instead of
 * driving a live ClickUp timer — a live timer supports one running
 * instance per account, so tying tracking to that shared slot would either
 * block a task Marshall works on concurrently or (as happened once) leave
 * it stuck running forever if a run is killed hard enough to skip cleanup.
 * Never throws — a time-tracking failure must not block the actual work
 * that already happened. No-ops on non-positive duration.
 */
export async function recordWorkTime(args: { task_id: string; started_at_ms: number }, f: FetchImpl): Promise<string> {
  const duration = Date.now() - args.started_at_ms;
  if (duration <= 0) return `skipped — non-positive duration (${duration}ms)`;
  try {
    await clickupFetch(
      `${API_V2}/team/${TEAM_ID}/time_entries`,
      { method: "POST", body: JSON.stringify({ tid: args.task_id, start: args.started_at_ms, duration }) },
      f
    );
    return `recorded ${Math.round(duration / 60000)}m for ${args.task_id}`;
  } catch (err) {
    return `failed to record time for ${args.task_id}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// bounce_to_pm (marshall-cli src/clickup/tasks.ts#bounceToPM)
// ---------------------------------------------------------------------------

export interface NeedsInputNote {
  whatHappened: string;
  attempted?: string[];
  blocking: string;
  technicalDetail?: string;
}

export function formatNeedsInputNote(note: NeedsInputNote): string {
  const sections = [`**What happened**\n${note.whatHappened}`];
  if (note.attempted?.length) sections.push(`**What was attempted**\n${note.attempted.map((a) => `- ${a}`).join("\n")}`);
  sections.push(
    note.technicalDetail
      ? `**What's blocking**\n${note.blocking}\n\nTechnical detail:\n\`\`\`\n${note.technicalDetail}\n\`\`\``
      : `**What's blocking**\n${note.blocking}`
  );
  return sections.join("\n\n");
}

function appendNote(task: ClickUpTaskLite, note: string): string {
  const existing = task.markdown_description ?? task.description ?? "";
  return `${existing}\n\n---\n${note}\n`;
}

/**
 * The safety net for the whole build: a routing failure, a readonly-project
 * mistake, a crashed session, or a stuck a2a handoff to Marshall all land
 * here. No task is ever left silently stuck assigned to Marshall — revert
 * status, reassign to the PM, and write a plain-English "needs your input"
 * note (raw error last, never the headline).
 */
export async function bounceToPm(args: { task_id: string; revert_status: string; note: NeedsInputNote }, f: FetchImpl): Promise<string> {
  const task = await getTask(args.task_id, f);
  const pmId = pmUserIdFor(task);
  await updateTask(
    task.id,
    {
      status: args.revert_status,
      markdown_content: appendNote(task, `**Marshall — needs your input**\n\n${formatNeedsInputNote(args.note)}`),
      assignees: { add: [pmId], rem: task.assignees.map((a) => a.id).filter((id) => id !== pmId) },
    },
    f
  );
  const jobNote = await completeBuildJob(task, f);
  return `${displayTaskId(task)}: bounced to PM (user ${pmId}), status reverted to "${args.revert_status}" (${jobNote})`;
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: never, f: FetchImpl) => Promise<string>;
}

export const TOOLS: Record<string, ToolDef> = {
  prepare_workspace: {
    description:
      "Enforce the catalog whitelist and set up an isolated git worktree for a task in an approved project (project_key must be one you've already decided by reading repo-map.json's descriptions and each project's CLAUDE.md). Idempotent — resumes an existing worktree/branch for the same task. Sets the task to 'in progress' and returns the work_dir to build in plus a started_at timestamp for record_work_time.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "CUP-xxx custom id or internal id" },
        project_key: { type: "string", description: "Catalog key from repo-map.json — never a guess; must exist and not be read-only" },
      },
      required: ["task_id", "project_key"],
    },
    handler: prepareWorkspace,
  },
  finalize_handoff: {
    description:
      "Verify and enforce the terminal handoff after a build: PR link appended to the task description if missing, status moved to 'in review' and reassigned to the PM if the task is still 'in progress'. Throws if no open PR exists — call bounce_to_pm instead when this throws. ALWAYS call this before ending a build session, success or failure.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        worktree_dir: { type: "string", description: "The worktree path returned by prepare_workspace" },
        branch: { type: "string", description: "The branch name returned by prepare_workspace" },
      },
      required: ["task_id", "worktree_dir", "branch"],
    },
    handler: finalizeHandoff,
  },
  record_work_time: {
    description: "Record a completed ClickUp time entry for the work window since prepare_workspace's started_at. Never throws — call this once, at the very end of every run (success, bounce, or crash-recovery), regardless of outcome.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        started_at_ms: { type: "number", description: "The started_at timestamp prepare_workspace returned" },
      },
      required: ["task_id", "started_at_ms"],
    },
    handler: recordWorkTime,
  },
  bounce_to_pm: {
    description:
      "Revert a task to its pre-build status, reassign to the PM, and append a plain-English 'needs your input' note. Call this whenever a build cannot complete: unresolved routing, a read-only project, a crashed session, or finalize_handoff throwing. No task should ever end a build session still assigned to Marshall without either an open PR (finalize_handoff) or this call.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        revert_status: { type: "string", description: "The task's status before this build attempt started" },
        note: {
          type: "object",
          properties: {
            whatHappened: { type: "string" },
            attempted: { type: "array", items: { type: "string" } },
            blocking: { type: "string" },
            technicalDetail: { type: "string" },
          },
          required: ["whatHappened", "blocking"],
        },
      },
      required: ["task_id", "revert_status", "note"],
    },
    handler: bounceToPm,
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

// ---------------------------------------------------------------------------
// MCP stdio transport (newline-delimited JSON-RPC 2.0) — identical shape to
// clickup-mcp/assets/server.ts, kept independent rather than shared: these
// two servers are mounted into different, isolated agent groups.
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
        serverInfo: { name: "marshall-builder", version: "0.1.0" },
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
  console.error(`[marshall-builder] up — team ${TEAM_ID}, workspace root ${WORKSPACE_ROOT}`);
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
