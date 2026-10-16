import { describe, expect, it } from "vitest";

async function loadProjectConfig() {
  return import("../../config/project.ts");
}

describe("shared project and environment configuration", () => {
  it("keeps the confirmed account, region, and model choices", async () => {
    const { projectConfig } = await loadProjectConfig();
    expect(projectConfig).toMatchObject({
      account: "118903272638",
      region: "us-east-1",
      initialModelId: "anthropic.claude-sonnet-4-6",
    });
    expect([...projectConfig.desiredModelIds].sort()).toEqual(
      ["anthropic.claude-haiku-5-5", "openai.gpt-6-luna"].sort(),
    );
  });

  it("resolves dev and prod with distinct resources and the correct AWS environment tags", async () => {
    const { resolveEnvironment } = await loadProjectConfig();
    const dev = resolveEnvironment("dev");
    const prod = resolveEnvironment("prod");

    expect(dev).toMatchObject({
      account: "118903272638",
      region: "us-east-1",
      environment: "dev",
      initialModelId: "anthropic.claude-sonnet-4-6",
      tags: { environment: "dev" },
    });
    expect(prod).toMatchObject({
      account: "118903272638",
      region: "us-east-1",
      environment: "prod",
      initialModelId: "anthropic.claude-sonnet-4-6",
      tags: { environment: "prod" },
    });
    expect(dev).not.toHaveProperty("botId");
    expect(dev).not.toHaveProperty("botResourcePrefix");
    expect(dev.resourcePrefix).not.toBe(prod.resourcePrefix);
    expect(dev.resourcePrefix).toEqual(expect.any(String));
    expect(prod.resourcePrefix).toEqual(expect.any(String));
  });

  it("derives distinct per-bot prefixes for two botIds in both environments", async () => {
    const { resolveEnvironment } = await loadProjectConfig();
    const botIds = ["example-a", "example-b"];
    const resolved = ["dev", "prod"].flatMap((environment) =>
      botIds.map((botId) => resolveEnvironment(environment, botId)),
    );
    const botPrefixes = resolved.map(({ botResourcePrefix }) => botResourcePrefix);

    expect(resolved.every(({ botId }) => botIds.includes(botId))).toBe(true);
    expect(botPrefixes).toHaveLength(4);
    expect(new Set(botPrefixes).size).toBe(4);
    for (const entry of resolved) {
      expect(entry.botResourcePrefix).toBe(`${entry.resourcePrefix}-${entry.botId}`);
    }
  });

  it("rejects an unknown environment", async () => {
    const { resolveEnvironment } = await loadProjectConfig();
    expect(() => resolveEnvironment("test")).toThrow();
  });

  it.each(["", "../prod"])("rejects an invalid botId (%s)", async (botId) => {
    const { resolveEnvironment } = await loadProjectConfig();
    expect(() => resolveEnvironment("dev", botId)).toThrow();
  });
});
