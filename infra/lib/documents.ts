import { createHash } from "node:crypto";
import { ArnFormat, CfnOutput, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3vectors from "aws-cdk-lib/aws-s3vectors";
import { Construct } from "constructs";
import { documentConfig, type ResolvedBotEnvironment } from "../../config/project.js";

function documentBucketName(environment: ResolvedBotEnvironment): string {
  const botHash = createHash("sha256")
    .update(`${environment.environment}:${environment.botId}`)
    .digest("hex")
    .slice(0, 8);
  const botSlug = environment.botId.slice(0, 10);

  return `${environment.resourcePrefix}-d-${botSlug}-${botHash}-${environment.account}-${environment.region}`;
}

export class DocumentInfrastructure extends Construct {
  readonly documentBucket: s3.Bucket;
  readonly preparedDocumentsPrefix = documentConfig.preparedDocumentsPrefix;
  readonly vectorBucket: s3vectors.CfnVectorBucket;
  readonly vectorIndex: s3vectors.CfnIndex;
  readonly knowledgeBase: bedrock.CfnKnowledgeBase;
  readonly dataSource: bedrock.CfnDataSource;

  constructor(scope: Construct, id: string, environment: ResolvedBotEnvironment) {
    super(scope, id);

    const stack = Stack.of(this);
    const knowledgeBaseName = `${environment.botResourcePrefix}-documents`;
    const vectorBucketName = `${environment.botResourcePrefix}-vectors`;
    const vectorIndexName = `${environment.botResourcePrefix}-documents`;

    this.documentBucket = new s3.Bucket(this, "DocumentBucket", {
      bucketName: documentBucketName(environment),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    Tags.of(this.documentBucket).add("botId", environment.botId);

    this.vectorBucket = new s3vectors.CfnVectorBucket(this, "VectorBucket", {
      vectorBucketName,
      tags: [
        { key: "project", value: "multi-chatbot" },
        { key: "environment", value: environment.environment },
        { key: "botId", value: environment.botId },
      ],
    });
    this.vectorBucket.applyRemovalPolicy(RemovalPolicy.RETAIN);

    this.vectorIndex = new s3vectors.CfnIndex(this, "VectorIndex", {
      vectorBucketArn: this.vectorBucket.attrVectorBucketArn,
      indexName: vectorIndexName,
      dataType: documentConfig.embeddingDataType,
      dimension: documentConfig.embeddingDimensions,
      distanceMetric: documentConfig.distanceMetric,
      metadataConfiguration: {
        nonFilterableMetadataKeys: ["AMAZON_BEDROCK_TEXT", "AMAZON_BEDROCK_METADATA"],
      },
      tags: [
        { key: "project", value: "multi-chatbot" },
        { key: "environment", value: environment.environment },
        { key: "botId", value: environment.botId },
      ],
    });
    this.vectorIndex.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const embeddingModelArn = stack.formatArn({
      service: "bedrock",
      region: environment.region,
      account: "",
      resource: "foundation-model",
      resourceName: documentConfig.embeddingModelId,
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
    const knowledgeBaseArnPattern = stack.formatArn({
      service: "bedrock",
      region: environment.region,
      account: environment.account,
      resource: "knowledge-base",
      resourceName: "*",
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });

    const knowledgeBaseRole = new iam.Role(this, "KnowledgeBaseRole", {
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com").withConditions({
        StringEquals: { "aws:SourceAccount": environment.account },
        ArnLike: { "aws:SourceArn": knowledgeBaseArnPattern },
      }),
    });
    Tags.of(knowledgeBaseRole).add("botId", environment.botId);
    const knowledgeBasePolicy = new iam.Policy(this, "KnowledgeBasePolicy", {
      roles: [knowledgeBaseRole],
    });
    knowledgeBasePolicy.addStatements(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [this.documentBucket.bucketArn],
        conditions: {
          StringLike: {
            "s3:prefix": [this.preparedDocumentsPrefix, `${this.preparedDocumentsPrefix}*`],
          },
        },
      }),
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [this.documentBucket.arnForObjects(`${this.preparedDocumentsPrefix}*`)],
      }),
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [embeddingModelArn],
      }),
      new iam.PolicyStatement({
        actions: [
          "s3vectors:PutVectors",
          "s3vectors:GetVectors",
          "s3vectors:DeleteVectors",
          "s3vectors:QueryVectors",
          "s3vectors:GetIndex",
        ],
        resources: [this.vectorIndex.attrIndexArn],
      }),
    );

    this.knowledgeBase = new bedrock.CfnKnowledgeBase(this, "KnowledgeBase", {
      name: knowledgeBaseName,
      roleArn: knowledgeBaseRole.roleArn,
      knowledgeBaseConfiguration: {
        type: "VECTOR",
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn,
          embeddingModelConfiguration: {
            bedrockEmbeddingModelConfiguration: {
              dimensions: documentConfig.embeddingDimensions,
              embeddingDataType: documentConfig.embeddingDataType.toUpperCase(),
            },
          },
        },
      },
      storageConfiguration: {
        type: "S3_VECTORS",
        s3VectorsConfiguration: {
          vectorBucketArn: this.vectorBucket.attrVectorBucketArn,
          indexArn: this.vectorIndex.attrIndexArn,
        },
      },
      tags: {
        project: "multi-chatbot",
        environment: environment.environment,
        botId: environment.botId,
      },
    });
    this.knowledgeBase.node.addDependency(knowledgeBasePolicy);

    this.dataSource = new bedrock.CfnDataSource(this, "DocumentDataSource", {
      knowledgeBaseId: this.knowledgeBase.attrKnowledgeBaseId,
      name: knowledgeBaseName,
      dataDeletionPolicy: "RETAIN",
      dataSourceConfiguration: {
        type: "S3",
        s3Configuration: {
          bucketArn: this.documentBucket.bucketArn,
          bucketOwnerAccountId: environment.account,
          inclusionPrefixes: [this.preparedDocumentsPrefix],
        },
      },
      // Omitting parsingConfiguration selects Bedrock's default parser, which converts
      // each prepared text document to text before the configured chunking strategy.
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: "FIXED_SIZE",
          fixedSizeChunkingConfiguration: {
            maxTokens: documentConfig.chunkMaxTokens,
            overlapPercentage: documentConfig.chunkOverlapPercentage,
          },
        },
      },
    });

    new CfnOutput(this, "DocumentBucketName", {
      value: this.documentBucket.bucketName,
      description: "Private S3 bucket for prepared chatbot documents.",
    });
    new CfnOutput(this, "PreparedDocumentsPrefix", {
      value: this.preparedDocumentsPrefix,
      description: "S3 prefix scanned by the chatbot Knowledge Base data source.",
    });
    new CfnOutput(this, "KnowledgeBaseId", {
      value: this.knowledgeBase.attrKnowledgeBaseId,
      description: "Knowledge Base ID configured for this chatbot Runtime.",
    });
    new CfnOutput(this, "DocumentDataSourceId", {
      value: this.dataSource.attrDataSourceId,
      description: "Data source ID for technical document ingestion and status checks.",
    });
    new CfnOutput(this, "VectorBucketName", {
      value: vectorBucketName,
      description: "S3 Vectors bucket used by the chatbot Knowledge Base.",
    });
    new CfnOutput(this, "VectorIndexName", {
      value: vectorIndexName,
      description: "S3 Vectors index used by the chatbot Knowledge Base.",
    });
  }
}
