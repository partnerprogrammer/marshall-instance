import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildSlackPermalink,
  callTool,
  clickupFetch,
  formatTask,
  getTask,
  handleRequest,
  resolveOriginPermalink,
  reviewClientReply,
  reviewClientReplyText,
  visibleTools,
} from "./server";

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (!key) return new Response("not routed", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
}

const TASK = {
  id: "868ktx86f",
  custom_id: "CUP-4776",
  name: "Rebuild Marshall on NanoClaw v2",
  status: { status: "in progress" },
  url: "https://app.clickup.com/t/868ktx86f",
  due_date: null,
  priority: null,
  assignees: [{ username: "Gabriel Manicucci" }],
  list: { name: "PP Stack/Hub" },
  markdown_description: "Phase 0/1 scope…",
  subtasks: [{ id: "x1", custom_id: null, name: "sub", status: { status: "todo" } }],
};

describe("get_task", () => {
  test("resolves custom ids and prefers markdown description", async () => {
    let requested = "";
    const f = (async (url: RequestInfo | URL) => {
      requested = String(url);
      return new Response(JSON.stringify(TASK), { status: 200 });
    }) as typeof fetch;
    const out = await getTask({ task_id: "CUP-4776" }, f);
    expect(requested).toContain("custom_task_ids=true");
    expect(requested).toContain("team_id=");
    expect(requested).toContain("include_markdown_description=true");
    expect(out).toContain("[in progress] CUP-4776 > PP Stack/Hub > Rebuild Marshall on NanoClaw v2");
    expect(out).toContain("Phase 0/1 scope…");
    expect(out).toContain("- [todo] x1 sub");
  });
});

describe("formatTask", () => {
  test("handles minimal tasks without optional fields", () => {
    const out = formatTask({ id: "abc", name: "Bare" });
    expect(out).toContain("[?] abc > Bare");
    expect(out).toContain("unassigned");
  });
});

describe("clickupFetch", () => {
  test("maps 401 to the vault hint", async () => {
    const f = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    await expect(clickupFetch("https://api.clickup.com/x", undefined, f)).rejects.toThrow(/OneCLI vault/);
  });
});

describe("write gating", () => {
  test("write tools are hidden and rejected without the flag", async () => {
    // CLICKUP_MCP_ENABLE_WRITES is unset in the test env
    const names = visibleTools().map((t) => t.name);
    expect(names).toEqual(["get_task", "search_tasks", "list_structure", "get_doc_page"]);
    const res = await callTool("update_status", { task_id: "x", status: "todo" }, fakeFetch({}));
    expect(res.isError).toBe(true);
  });
});

describe("file_client_request (triage gate — ported from marshall-cli)", () => {
  const { decideGate, buildTaskDescription, fileClientRequest } = require("./server") as typeof import("./server");

  test("gate: only simple+low auto-approves", () => {
    expect(decideGate("simple", "low")).toBe("auto_approved");
    expect(decideGate("simple", "high")).toBe("pm_approval");
    expect(decideGate("complex", "low")).toBe("pm_approval");
    expect(decideGate("complex", "high")).toBe("pm_approval");
  });

  test("bug body carries Given/When/Then, the assessment, and the origin link", () => {
    const body = buildTaskDescription(
      {
        kind: "bug", title: "t", summary: "Login fails", given: "logged out", when: "click login",
        then: "expected dashboard, got 500", complexity: "simple", impact: "low",
        assessment: "Clear repro.", list_id: "1",
      },
      "https://app.slack.com/client/TB439AUSH/C0BR8DP5XLP/thread/C0BR8DP5XLP-1787280098.095089",
    );
    expect(body).toContain("**Given**");
    expect(body).toContain("auto-approved (simple + low risk)");
    expect(body).toContain("Origin conversation");
    expect(body).toContain("app.slack.com/client/TB439AUSH");
  });

  test("unresolved origin link falls back to an explicit note, never silently omitted", () => {
    const body = buildTaskDescription(
      { kind: "feature", title: "t", summary: "s", complexity: "simple", impact: "low", assessment: "a", list_id: "1" },
      null,
    );
    expect(body).toContain("Origin conversation");
    expect(body).toContain("could not be resolved");
  });

  test("auto-approved files as todo assigned to Marshall; pm gate as inbox to PM", async () => {
    let sent: Record<string, unknown> = {};
    const f = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: "x", name: "t", url: "u" }), { status: 200 });
    }) as typeof fetch;
    await fileClientRequest({ kind: "bug", title: "t", summary: "s", complexity: "simple", impact: "low", assessment: "a", list_id: "1" }, f);
    expect(sent.status).toBe("todo");
    expect(sent.assignees).toEqual([87419960]);
    expect(sent.custom_item_id).toBe(1011);
    const out = await fileClientRequest({ kind: "feature", title: "t", summary: "s", complexity: "complex", impact: "low", assessment: "a", list_id: "1" }, f);
    expect(sent.status).toBe("inbox");
    expect(sent.assignees).toEqual([6351523]);
    expect(sent.custom_item_id).toBeUndefined();
    expect(out).toContain("NEVER mention ClickUp");
  });
});

describe("buildSlackPermalink", () => {
  test("builds the app.slack.com/client thread deep link from routing fields", () => {
    const link = buildSlackPermalink("slack:C0BR8DP5XLP", "slack:C0BR8DP5XLP:1787280098.095089", "TB439AUSH");
    expect(link).toBe("https://app.slack.com/client/TB439AUSH/C0BR8DP5XLP/thread/C0BR8DP5XLP-1787280098.095089");
  });

  test("returns null for non-Slack or malformed routing fields", () => {
    expect(buildSlackPermalink("cli:local", "cli:local", "TB439AUSH")).toBeNull();
    expect(buildSlackPermalink("slack:C0BR8DP5XLP", "slack:C0BR8DP5XLP:not-a-timestamp", "TB439AUSH")).toBeNull();
    expect(buildSlackPermalink("slack:C0BR8DP5XLP", "", "TB439AUSH")).toBeNull();
  });
});

describe("resolveOriginPermalink", () => {
  function makeInboundDb(rows: Array<{ platform_id: string | null; channel_type: string; thread_id: string | null }>): string {
    const path = join(tmpdir(), `inbound-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const db = new Database(path);
    db.run("CREATE TABLE messages_in (seq INTEGER PRIMARY KEY, platform_id TEXT, channel_type TEXT, thread_id TEXT)");
    for (const row of rows) {
      db.run("INSERT INTO messages_in (platform_id, channel_type, thread_id) VALUES (?, ?, ?)", [row.platform_id, row.channel_type, row.thread_id]);
    }
    db.close();
    return path;
  }

  test("picks the most recent Slack message's routing fields", async () => {
    const path = makeInboundDb([
      { platform_id: "slack:C0OLD", channel_type: "slack", thread_id: "slack:C0OLD:1000.000001" },
      { platform_id: null, channel_type: "session-echo", thread_id: null },
      { platform_id: "slack:C0BR8DP5XLP", channel_type: "slack", thread_id: "slack:C0BR8DP5XLP:1787280098.095089" },
    ]);
    const link = await resolveOriginPermalink(path);
    expect(link).toBe("https://app.slack.com/client/TB439AUSH/C0BR8DP5XLP/thread/C0BR8DP5XLP-1787280098.095089");
  });

  test("returns null (never throws) when the db has no Slack rows or doesn't exist", async () => {
    const empty = makeInboundDb([{ platform_id: null, channel_type: "session-echo", thread_id: null }]);
    expect(await resolveOriginPermalink(empty)).toBeNull();
    expect(await resolveOriginPermalink("/nonexistent/path/inbound.db")).toBeNull();
  });
});

describe("reviewClientReplyText", () => {
  test("clean text passes through untouched", () => {
    const r = reviewClientReplyText("We're on it, I'll keep you posted here.");
    expect(r.clean).toBe(true);
    expect(r.redactions).toBe(0);
    expect(r.text).toBe("We're on it, I'll keep you posted here.");
  });

  test("flags and redacts ClickUp urls, CUP ids, and raw task ids", () => {
    const r = reviewClientReplyText("Filed as CUP-4827: https://app.clickup.com/t/868kuqzy2");
    expect(r.clean).toBe(false);
    expect(r.redactions).toBeGreaterThan(0);
    expect(r.text).not.toContain("CUP-4827");
    expect(r.text).not.toContain("clickup.com");
    expect(r.text).not.toContain("868kuqzy2");
  });

  test("does not false-positive on ordinary numbers", () => {
    const r = reviewClientReplyText("Room 868 is on floor 8, checkout is 8:68am.");
    expect(r.clean).toBe(true);
  });
});

describe("reviewClientReply handler", () => {
  // Gating itself (filing: true -> hidden unless CLICKUP_MCP_ENABLE_FILING=1)
  // is exercised by the existing "write gating" describe above, which asserts
  // the visible-tools list with the test env's flags unset — same mechanism
  // this tool uses. Here we test the handler's own behavior directly.
  test("clean draft passes through with a go-ahead", async () => {
    const out = await reviewClientReply({ draft: "We're on it!" }, (async () => new Response()) as unknown as typeof fetch);
    expect(out).toContain("clean");
  });

  test("flagged draft never echoes the raw internal reference back", async () => {
    const out = await reviewClientReply({ draft: "See CUP-4827 for details" }, (async () => new Response()) as unknown as typeof fetch);
    expect(out).toContain("FLAGGED");
    expect(out).not.toContain("CUP-4827");
  });
});

describe("MCP transport", () => {
  test("initialize and tools/list respond in shape", async () => {
    const init = (await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })) as {
      protocolVersion: string;
      serverInfo: { name: string };
    };
    expect(init.protocolVersion).toBe("2025-03-26");
    expect(init.serverInfo.name).toBe("clickup");
    const list = (await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as { tools: Array<{ name: string }> };
    expect(list.tools.length).toBeGreaterThanOrEqual(4);
    expect(await handleRequest({ jsonrpc: "2.0", id: 3, method: "nope" })).toBeNull();
  });
});

describe("rewriteDescription (creator guard — human descriptions are never rewritten)", () => {
  const { rewriteDescription } = require("./server") as typeof import("./server");

  test("rewrites when Marshall created the task", async () => {
    const f = fakeFetch({ "/task/": { id: "t1", custom_id: "CUP-4987", creator: { id: 87419960 } } });
    const out = await rewriteDescription({ task_id: "CUP-4987", markdown: "# New story" }, f);
    expect(out).toContain("REWRITTEN");
  });

  test("refuses when a human created the task, pointing at append/comment instead", async () => {
    const f = fakeFetch({ "/task/": { id: "t2", custom_id: "CUP-1", creator: { id: 6351523 } } });
    await expect(rewriteDescription({ task_id: "CUP-1", markdown: "x" }, f)).rejects.toThrow(/never rewritten/);
  });
});
