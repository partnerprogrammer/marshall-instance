import { describe, expect, test } from "bun:test";
import { buildDispatchUpdate, callTool, confirmBuild, handleRequest, visibleTools } from "./server";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

const HUB = "https://pp-hub.example.com";

describe("confirmBuild", () => {
  test("throws when task_id is missing", async () => {
    await expect(confirmBuild({ task_id: "" }, fakeFetch(201, {}), HUB)).rejects.toThrow(/task_id is required/);
  });

  test("throws a clear error when the hub base URL isn't configured", async () => {
    await expect(confirmBuild({ task_id: "868x" }, fakeFetch(201, {}), "")).rejects.toThrow(/MARSHALL_HUB_BASE_URL/);
  });

  test("reports the job id on a fresh enqueue", async () => {
    const result = await confirmBuild({ task_id: "868x", custom_id: "CUP-1" }, fakeFetch(201, { ok: true, jobId: "job-1" }), HUB);
    expect(result).toContain("job-1");
    expect(result).toContain('send_message(to="MarshallBuilder")');
  });

  test("reports dedup without erroring when a job already exists", async () => {
    const result = await confirmBuild({ task_id: "868x" }, fakeFetch(200, { ok: true, jobId: "job-1", deduped: true }), HUB);
    expect(result).toContain("Already queued");
  });

  test("surfaces an actionable hint on 401 (misconfigured vault entry)", async () => {
    await expect(confirmBuild({ task_id: "868x" }, fakeFetch(401, { error: "Unauthorized" }), HUB)).rejects.toThrow(/OneCLI vault/);
  });
});

describe("buildDispatchUpdate", () => {
  test("enforces todo + Marshall assignment on every dispatch", () => {
    const body = buildDispatchUpdate();
    expect(body.status).toBe("todo");
    expect(body.assignees).toEqual({ add: [87419960] });
    expect(body.time_estimate).toBeUndefined();
  });

  test("converts the estimate to milliseconds when given", () => {
    expect(buildDispatchUpdate(90).time_estimate).toBe(90 * 60_000);
  });

  test("ignores zero/negative estimates instead of writing garbage", () => {
    expect(buildDispatchUpdate(0).time_estimate).toBeUndefined();
    expect(buildDispatchUpdate(-5).time_estimate).toBeUndefined();
  });
});

describe("MCP transport", () => {
  test("tools/list exposes confirm_build", () => {
    expect(visibleTools().map((t) => t.name)).toEqual(["confirm_build"]);
  });

  test("initialize reports server identity", async () => {
    const res = await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect((res as { serverInfo: { name: string } }).serverInfo.name).toBe("marshall-build-queue");
  });

  test("callTool wraps handler errors as isError content, not a throw", async () => {
    const result = await callTool("confirm_build", { task_id: "" }, fakeFetch(201, {}));
    expect(result.isError).toBe(true);
  });
});
