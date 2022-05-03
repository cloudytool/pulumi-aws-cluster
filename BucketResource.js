const pulumi = require('@pulumi/pulumi');
const aws = require('@pulumi/aws');

class BucketResource extends pulumi.ComponentResource {
  constructor(name, args, opts = {}) {
    super('resource:group:BucketResource', name, args, opts);

    const bucket = new aws.s3.Bucket(name);

    function publicReadPolicyForBucket(bucketName) {
      return JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Principal: '*',
          Action: [
            's3:GetObject',
          ],
          Resource: [
            `arn:aws:s3:::${bucketName}/*`, // policy refers to bucket name explicitly
          ],
        }],
      });
    }

    const bucketPolicy = new aws.s3.BucketPolicy(`${name}-policy`, {
      bucket: bucket.bucket,
      policy: bucket.bucket.apply(publicReadPolicyForBucket),
    });

    this.bucket = bucket;

    this.registerOutputs({
      bucket,
      bucketPolicy,
    });
  }
}

module.exports = BucketResource;
