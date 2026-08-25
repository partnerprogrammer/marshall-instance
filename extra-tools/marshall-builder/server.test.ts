import { describe, expect, test } from "bun:test";
import {
  bounceToPm,
  branchNameForTask,
  formatNeedsInputNote,
  handleRequest,
  planHandoff,
  pmUserIdFor,
  prepareWorkspace,
  resolveCatalogProject,
  resolvePmUserId,
  REVIEW_STATUS,
  visibleTools,
} from "./server";

const PR_URL = "https://github.com/partnerprogrammer/pp-brain/pull/70";
const PM = 6351523;
const MARSHALL = 87419960;

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    custom_id: "CUP-4702",
    markdown_description: "desc",
    description: "desc",
    status: { status: "in progress" },
    assignees: [{ id: MARSHALL }],
    creator: { id: MARSHALL },
    ...overrides,
  } as never;
}

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (!key) return new Response(JSON.stringify({}), { status: 200 });
    void init;
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
}

describe("resolvePmUserId / pmUserIdFor", () => {
  test("returns the creator when the creator isn't Marshall", () => {
    expect(resolvePmUserId(999, { pmUserId: PM, marshallUserId: MARSHALL })).toBe(999);
  });

  test("falls back to the configured PM when Marshall created the task (CUP-4702 shape — never hands back to Marshall)", () => {
    expect(resolvePmUserId(MARSHALL, { pmUserId: PM, marshallUserId: MARSHALL })).toBe(PM);
  });

  test("pmUserIdFor reads creator.id off the task", () => {
    expect(pmUserIdFor(task({ creator: { id: 42 } }))).toBe(42);
  });
});

describe("planHandoff", () => {
  test("enforces the full handoff when the session died mid-flight (CUP-4702 shape)", () => {
    const body = planHandoff(task(), PR_URL, PM);
    expect(body).not.toBeNull();
    expect(body!.markdown_content).toContain(PR_URL);
    expect(body!.markdown_content).toContain("desc"); // append-only
    expect(body!.status).toBe(REVIEW_STATUS);
    expect(body!.assignees).toEqual({ add: [PM], rem: [MARSHALL] });
  });

  test("is a no-op when the session already did everything", () => {
    const done = task({
      markdown_description: `desc\n\n---\n**Marshall — PR**: ${PR_URL}\n`,
      status: { status: "in review" },
      assignees: [{ id: PM }],
    });
    expect(planHandoff(done, PR_URL, PM)).toBeNull();
  });

  test("append-only when status already moved but the link is missing (never overwrites a human's status change)", () => {
    const body = planHandoff(task({ status: { status: "in review" } }), PR_URL, PM);
    expect(body).toEqual({ markdown_content: `desc\n\n---\n**Marshall — PR**: ${PR_URL}\n` });
  });
});

describe("branchNameForTask", () => {
  test("slugifies the custom id into a marshall/ branch", () => {
    expect(branchNameForTask("CUP-4838")).toBe("marshall/cup-4838");
  });
});

describe("resolveCatalogProject", () => {
  test("resolves a whitelisted project", () => {
    expect(resolveCatalogProject("pp-hub").subpath).toBe("projects/pp-hub");
  });

  test("throws — never guesses — on an unknown project key", () => {
    expect(() => resolveCatalogProject("not-a-real-project")).toThrow(/not in the catalog/);
  });

  test("throws on a read-only catalog entry", () => {
    expect(() => resolveCatalogProject("logistics-app")).toThrow(/read-only/);
  });

  test("resolves every breez-brain project (full catalog access, not just breez-hub)", () => {
    for (const key of ["breez-website", "breez-hubspot-app", "breez-ai-agent", "logistics-mobile-app", "knowledge-base-faq", "knowledge-base-articles"]) {
      expect(resolveCatalogProject(key).git_url).toBe("git@github.com:partnerprogrammer/breez-brain.git");
    }
  });

  test("resolves pp-stack as its own standalone repo", () => {
    const project = resolveCatalogProject("pp-stack");
    expect(project.git_url).toBe("git@github.com:partnerprogrammer/pp-stack.git");
    expect(project.subpath).toBe(".");
  });
});

describe("formatNeedsInputNote", () => {
  test("puts plain-English what/why first, raw error last", () => {
    const text = formatNeedsInputNote({
      whatHappened: "Routing was ambiguous.",
      blocking: "A human needs to pick a project.",
      technicalDetail: "Error: stack trace here",
    });
    const whatIdx = text.indexOf("What happened");
    const techIdx = text.indexOf("Technical detail");
    expect(whatIdx).toBeGreaterThanOrEqual(0);
    expect(techIdx).toBeGreaterThan(whatIdx);
  });
});

describe("bounceToPm", () => {
  test("reverts status, reassigns to the PM, appends a needs-input note — never leaves the task on Marshall", async () => {
    const f = fakeFetch({ "/task/": task({ creator: { id: MARSHALL } }) });
    const result = await bounceToPm(
      { task_id: "CUP-4702", revert_status: "todo", note: { whatHappened: "crashed", blocking: "needs review" } },
      f
    );
    expect(result).toContain("bounced to PM");
    expect(result).toContain(String(PM)); // FALLBACK_PM_USER_ID default, since creator is Marshall
  });
});

describe("prepareWorkspace", () => {
  test("rejects an unresolved project before touching git", async () => {
    const f = fakeFetch({ "/task/": task() });
    await expect(prepareWorkspace({ task_id: "CUP-4838", project_key: "does-not-exist" }, f)).rejects.toThrow(/not in the catalog/);
  });

  test("rejects a read-only project before touching git", async () => {
    const f = fakeFetch({ "/task/": task() });
    await expect(prepareWorkspace({ task_id: "CUP-4838", project_key: "logistics-app" }, f)).rejects.toThrow(/read-only/);
  });
});

describe("MCP transport", () => {
  test("tools/list exposes all four deterministic tools, unconditionally (no write-gate — isolation is the safety boundary here, not a flag)", () => {
    const names = visibleTools().map((t) => t.name);
    expect(names).toEqual(["prepare_workspace", "finalize_handoff", "record_work_time", "bounce_to_pm"]);
  });

  test("initialize reports server identity", async () => {
    const res = await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect((res as { serverInfo: { name: string } }).serverInfo.name).toBe("marshall-builder");
  });
});
