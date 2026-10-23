import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { resolveEnvironment } from "../../config/project.ts";
import { DocumentInfrastructure } from "../../infra/lib/documents.ts";

function onlyResource(template, type) {
  const matches = Object.entries(template.Resources || {}).filter(
    ([, resource]) => resource.Type === type,
  );
  expect(matches, `expected one ${type}`).toHaveLength(1);
  return matches[0];
}

function logicalIdFromGetAtt(reference) {
  const getAtt = reference?.["Fn::GetAtt"];
  if (Array.isArray(getAtt)) return getAtt[0];
  if (typeof getAtt === "string") return getAtt.split(".")[0];
  return undefined;
}

describe("document infrastructure implementation regressions", () => {
  it("uses one S3 Vectors index selector and waits for the KB role policy", () => {
    const app = new App();
    const environment = resolveEnvironment("dev", "documents-regression");
    const stack = new Stack(app, "DocumentInfrastructureRegression", {
      env: { account: environment.account, region: environment.region },
    });

    new DocumentInfrastructure(stack, "Documents", environment);

    const template = Template.fromStack(stack).toJSON();
    const [, knowledgeBase] = onlyResource(template, "AWS::Bedrock::KnowledgeBase");
    const [vectorIndexLogicalId] = onlyResource(template, "AWS::S3Vectors::Index");
    const vectorConfiguration =
      knowledgeBase.Properties.StorageConfiguration.S3VectorsConfiguration;

    // Bedrock accepts either IndexArn or IndexName in this configuration, not both.
    expect(vectorConfiguration.IndexArn).toBeDefined();
    expect(vectorConfiguration.IndexName).toBeUndefined();
    expect(vectorConfiguration.IndexArn["Fn::GetAtt"]).toEqual([vectorIndexLogicalId, "IndexArn"]);

    const knowledgeBaseRoleId = logicalIdFromGetAtt(knowledgeBase.Properties.RoleArn);
    expect(knowledgeBaseRoleId).toBeDefined();
    if (!knowledgeBaseRoleId) return;

    const knowledgeBasePolicies = Object.entries(template.Resources || {}).filter(
      ([, resource]) =>
        resource.Type === "AWS::IAM::Policy" &&
        JSON.stringify(resource.Properties?.Roles || []).includes(knowledgeBaseRoleId),
    );
    expect(knowledgeBasePolicies.length).toBeGreaterThan(0);

    const dependencies = Array.isArray(knowledgeBase.DependsOn)
      ? knowledgeBase.DependsOn
      : [knowledgeBase.DependsOn].filter(Boolean);
    expect(dependencies).toEqual(
      expect.arrayContaining(knowledgeBasePolicies.map(([logicalId]) => logicalId)),
    );
  });
});
