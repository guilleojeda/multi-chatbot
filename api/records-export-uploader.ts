import { AbortMultipartUploadCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "node:stream";

export type RecordsExportCsvUpload = {
  client: S3Client;
  bucket: string;
  key: string;
  contentType: string;
  body: AsyncIterable<Uint8Array>;
};

/**
 * Publish a records CSV while converging every failed multipart attempt.
 *
 * lib-storage@3.1152.0 does not abort an upload when CompleteMultipartUpload
 * fails, even when leavePartsOnError is false. Keep the SDK's normal upload
 * path and explicitly clean up the exact upload it created if done() rejects.
 */
export async function uploadRecordsCsv({
  client,
  bucket,
  key,
  contentType,
  body,
}: RecordsExportCsvUpload): Promise<{ eTag?: string }> {
  const upload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      Body: Readable.from(body),
    },
    queueSize: 2,
    partSize: 8 * 1024 * 1024,
    // Cleanup is handled below for all failures, including CompleteMultipartUpload.
    leavePartsOnError: true,
  });

  try {
    const result = await upload.done();
    return { eTag: result.ETag };
  } catch (error) {
    const uploadId = upload.uploadId;
    if (typeof uploadId === "string" && uploadId.length > 0) {
      try {
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
          }),
        );
      } catch {
        // Preserve the original upload failure; lifecycle cleanup remains a fallback.
      }
    }
    throw error;
  }
}
