import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

export function makeSynthesisDirectory(environment) {
  return mkdtempSync(path.join(tmpdir(), `multi-chatbot-admin-${environment}-`));
}

export function synthesize(outputDirectory, environment) {
  return spawnSync(
    npmCommand,
    ["run", "synth", "--", "--output", outputDirectory, "-c", `environment=${environment}`],
    {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 90_000,
      env: {
        ...process.env,
        CDK_OUTDIR: outputDirectory,
        AWS_ACCESS_KEY_ID: "",
        AWS_SECRET_ACCESS_KEY: "",
        AWS_SESSION_TOKEN: "",
        AWS_EC2_METADATA_DISABLED: "true",
        AWS_CONFIG_FILE: path.join(outputDirectory, "no-aws-config"),
        AWS_SHARED_CREDENTIALS_FILE: path.join(outputDirectory, "no-aws-credentials"),
      },
    },
  );
}

export function commandOutput(result) {
  return [result?.error?.message, result?.stdout, result?.stderr].filter(Boolean).join("\n");
}

export function readAssembly(directory) {
  const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
  const stacks = Object.entries(manifest.artifacts || {})
    .filter(([, artifact]) => artifact.type === "aws:cloudformation:stack")
    .map(([key, artifact]) => ({
      id: artifact.id || key,
      artifact,
      environment: artifact.environment,
      template: JSON.parse(
        readFileSync(path.join(directory, artifact.properties.templateFile), "utf8"),
      ),
    }));
  const assetManifests = Object.entries(manifest.artifacts || {})
    .filter(([, artifact]) => artifact.type === "cdk:asset-manifest")
    .map(([artifactId, artifact]) => ({
      artifactId,
      manifest: JSON.parse(readFileSync(path.join(directory, artifact.properties.file), "utf8")),
    }));
  return { directory, manifest, stacks, assetManifests };
}

export function removeSynthesisDirectory(directory) {
  rmSync(directory, { recursive: true, force: true });
}

export function findStack(assembly, id) {
  return assembly?.stacks.find((stack) => stack.id === id);
}

export function records(stack, type) {
  if (!stack) return [];
  return Object.entries(stack.template.Resources || {})
    .filter(([, resource]) => !type || resource.Type === type)
    .map(([logicalId, resource]) => ({
      stack,
      logicalId,
      resource,
      properties: resource.Properties || {},
    }));
}

export function onlyRecord(stack, type, message = `expected one ${type}`) {
  const matches = records(stack, type);
  if (matches.length !== 1) throw new Error(`${message}; found ${matches.length}`);
  return matches[0];
}

export function sameStackReference(value, logicalId) {
  if (Array.isArray(value)) return value.some((child) => sameStackReference(child, logicalId));
  if (!value || typeof value !== "object") return false;
  const getAtt = value["Fn::GetAtt"];
  return (
    value.Ref === logicalId ||
    (Array.isArray(getAtt) && getAtt[0] === logicalId) ||
    (typeof getAtt === "string" && getAtt.split(".")[0] === logicalId) ||
    Object.entries(value).some(
      ([key, child]) => key !== "Fn::ImportValue" && sameStackReference(child, logicalId),
    )
  );
}

function directReference(value, logicalId) {
  if (Array.isArray(value)) return value.some((child) => directReference(child, logicalId));
  if (!value || typeof value !== "object") return false;
  const getAtt = value["Fn::GetAtt"];
  const substitution = value["Fn::Sub"];
  return (
    value.Ref === logicalId ||
    (Array.isArray(getAtt) && getAtt[0] === logicalId) ||
    (typeof getAtt === "string" && getAtt.split(".")[0] === logicalId) ||
    (typeof substitution === "string" && substitution.includes("${" + logicalId + ".")) ||
    Object.entries(value).some(
      ([key, child]) => key !== "Fn::ImportValue" && directReference(child, logicalId),
    )
  );
}

function exportReferences(value) {
  if (Array.isArray(value)) return value.flatMap(exportReferences);
  if (!value || typeof value !== "object") return [];
  const imports = [];
  if (Object.hasOwn(value, "Fn::ImportValue")) {
    imports.push({ kind: "export", value: value["Fn::ImportValue"] });
  }
  const output = value["Fn::GetStackOutput"];
  if (output && typeof output.StackName === "string" && typeof output.OutputName === "string") {
    imports.push({ kind: "stack-output", ...output });
  }
  return imports.length ? imports : Object.values(value).flatMap(exportReferences);
}

function outputRecords(assembly) {
  return assembly.stacks.flatMap((stack) =>
    Object.entries(stack.template.Outputs || {}).map(([logicalId, output]) => ({
      stack,
      logicalId,
      output,
    })),
  );
}

function findImportedOutput(reference, assembly, sourceStack) {
  if (reference.kind === "export") {
    return outputRecords(assembly).find(
      ({ output }) =>
        output.Export && JSON.stringify(output.Export.Name) === JSON.stringify(reference.value),
    );
  }
  const sourceCoordinates = /^aws:\/\/([^/]+)\/([^/]+)$/.exec(sourceStack.environment || "");
  return outputRecords(assembly).find(({ stack, logicalId }) => {
    if (stack.id !== reference.StackName || logicalId !== reference.OutputName) return false;
    const targetCoordinates = /^aws:\/\/([^/]+)\/([^/]+)$/.exec(stack.environment || "");
    return Boolean(
      sourceCoordinates &&
      targetCoordinates &&
      sourceCoordinates[1] === targetCoordinates[1] &&
      sourceCoordinates[2] === targetCoordinates[2] &&
      (reference.Region === undefined || reference.Region === targetCoordinates[2]),
    );
  });
}

function outputReferencesResource(
  outputRecord,
  targetStack,
  targetResource,
  assembly,
  seen = new Set(),
) {
  if (
    outputRecord.stack.id === targetStack.id &&
    directReference(outputRecord.output.Value, targetResource.logicalId)
  ) {
    return true;
  }
  const key = `${outputRecord.stack.id}:${outputRecord.logicalId}`;
  if (seen.has(key)) return false;
  const nextSeen = new Set(seen).add(key);
  return exportReferences(outputRecord.output.Value).some((reference) => {
    const next = findImportedOutput(reference, assembly, outputRecord.stack);
    return next && outputReferencesResource(next, targetStack, targetResource, assembly, nextSeen);
  });
}

export function referencesResource(value, valueStack, targetStack, targetResource, assembly) {
  if (valueStack.id === targetStack.id && directReference(value, targetResource.logicalId))
    return true;
  return exportReferences(value).some((reference) => {
    const output = findImportedOutput(reference, assembly, valueStack);
    return output && outputReferencesResource(output, targetStack, targetResource, assembly);
  });
}

export function assetManifestFor(assembly, stack) {
  return assembly.assetManifests.find(({ artifactId }) => artifactId === `${stack.id}.assets`)
    ?.manifest;
}

export function assetFiles(assembly, stack) {
  const manifest = assetManifestFor(assembly, stack);
  return Object.entries(manifest?.files || {}).map(([assetId, fileAsset]) => ({
    assetId,
    fileAsset,
    files: filesForAsset(assembly.directory, fileAsset),
  }));
}

export function resourceAsset(assembly, stack, value) {
  return resourceAssets(assembly, stack, value)[0];
}

export function resourceAssets(assembly, stack, value) {
  const serialized = JSON.stringify(value ?? null);
  return assetFiles(assembly, stack).filter(({ fileAsset }) =>
    Object.values(fileAsset.destinations || {}).some(
      ({ objectKey }) => typeof objectKey === "string" && serialized.includes(objectKey),
    ),
  );
}

export function readAssetFile(file) {
  if (file.archivePath) {
    const result = spawnSync("unzip", ["-p", file.path, file.archivePath], { encoding: "utf8" });
    return result.status === 0 ? result.stdout : "";
  }
  return readFileSync(file.path, "utf8");
}

function filesForAsset(directory, fileAsset) {
  const sourcePath = fileAsset.source?.path;
  if (typeof sourcePath !== "string") return [];
  const resolved = path.resolve(directory, sourcePath);
  const relative = path.relative(directory, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !existsSync(resolved)) return [];
  if (statSync(resolved).isDirectory()) return listFiles(resolved);
  const listing = spawnSync("unzip", ["-Z1", resolved], { encoding: "utf8" });
  if (listing.status !== 0) return [{ path: resolved, relativePath: path.basename(resolved) }];
  return listing.stdout
    .split(/\r?\n/)
    .filter((name) => name && !name.endsWith("/"))
    .map((name) => ({ path: resolved, relativePath: name, archivePath: name }));
}

function listFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix ? path.posix.join(prefix, entry.name) : entry.name;
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) return listFiles(resolved, relativePath);
    return entry.isFile() ? [{ path: resolved, relativePath }] : [];
  });
}

export function sourceMarker(contents, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = contents.match(
    new RegExp(`"${escaped}"\\s*:\\s*(?:"(<<marker:0xbaba:\\d+>>)"|(<<marker:0xbaba:\\d+>>))`),
  );
  return match?.[1] || match?.[2];
}

export function markerValue(stack, marker) {
  return records(stack, "Custom::CDKBucketDeployment")
    .flatMap(({ properties }) => properties.SourceMarkers || [])
    .flatMap((markers) => Object.entries(markers))
    .find(([name]) => name === marker)?.[1];
}

export function lambdaPolicies(stack, lambda) {
  const roles = records(stack, "AWS::IAM::Role").filter(({ logicalId }) =>
    sameStackReference(lambda.properties.Role, logicalId),
  );
  const inline = roles.flatMap(({ properties }) => properties.Policies || []);
  const attached = records(stack, "AWS::IAM::Policy")
    .filter(({ properties }) =>
      roles.some(({ logicalId }) => sameStackReference(properties.Roles, logicalId)),
    )
    .flatMap(({ properties }) => properties.PolicyDocument?.Statement || []);
  return {
    roles,
    statements: [
      ...inline.flatMap((policy) => policy.PolicyDocument?.Statement || []),
      ...attached,
    ],
  };
}

export function statementActions(statement) {
  return (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).filter(
    (action) => typeof action === "string",
  );
}

export function tags(resource) {
  const value = resource.Properties?.Tags || resource.Properties?.UserPoolTags || [];
  if (Array.isArray(value)) return value.map(({ Key, Value }) => [Key, Value]);
  return Object.entries(value);
}

export function dependencies(assembly, stack) {
  return new Set(assembly.manifest.artifacts[stack.id]?.dependencies || []);
}
