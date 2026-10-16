import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const siteEntry = path.join(projectRoot, "web/index.html");
const siteOutput = path.join(projectRoot, "dist/web");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const fixtureMarkers = [
  "Multi-chatbot web fixture",
  "fixture-react-acceptance",
  "fixture-greeting",
];
let webBuildResult;
let builtSiteFiles;

function commandOutput(result) {
  return [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n");
}

function buildWebsite() {
  rmSync(siteOutput, { recursive: true, force: true });
  return spawnSync(npmCommand, ["run", "build:web"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 90_000,
  });
}

function outputPath(reference) {
  const pathname = new URL(reference, "https://public-site-acceptance.invalid").pathname;
  return path.posix.normalize(decodeURIComponent(pathname).replace(/^\/+/, ""));
}

function collectBuiltSiteFiles() {
  const indexPath = path.join(siteOutput, "index.html");
  if (!existsSync(indexPath)) return null;

  const html = readFileSync(indexPath);
  const references = [
    ...html.toString("utf8").matchAll(/(?:src|href)="([^"]+\.(?:js|css)(?:\?[^"]*)?)"/g),
  ].map((match) => match[1]);
  const files = [{ relativePath: "index.html", contents: html }];

  for (const reference of references) {
    const relativePath = outputPath(reference);
    const filePath = path.join(siteOutput, ...relativePath.split("/"));
    if (!existsSync(filePath) || !statSync(filePath).isFile() || statSync(filePath).size === 0) {
      return null;
    }
    files.push({ relativePath, contents: readFileSync(filePath) });
  }

  return files;
}

function packagedSiteAsset(outputDirectory, expectedFiles) {
  if (!expectedFiles) return undefined;
  const manifest = JSON.parse(readFileSync(path.join(outputDirectory, "manifest.json"), "utf8"));
  const assetManifests = Object.values(manifest.artifacts || {}).filter(
    (artifact) => artifact.type === "cdk:asset-manifest",
  );

  for (const artifact of assetManifests) {
    const assetManifest = JSON.parse(
      readFileSync(path.join(outputDirectory, artifact.properties.file), "utf8"),
    );
    for (const fileAsset of Object.values(assetManifest.files || {})) {
      if (fileAsset.source?.packaging !== "zip") continue;
      const assetPath = path.resolve(outputDirectory, fileAsset.source.path);
      const relativeAssetPath = path.relative(outputDirectory, assetPath);
      if (relativeAssetPath.startsWith("..") || path.isAbsolute(relativeAssetPath)) continue;
      if (!existsSync(assetPath) || !statSync(assetPath).isDirectory()) continue;

      const containsExactBuildFiles = expectedFiles.every(({ relativePath, contents }) => {
        const stagedPath = path.join(assetPath, ...relativePath.split("/"));
        return existsSync(stagedPath) && readFileSync(stagedPath).equals(contents);
      });
      if (containsExactBuildFiles) {
        return { fileAsset };
      }
    }
  }
  return undefined;
}

function synthesize(outputDirectory, environment) {
  return spawnSync(
    npmCommand,
    ["run", "synth", "--", "--output", outputDirectory, "-c", `environment=${environment}`],
    {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 60_000,
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

function readAssembly(outputDirectory) {
  const manifest = JSON.parse(readFileSync(path.join(outputDirectory, "manifest.json"), "utf8"));
  const stacks = Object.entries(manifest.artifacts || {})
    .filter(([, artifact]) => artifact.type === "aws:cloudformation:stack")
    .map(([key, artifact]) => ({
      id: artifact.id || key,
      environment: artifact.environment,
      template: JSON.parse(
        readFileSync(path.join(outputDirectory, artifact.properties.templateFile), "utf8"),
      ),
    }));
  const resources = stacks.flatMap((stack) =>
    Object.entries(stack.template.Resources || {}).map(([logicalId, resource]) => ({
      stack,
      logicalId,
      resource,
    })),
  );
  return { stacks, resources };
}

function referencesLogicalId(value, logicalId) {
  return JSON.stringify(value).includes(logicalId);
}

function siteResources(assembly) {
  const buckets = assembly.resources.filter(({ resource }) => resource.Type === "AWS::S3::Bucket");
  const distributions = assembly.resources.filter(
    ({ resource }) => resource.Type === "AWS::CloudFront::Distribution",
  );
  const websiteBuckets = buckets.filter((bucket) =>
    distributions.some(({ resource }) => {
      const origins = resource.Properties?.DistributionConfig?.Origins || [];
      return origins.some((origin) => referencesLogicalId(origin.DomainName, bucket.logicalId));
    }),
  );
  const websiteDistributions = distributions.filter(({ resource }) => {
    const origins = resource.Properties?.DistributionConfig?.Origins || [];
    return origins.some((origin) =>
      websiteBuckets.some((bucket) => referencesLogicalId(origin.DomainName, bucket.logicalId)),
    );
  });
  return { buckets: websiteBuckets, distributions: websiteDistributions };
}

function tagPairs(tags) {
  return (Array.isArray(tags) ? tags : tags?.Items || [])
    .filter((tag) => typeof tag.Key === "string")
    .map(({ Key, Value }) => [Key, Value]);
}

function publishesAssetToWebsiteBucket(assembly, fileAsset, bucket) {
  const objectKeys = Object.values(fileAsset.destinations || {})
    .map(({ objectKey }) => objectKey)
    .filter((objectKey) => typeof objectKey === "string");
  return assembly.resources.some(({ resource }) => {
    return (
      resource.Type === "Custom::CDKBucketDeployment" &&
      referencesLogicalId(resource.Properties?.DestinationBucketName, bucket.logicalId) &&
      objectKeys.some((objectKey) =>
        referencesLogicalId(resource.Properties?.SourceObjectKeys, objectKey),
      )
    );
  });
}

beforeAll(() => {
  webBuildResult = buildWebsite();
  builtSiteFiles = collectBuiltSiteFiles();
}, 120_000);

describe("public website CDK assets and hosting", () => {
  it("builds web/index.html and its real assets into dist/web, not the tooling fixture", () => {
    expect(webBuildResult?.status, commandOutput(webBuildResult || {})).toBe(0);
    expect(existsSync(siteEntry), "Expected the product Vite entry at web/index.html").toBe(true);
    expect(builtSiteFiles, "Expected dist/web/index.html and its referenced assets").not.toBeNull();
    if (!builtSiteFiles) return;

    expect(builtSiteFiles.length).toBeGreaterThan(1);
    for (const file of builtSiteFiles) {
      const text = file.contents.toString("utf8");
      for (const marker of fixtureMarkers) expect(text).not.toContain(marker);
    }
  }, 120_000);

  it("synthesizes separated dev and prod S3/CloudFront sites with the built assets", () => {
    const environments = [];
    for (const environment of ["dev", "prod"]) {
      const outputDirectory = mkdtempSync(
        path.join(tmpdir(), `multi-chatbot-site-${environment}-`),
      );
      try {
        const result = synthesize(outputDirectory, environment);
        expect.soft(webBuildResult?.status, commandOutput(webBuildResult || {})).toBe(0);
        expect.soft(result.status, commandOutput(result)).toBe(0);
        if (result.status !== 0) {
          environments.push({ stackIds: [], bucketIds: [], bucketNames: [] });
          continue;
        }

        const assembly = readAssembly(outputDirectory);
        expect(assembly.stacks.length).toBeGreaterThan(0);
        for (const stack of assembly.stacks) {
          expect(stack.environment).toBe("aws://118903272638/us-east-1");
        }

        const site = siteResources(assembly);
        expect
          .soft(site.buckets.length, `expected an S3 site origin for ${environment}`)
          .toBeGreaterThan(0);
        expect
          .soft(site.distributions.length, `expected CloudFront for ${environment}`)
          .toBeGreaterThan(0);
        if (site.buckets.length === 0 || site.distributions.length === 0) {
          environments.push({ stackIds: [], bucketIds: [], bucketNames: [] });
          continue;
        }

        const siteRecords = [...site.buckets, ...site.distributions];
        for (const record of siteRecords) {
          expect(record.stack.environment).toBe("aws://118903272638/us-east-1");
          const tags = tagPairs(record.resource.Properties?.Tags);
          expect.soft(tags).toContainEqual(["project", "multi-chatbot"]);
          expect
            .soft(tags.filter(([key]) => key === "environment"))
            .toEqual([["environment", environment]]);
        }

        expect
          .soft(
            siteRecords.some((record) =>
              [record.stack.id, record.logicalId, record.resource.Metadata?.["aws:cdk:path"] || ""]
                .join(" ")
                .toLowerCase()
                .includes("docentes"),
            ),
            "expected site resources to identify the first chatbot as docentes",
          )
          .toBe(true);

        for (const { resource } of site.distributions) {
          const configuration = resource.Properties?.DistributionConfig || {};
          const origins = configuration.Origins || [];
          const behavior = configuration.DefaultCacheBehavior || {};
          const targetOrigin = origins.find((origin) => origin.Id === behavior.TargetOriginId);
          expect.soft(configuration.Enabled).toBe(true);
          expect.soft(targetOrigin).toBeDefined();
          expect
            .soft(
              site.buckets.some(
                (bucket) =>
                  targetOrigin && referencesLogicalId(targetOrigin.DomainName, bucket.logicalId),
              ),
            )
            .toBe(true);
          expect.soft(["https-only", "redirect-to-https"]).toContain(behavior.ViewerProtocolPolicy);
          for (const cacheBehavior of configuration.CacheBehaviors || []) {
            expect
              .soft(["https-only", "redirect-to-https"])
              .toContain(cacheBehavior.ViewerProtocolPolicy);
          }
        }

        const asset = packagedSiteAsset(outputDirectory, builtSiteFiles);
        expect.soft(asset, `expected dist/web assets in the ${environment} assembly`).toBeDefined();
        if (asset) {
          expect
            .soft(
              site.buckets.some((bucket) =>
                publishesAssetToWebsiteBucket(assembly, asset.fileAsset, bucket),
              ),
              `expected the ${environment} assembly asset to target its website bucket`,
            )
            .toBe(true);
        }

        environments.push({
          stackIds: [...new Set(siteRecords.map((record) => record.stack.id))],
          bucketIds: site.buckets.map(({ stack, logicalId }) => `${stack.id}/${logicalId}`),
          bucketNames: site.buckets
            .map(({ resource }) => resource.Properties?.BucketName)
            .filter((bucketName) => bucketName !== undefined)
            .map((bucketName) => JSON.stringify(bucketName)),
        });
      } finally {
        rmSync(outputDirectory, { recursive: true, force: true });
      }
    }

    expect(environments).toHaveLength(2);
    expect(environments[0].stackIds.length).toBeGreaterThan(0);
    expect(environments[1].stackIds.length).toBeGreaterThan(0);
    expect(environments[0].stackIds.some((id) => environments[1].stackIds.includes(id))).toBe(
      false,
    );
    expect(environments[0].bucketIds.length).toBeGreaterThan(0);
    expect(environments[1].bucketIds.length).toBeGreaterThan(0);
    expect(environments[0].bucketIds.some((id) => environments[1].bucketIds.includes(id))).toBe(
      false,
    );
    expect(
      environments[0].bucketNames.some((name) => environments[1].bucketNames.includes(name)),
    ).toBe(false);
  }, 180_000);
});
