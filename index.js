const fs = require('fs');

const pulumi = require('@pulumi/pulumi');
const random = require('@pulumi/random');

const NetworkResource = require('./NetworkResource');
const NodeResource = require('./NodeResource');
const DnsResource = require('./DnsResource');
const IngressResource = require('./IngressResource');
const DbResource = require('./DbResource');
const BucketResource = require('./BucketResource');

const awsConfig = new pulumi.Config('aws');
const clusterConfig = new pulumi.Config('cluster');
const s3Config = new pulumi.Config('s3');
const ec2Config = new pulumi.Config('ec2');

const genEnvs = (workerToken, bucketName, meta = {}) => {
  pulumi.log.info(`[CLUSTER] Worker token object name: ${workerToken}`);

  const { MASTER_IP } = meta;

  return `
    export WORKER_TOKEN_OBJECT=${workerToken}
    export WORKER_TOKEN_PATH=${clusterConfig.require('workerTokenPath')}
    export MASTER_HOST_IP=${MASTER_IP}
    export S3_BUCKET=${bucketName}
    export AWS_ACCESS_KEY_ID=${s3Config.require('accessKeyId')}
    export AWS_SECRET_ACCESS_KEY=${s3Config.require('secretAccessKey')}
  `;
};

const bootstrapScript = fs.readFileSync('src/bootstrap.sh');
const masterBootstrapScript = fs.readFileSync('src/master_bootstrap.sh');
const slaveBootstrapScript = fs.readFileSync('src/slave_bootstrap.sh');
const cloudScript = fs.readFileSync('src/cloud_cli.sh');

const bucketResource = new BucketResource(
  ec2Config.require('projectName'),
);

const networkResource = new NetworkResource(
  'virtual-network',
);

const vpcSecurityGroupIds = pulumi.all([networkResource.id]);
const workerTokenObject = new random.RandomUuid('worker-exchange-objectname', {});

const genConfig = (_, nodeBootstrapScript, meta = {}) => ({
  startupScripts: pulumi.all([
    workerTokenObject.result,
    bucketResource.bucket.bucket,
    pulumi.output(meta),
  ]).apply(([token, bucketName, metaOutput]) => [
    bootstrapScript,
    genEnvs(token, bucketName, metaOutput),
    cloudScript,
    nodeBootstrapScript,
  ]),
  vpcSecurityGroupIds,
});

const mastersCount = Number(ec2Config.require('masters'));
const masterNames = Array.from(Array(mastersCount).keys()).map((index) => `master${index}`);
const masters = masterNames.reduce((acc, k) => ({
  ...acc,
  [k]: genConfig(k, masterBootstrapScript),
}), {});

const masterResources = Object.entries(masters).map(([name, args]) => {
  const node = new NodeResource(name, args, { dependsOn: networkResource.securityGroup });

  return node;
});

const slavesCount = Number(ec2Config.require('slaves'));
const slaveNames = Array.from(Array(slavesCount).keys()).map((index) => `slave${index}`);
const slaves = slaveNames.reduce((acc, k) => ({
  ...acc,
  [k]: genConfig(k, slaveBootstrapScript, { MASTER_IP: masterResources[0].privateIp }),
}), {});

const dependsOnMaster = [
  // https://github.com/pulumi/pulumi/issues/991#issuecomment-415990117
  masterResources?.[0]?.instance,
];

const slaveResources = Object.entries(slaves).map(([name, args]) => {
  const node = new NodeResource(name, args, { dependsOn: dependsOnMaster });

  return node;
});

const ingressResource = new IngressResource('ingress', {
  targetInstance: masterResources[0].instance,
  vpc: networkResource.vpc,
});

const ingressDnsName = ingressResource.applicationLoadBalancer.loadBalancer.dnsName;
const ingressZoneId = ingressResource.applicationLoadBalancer.loadBalancer.zoneId;

const dnsResource = new DnsResource('dns-records', {
  lb: ingressResource.applicationLoadBalancer,
  targetInstance: masterResources[0].instance,
  ingressDnsName,
  ingressZoneId,
}, { dependsOn: ingressResource.applicationLoadBalancer });

const dbResource = new DbResource('rds-appdb', { vpcSecurityGroupIds });

const buildMssh = (id) => pulumi.interpolate`mssh ubuntu@${id} --region ${awsConfig.require('region')} --profile ${awsConfig.require('profile')}`;
const info = {};

info.Bucket = bucketResource.bucket.bucketRegionalDomainName;
info.WorkerTokenObject = workerTokenObject.result;

info.NameServers = dnsResource.dnsZone.nameServers;
info.LoadBalancer = ingressResource.applicationLoadBalancer.loadBalancer.dnsName;

if (dbResource?.instance) {
  info.Db = dbResource;
}

const msshCommands = [];

masterResources.forEach((node) => {
  msshCommands.push(buildMssh(node.instance.id));
});

slaveResources.forEach((node) => {
  msshCommands.push(buildMssh(node.instance.id));
});

info.mssh = pulumi.all(msshCommands);

exports.info = info;
