import { CfnOutput, Stack, Tags } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";
import type { ResolvedBotEnvironment } from "../../config/project.js";

const websiteAssetPath = fileURLToPath(new URL("../../web", import.meta.url));

export class PublicSiteStack extends Stack {
  constructor(scope: Construct, id: string, environment: ResolvedBotEnvironment) {
    super(scope, id, {
      env: { account: environment.account, region: environment.region },
      tags: {
        project: "multi-chatbot",
        environment: environment.environment,
      },
    });

    // explicitStackTags separates stack tags above from resource tags below.
    Tags.of(this).add("project", "multi-chatbot");
    Tags.of(this).add("environment", environment.environment);

    const websiteBucket = new s3.Bucket(this, "WebsiteBucket", {
      bucketName: `${environment.botResourcePrefix}-site-assets-${environment.account}-${environment.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });

    const distribution = new cloudfront.Distribution(this, "WebsiteDistribution", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
    });

    new s3deploy.BucketDeployment(this, "WebsiteDeployment", {
      sources: [s3deploy.Source.asset(websiteAssetPath)],
      destinationBucket: websiteBucket,
      distribution,
      distributionPaths: ["/*"],
    });

    new CfnOutput(this, "PublicSiteUrl", {
      value: `https://${distribution.distributionDomainName}`,
      description: `Public URL for the ${environment.botId} site in ${environment.environment}.`,
    });
  }
}
