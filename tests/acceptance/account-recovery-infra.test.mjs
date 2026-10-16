import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveEnvironment } from "../../dist/config/project.js";
import { SharedIdentityStack } from "../../dist/infra/lib/shared-identity-stack.js";
import { AccountStack } from "../../dist/infra/lib/account-stack.js";

const outputDirectory = mkdtempSync(path.join(tmpdir(), "multi-chatbot-recovery-"));
const templates = new Map();

beforeAll(() => {
  const app = new App({ outdir: outputDirectory });
  const stacks = new Map();
  for (const environment of ["dev", "prod"]) {
    const resolved = resolveEnvironment(environment, "docentes");
    const identity = new SharedIdentityStack(app, `${resolved.resourcePrefix}-identity`, resolved);
    const account = new AccountStack(
      app,
      `${resolved.botResourcePrefix}-account`,
      resolved,
      identity.userPool,
    );
    stacks.set(environment, { identity, account });
  }
  for (const [environment, { identity, account }] of stacks) {
    templates.set(environment, {
      identity: Template.fromStack(identity),
      account: Template.fromStack(account),
    });
  }
}, 60_000);

afterAll(() => rmSync(outputDirectory, { recursive: true, force: true }));

function onlyResource(template, resourceType) {
  const resources = Object.values(template.findResources(resourceType));
  expect(resources).toHaveLength(1);
  return resources[0].Properties;
}

describe("native password recovery configuration", () => {
  it("enables recovery only by verified email with the approved dev SES sender", () => {
    const pool = onlyResource(templates.get("dev").identity, "AWS::Cognito::UserPool");
    expect
      .soft(pool.AccountRecoverySetting?.RecoveryMechanisms)
      .toEqual([{ Name: "verified_email", Priority: 1 }]);
    expect.soft(pool.EmailConfiguration?.EmailSendingAccount).toBe("DEVELOPER");
    expect.soft(pool.EmailConfiguration?.From).toMatch(/(?:^|<)sxvintage@gmail\.com>?$/);

    // Keep account/region/identity assertions independent of CDK's intrinsic syntax.
    const sourceArn = JSON.stringify(pool.EmailConfiguration?.SourceArn ?? "");
    expect.soft(sourceArn).toContain(":ses:us-east-1:118903272638:identity/sxvintage@gmail.com");
    expect.soft(sourceArn).not.toContain("identity/gmail.com");
    expect.soft(sourceArn).not.toContain("*");
  });

  it("keeps prod synthesizable without inventing its deferred sender identity", () => {
    const pool = onlyResource(templates.get("prod").identity, "AWS::Cognito::UserPool");
    expect(pool.AccountRecoverySetting?.RecoveryMechanisms).toEqual([
      { Name: "admin_only", Priority: 1 },
    ]);
    expect(pool.EmailConfiguration).toBeUndefined();
  });

  it.each(["dev", "prod"])(
    "uses Cognito's existence suppression for the public %s account client",
    (environment) => {
      const client = onlyResource(
        templates.get(environment).account,
        "AWS::Cognito::UserPoolClient",
      );
      expect(client.PreventUserExistenceErrors).toBe("ENABLED");
    },
  );
});
