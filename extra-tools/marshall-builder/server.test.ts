import { describe, expect, test } from "bun:test";
import {
  bounceToPm,
  branchNameForTask,
  branchSlug,
  buildReviewRows,
  buildShipRow,
  receiptsMissingFromTree,
  restampMetaCovers,
  restampScreenshotsCovers,
  formatNeedsInputNote,
  gitConfigEntries,
  handleRequest,
  planHandoff,
  pmUserIdFor,
  postAcEvidence,
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
      expect(resolveCatalogProject(key).git_url).toBe("https://github.com/partnerprogrammer/breez-brain.git");
    }
  });

  test("resolves pp-stack as its own standalone repo (pp-marshall App access approved 2026-08-26, CUP-4838)", () => {
    const project = resolveCatalogProject("pp-stack");
    expect(project.git_url).toBe("https://github.com/partnerprogrammer/pp-stack.git");
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

describe("gitConfigEntries", () => {
  test("always configures credential helper and commit identity (first live build needed both set by hand — CUP-4918)", () => {
    const keys = gitConfigEntries().map(([k]) => k);
    expect(keys).toContain("credential.helper");
    expect(keys).toContain("user.name");
    expect(keys).toContain("user.email");
    expect(keys).not.toContain("http.sslCAInfo");
  });

  test("points git at the gateway CA when SSL_CERT_FILE is present (git ignores that env var natively)", () => {
    const entries = gitConfigEntries({ sslCertFile: "/tmp/onecli-combined-ca.pem" });
    expect(entries).toContainEqual(["http.sslCAInfo", "/tmp/onecli-combined-ca.pem"]);
  });

  test("commits as the pp-marshall App's bot user — the noreply email is what makes GitHub attribute name/avatar/[bot] badge", () => {
    const entries = gitConfigEntries();
    expect(entries).toContainEqual(["user.name", "pp-marshall[bot]"]);
    expect(entries).toContainEqual(["user.email", "277097953+pp-marshall[bot]@users.noreply.github.com"]);
  });
});

describe("evidence receipts (Phase A helpers)", () => {
  const SHA = "a".repeat(40);

  test("branchSlug mirrors pp-pr-evidence's rule ('/' -> '-', strip odd chars)", () => {
    expect(branchSlug("marshall/cup-4966")).toBe("marshall-cup-4966");
    expect(branchSlug("weird/br@nch name")).toBe("weird-brnchname");
  });

  test("buildShipRow binds to HEAD and records the agent's attestation verbatim", () => {
    const row = buildShipRow({ branch: "marshall/cup-1", headSha: SHA, verification: "tsc clean, 12 tests" });
    expect(row.skill).toBe("ship");
    expect(row.commit_full).toBe(SHA);
    expect(row.verification_result).toBe("tsc clean, 12 tests");
    expect(row.via).toBe("marshall-builder");
  });

  test("restampMetaCovers rewrites covers_sha and keeps the rest", () => {
    const out = JSON.parse(restampMetaCovers(JSON.stringify({ covers_sha: "old", pr: 5 }), SHA));
    expect(out.covers_sha).toBe(SHA);
    expect(out.pr).toBe(5);
  });

  test("buildReviewRows emits gstack-shaped rows bound to HEAD, and nothing when no review is attested (never fabricates)", () => {
    expect(buildReviewRows(undefined, "marshall/cup-1", SHA)).toEqual([]);
    const rows = buildReviewRows(
      {
        code_review: { status: "pass-with-fixes", issues_found: 2, critical: 0, findings: ["off-by-one in week window — fixed"] },
        adversarial_review: { status: "pass", gate: "code" },
      },
      "marshall/cup-1",
      SHA
    );
    expect(rows.map((r) => r.skill)).toEqual(["review", "adversarial-review"]);
    expect(rows[0].commit_full).toBe(SHA);
    expect(rows[0].issues_found).toBe(2);
    expect(rows[1].gate).toBe("code");
    expect(rows.every((r) => r.via === "marshall-builder")).toBe(true);
  });

  test("buildReviewRows emits only the attested review when the other did not run", () => {
    const rows = buildReviewRows({ adversarial_review: { status: "pass" } }, "marshall/cup-1", SHA);
    expect(rows).toHaveLength(1);
    expect(rows[0].skill).toBe("adversarial-review");
    expect(rows[0].gate).toBeNull();
  });

  test("receiptsMissingFromTree requires all four receipts tracked at HEAD (PR #129: uncommitted disk copies must not count)", () => {
    const tree = [
      ".pp-stack/updates/marshall-cup-4983/ship.json",
      ".pp-stack/updates/marshall-cup-4983/message.txt",
      ".pp-stack/updates/marshall-cup-4983/meta.json",
      ".pp-stack/updates/marshall-cup-4983/screenshots.md",
    ].join("\n");
    expect(receiptsMissingFromTree(tree)).toEqual([]);
  });

  test("receiptsMissingFromTree names exactly what the pushed branch lacks", () => {
    expect(receiptsMissingFromTree(".pp-stack/updates/marshall-cup-4983/ship.json\n")).toEqual([
      "message.txt",
      "meta.json",
      "screenshots.md",
    ]);
    expect(receiptsMissingFromTree("")).toEqual(["ship.json", "message.txt", "meta.json", "screenshots.md"]);
  });

  test("restampScreenshotsCovers replaces an existing Covers line or prepends one", () => {
    expect(restampScreenshotsCovers(`Covers: ${"b".repeat(40)}\n\nNo UI touched.`, SHA)).toContain(`Covers: ${SHA}`);
    const prepended = restampScreenshotsCovers("No UI touched.", SHA);
    expect(prepended.startsWith(`Covers: ${SHA}`)).toBe(true);
    expect(prepended).toContain("No UI touched.");
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

describe("postAcEvidence", () => {
  test("posts the evidence comment on the task it is building", async () => {
    const f = fakeFetch({ "/task/": task() });
    const result = await postAcEvidence({ task_id: "CUP-4983", markdown: "**AC1** — Points card renders. [My Workload](https://hub.example/dashboard/my-workload)" }, f);
    expect(result).toContain("evidence comment posted on CUP-4702");
  });
});

describe("MCP transport", () => {
  test("tools/list exposes all five deterministic tools, unconditionally (no write-gate — isolation is the safety boundary here, not a flag)", () => {
    const names = visibleTools().map((t) => t.name);
    expect(names).toEqual(["prepare_workspace", "finalize_handoff", "post_ac_evidence", "record_work_time", "bounce_to_pm"]);
  });

  test("initialize reports server identity", async () => {
    const res = await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect((res as { serverInfo: { name: string } }).serverInfo.name).toBe("marshall-builder");
  });
});
