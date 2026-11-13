import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { phase11BotId, phase11Now } from "../support/phase11-documents-backend.mjs";

const s3ClientPackage = "@aws-sdk/client-s3";
const s3PostPackage = "@aws-sdk/s3-presigned-post";

async function loadSignerFactory() {
  const module = await import("../../api/document-aws-adapters.ts");
  expect(
    typeof module.createDocumentUploadSigner,
    "Expected the production api/document-aws-adapters.ts#createDocumentUploadSigner factory",
  ).toBe("function");

  // These imports are deliberately dynamic so absent product dependencies fail inside this case,
  // rather than hiding the result behind a test-collection error or an alias/mock signer.
  const [{ S3Client }, postSdk] = await Promise.all([
    import(s3ClientPackage),
    import(s3PostPackage),
  ]);
  expect(typeof postSdk.createPresignedPost).toBe("function");
  return { createDocumentUploadSigner: module.createDocumentUploadSigner, S3Client };
}

function conditionHas(policy, field, expectedValue) {
  return policy.conditions.some((condition) => {
    if (Array.isArray(condition)) {
      return (
        condition[0] === "eq" && condition[1] === `$${field}` && condition[2] === expectedValue
      );
    }
    return condition && typeof condition === "object" && condition[field] === expectedValue;
  });
}

function parsePolicy(upload) {
  const policyField = Object.entries(upload.fields).find(
    ([name]) => name.toLowerCase() === "policy",
  )?.[1];
  expect(typeof policyField).toBe("string");
  return JSON.parse(Buffer.from(policyField, "base64").toString("utf8"));
}

describe("the production S3 POST signer", () => {
  it("signs exact bucket, key, SHA-256, content type, size, and the earlier credential/token expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(phase11Now));
    let s3Client;
    try {
      const { createDocumentUploadSigner, S3Client } = await loadSignerFactory();
      const credentialExpiresAt = phase11Now + 120_000;
      s3Client = new S3Client({
        region: "us-east-1",
        credentials: {
          accessKeyId: "AKIATESTDOCUMENTS",
          secretAccessKey: "synthetic-test-secret",
          sessionToken: "synthetic-session-token",
          expiration: new Date(credentialExpiresAt),
        },
      });
      const signer = createDocumentUploadSigner({
        s3Client,
        now: () => phase11Now,
      });
      const fileBytes = Buffer.from("Prepared document content", "utf8");
      const sha256Hex = createHash("sha256").update(fileBytes).digest("hex");
      const checksumBase64 = Buffer.from(sha256Hex, "hex").toString("base64");
      const input = {
        bucket: "temporary-docentes",
        key: `incoming/${phase11BotId}/operation-1/lesson.txt`,
        name: "lesson.txt",
        sizeBytes: fileBytes.byteLength,
        sha256: sha256Hex,
        contentType: "text/plain",
        expiresAt: phase11Now + 5 * 60_000,
      };

      const upload = await signer.createPost(input);
      const policy = parsePolicy(upload);

      expect(upload.url).toMatch(/^https:\/\//);
      expect(upload.fields).toMatchObject({
        key: input.key,
        "Content-Type": input.contentType,
        "x-amz-checksum-algorithm": "SHA256",
        "x-amz-checksum-sha256": checksumBase64,
      });
      expect(conditionHas(policy, "bucket", input.bucket)).toBe(true);
      expect(conditionHas(policy, "key", input.key)).toBe(true);
      expect(conditionHas(policy, "Content-Type", input.contentType)).toBe(true);
      expect(conditionHas(policy, "x-amz-checksum-algorithm", "SHA256")).toBe(true);
      expect(conditionHas(policy, "x-amz-checksum-sha256", checksumBase64)).toBe(true);
      expect(
        policy.conditions.some(
          (condition) =>
            Array.isArray(condition) &&
            condition[0] === "content-length-range" &&
            condition[1] === input.sizeBytes &&
            condition[2] === input.sizeBytes,
        ),
      ).toBe(true);
      expect(Date.parse(policy.expiration)).toBe(credentialExpiresAt);
      expect(upload.expiresAt).toBe(credentialExpiresAt);

      const tokenLimited = await signer.createPost({
        ...input,
        key: `${input.key}.token-limited`,
        expiresAt: phase11Now + 30_000,
      });
      expect(Date.parse(parsePolicy(tokenLimited).expiration)).toBe(phase11Now + 30_000);
      expect(tokenLimited.expiresAt).toBe(phase11Now + 30_000);
    } finally {
      await s3Client?.destroy();
      vi.useRealTimers();
    }
  });
});
