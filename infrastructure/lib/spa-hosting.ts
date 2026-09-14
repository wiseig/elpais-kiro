import * as fs from 'node:fs';
import * as path from 'node:path';
import { Annotations, CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import type * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { REPO_ROOT } from './lambda';

export interface SpaHostingProps {
  /** Ruta relativa al repo del build de Vite (ej. apps/chat-web/dist). */
  distDir: string;
  /** Se publica como /config.json para que la SPA resuelva URLs en runtime. */
  configJson: Record<string, unknown>;
  /** Rutas que CloudFront reenvía a API Gateway (mismo origen, sin CORS). */
  apiRoutes: { pathPattern: string; api: apigateway.RestApi }[];
  webAclArn?: string;
  comment: string;
}

/** S3 privado + CloudFront (OAC) + WAF + config.json generado en el deploy (baseline 3.2). */
export class SpaHosting extends Construct {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: SpaHostingProps) {
    super(scope, id);
    this.bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {};
    for (const route of props.apiRoutes) {
      additionalBehaviors[route.pathPattern] = {
        origin: new origins.RestApiOrigin(route.api),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      };
    }

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: props.comment,
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      ...(props.webAclArn ? { webAclId: props.webAclArn } : {}),
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      additionalBehaviors,
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.seconds(10) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.seconds(10) },
      ],
    });

    const distPath = path.join(REPO_ROOT, props.distDir);
    const sources: s3deploy.ISource[] = [];
    if (fs.existsSync(path.join(distPath, 'index.html'))) {
      sources.push(s3deploy.Source.asset(distPath));
    } else {
      Annotations.of(this).addWarning(`No existe ${props.distDir}/index.html: se publica solo config.json. Corré el build de la SPA antes de desplegar.`);
    }
    if (sources.length > 0) {
      new s3deploy.BucketDeployment(this, 'Deploy', {
        destinationBucket: this.bucket,
        sources,
        distribution: this.distribution,
        distributionPaths: ['/*'],
        prune: false,
        memoryLimit: 512,
      });
    }
    // config.json fija el pool de Cognito y la URL del API: si el navegador se lo guarda, la SPA
    // sigue hablándole a la configuración vieja y no hay forma de entrar. Nunca se cachea.
    new s3deploy.BucketDeployment(this, 'DeployConfig', {
      destinationBucket: this.bucket,
      sources: [s3deploy.Source.jsonData('config.json', props.configJson)],
      distribution: this.distribution,
      distributionPaths: ['/config.json'],
      prune: false,
      cacheControl: [s3deploy.CacheControl.noCache(), s3deploy.CacheControl.mustRevalidate()],
    });

    new CfnOutput(this, 'Url', { value: `https://${this.distribution.distributionDomainName}` });
  }
}
