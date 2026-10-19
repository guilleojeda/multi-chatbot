import { afterEach, describe, expect, it, vi } from "vitest";
import { requestWithRefresh } from "../../web/api.ts";
import { SessionError } from "../../web/session.ts";

afterEach(() => vi.unstubAllGlobals());

describe("profile request refresh failures", () => {
  it("marks a rejected refresh and never retries the protected request", async () => {
    const session = {
      accessToken: () => "expired-access",
      restore: vi.fn(async () => {
        throw new SessionError("NETWORK_ERROR", "Refresh could not connect.");
      }),
    };
    const fetch = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      requestWithRefresh(
        {
          region: "test",
          userPoolId: "pool",
          clientId: "client",
          apiBaseUrl: "/api",
          botId: "bot",
        },
        session,
        "/profile",
        {},
        () => true,
      ),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR", status: 0, refreshFailed: true });

    expect(session.restore).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
