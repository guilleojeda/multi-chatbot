import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const clientPath = fileURLToPath(new URL("../../web/api.ts", import.meta.url));
const config = { apiBaseUrl: "/api" };
const draft = {
  fields: { educationLevels: ["secundario"], subjects: ["Física, química y ambiente"] },
  responsePreferenceIds: [],
};

async function client() {
  expect(existsSync(clientPath), "Expected the shared HTTP client at web/api.ts").toBe(true);
  return import(pathToFileURL(clientPath).href);
}

function session() {
  return {
    accessToken: () => "old-access",
    restore: vi.fn(async () => ({ accessToken: "renewed-access" })),
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("the shared authenticated profile HTTP client", () => {
  it("sends an explicit complete PUT with bearer and no-store, without prompt text", async () => {
    const { requestWithRefresh } = await client();
    const fetch = vi.fn(async () => response({ saved: true }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      requestWithRefresh(config, session(), "/profile", { method: "PUT", body: draft }, () => true),
    ).resolves.toEqual({ saved: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/profile");
    expect(init.method).toBe("PUT");
    expect(init.cache).toBe("no-store");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer old-access");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(draft);
  });

  it("refreshes once after 401 and repeats the same complete save with the new bearer", async () => {
    const { requestWithRefresh } = await client();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({ saved: true }));
    vi.stubGlobal("fetch", fetch);
    const current = session();
    await expect(
      requestWithRefresh(config, current, "/profile", { method: "PUT", body: draft }, () => true),
    ).resolves.toEqual({ saved: true });
    expect(current.restore).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].body).toBe(fetch.mock.calls[0][1].body);
    expect(new Headers(fetch.mock.calls[1][1].headers).get("authorization")).toBe(
      "Bearer renewed-access",
    );
  });

  it("does not renew repeatedly when the second request also returns 401", async () => {
    const { requestWithRefresh } = await client();
    const fetch = vi.fn(async () => response({}, 401));
    vi.stubGlobal("fetch", fetch);
    const current = session();
    await expect(
      requestWithRefresh(config, current, "/profile", { method: "PUT", body: draft }, () => true),
    ).rejects.toMatchObject({ status: 401 });
    expect(current.restore).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not refresh a request whose view is already inactive", async () => {
    const { requestWithRefresh } = await client();
    const fetch = vi.fn(async () => response({}, 401));
    vi.stubGlobal("fetch", fetch);
    const current = session();
    await expect(
      requestWithRefresh(config, current, "/profile", {}, () => false),
    ).rejects.toMatchObject({ status: 401 });
    expect(current.restore).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not repeat a save when navigation or logout invalidates the view during refresh", async () => {
    const { requestWithRefresh } = await client();
    let active = true;
    const current = session();
    current.restore.mockImplementation(async () => {
      active = false;
      return { accessToken: "late-access" };
    });
    const fetch = vi.fn(async () => response({}, 401));
    vi.stubGlobal("fetch", fetch);
    await expect(
      requestWithRefresh(config, current, "/profile", { method: "PUT", body: draft }, () => active),
    ).rejects.toMatchObject({ status: 401 });
    expect(current.restore).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([400, 403, 413, 503])(
    "preserves status/code/affected fields for %i without automatic retry",
    async (status) => {
      const { requestWithRefresh } = await client();
      const fetch = vi.fn(async () =>
        response({ code: "PROFILE_FAILURE", fields: ["subjects"] }, status),
      );
      vi.stubGlobal("fetch", fetch);
      const current = session();
      await expect(
        requestWithRefresh(config, current, "/profile", { method: "PUT", body: draft }, () => true),
      ).rejects.toMatchObject({ status, code: "PROFILE_FAILURE", fields: ["subjects"] });
      expect(current.restore).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("reports an unconfirmed network save without retrying it", async () => {
    const { requestWithRefresh } = await client();
    const fetch = vi.fn(async () => {
      throw new Error("connection lost after dispatch");
    });
    vi.stubGlobal("fetch", fetch);
    const current = session();
    await expect(
      requestWithRefresh(config, current, "/profile", { method: "PUT", body: draft }, () => true),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR", status: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(current.restore).not.toHaveBeenCalled();
  });

  it("rejects a successful HTTP response containing invalid JSON without retrying", async () => {
    const { requestWithRefresh } = await client();
    const fetch = vi.fn(async () => new Response("invalid-json", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      requestWithRefresh(config, session(), "/profile", { method: "PUT", body: draft }, () => true),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not contact the API without an access token", async () => {
    const { requestWithRefresh } = await client();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const current = session();
    current.accessToken = () => null;
    await expect(
      requestWithRefresh(config, current, "/profile", {}, () => true),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetch).not.toHaveBeenCalled();
    expect(current.restore).not.toHaveBeenCalled();
  });
});
