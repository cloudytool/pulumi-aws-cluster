const fs = require('fs');

const pulumi = require('@pulumi/pulumi');
const random = require('@pulumi/random');

const UserResource = require('./UserResource');
const NetworkResource = require('./NetworkResource');
const NodeResource = require('./NodeResource');
const DnsResource = require('./DnsResource');
const IngressResource = require('./IngressResource');
const DbResource = require('./DbResource');
const BucketResource = require('./BucketResource');

const awsConfig = new pulumi.Config('aws');
const clusterConfig = new pulumi.Config('cluster');
const ec2Config = new pulumi.Config('ec2');
const iamConfig = new pulumi.Config('iam');

const genEnvs = (data, meta = {}) => {
  const {
    workerToken,
    bucketName,
    accessKeyId,
    accessKeySecret,
  } = data;

  pulumi.log.info(`[CLUSTER] Worker token object name: ${workerToken}`);

  const { MASTER_IP } = meta;

  return `
    export WORKER_TOKEN_OBJECT=${workerToken}
    export WORKER_TOKEN_PATH=${clusterConfig.require('workerTokenPath')}
    export MASTER_HOST_IP=${MASTER_IP}
    export S3_BUCKET=${bucketName}
    export AWS_ACCESS_KEY_ID=${accessKeyId}
    export AWS_SECRET_ACCESS_KEY=${accessKeySecret}
  `;
};

const bootstrapScript = fs.readFileSync('src/bootstrap.sh');
const masterBootstrapScript = fs.readFileSync('src/master_bootstrap.sh');
const slaveBootstrapScript = fs.readFileSync('src/slave_bootstrap.sh');
const cloudScript = fs.readFileSync('src/cloud_cli.sh');

const projectName = ec2Config.require('projectName');

const newUsers = Object.values(iamConfig.requireObject('users')).map((entries) => {
  const [userName, userPolicy] = Object.entries(entries)?.[0];

  const user = new UserResource(
    userName,
    {
      policy: userPolicy,
      projectName,
    },
  );

  return user;
});

const s3ExchangeUser = pulumi.output(newUsers).apply((users) => users[0]);

if (!s3ExchangeUser.user) {
  throw new Error('No tokens exchange user created');
}

const bucketResource = new BucketResource(
  projectName,
);

const networkResource = new NetworkResource(
  'virtual-network',
);

const vpcSecurityGroupIds = pulumi.all([networkResource.id]);
const workerTokenObject = new random.RandomUuid('worker-exchange-objectname', {});

const genConfig = (_, nodeBootstrapScript, meta = {}) => ({
  startupScripts: pulumi.all([
    {
      workerToken: workerTokenObject.result,
      bucketName: bucketResource.bucket.bucket,
      accessKeyId: s3ExchangeUser.accessKey.id,
      accessKeySecret: s3ExchangeUser.secret,
    },
    pulumi.output(meta),
  ]).apply(([data, metaOutput]) => [
    bootstrapScript,
    genEnvs(data, metaOutput),
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
  info.Db = dbResource.instance.endpoint;
}

const msshCommands = [];

masterResources.forEach((node) => {
  msshCommands.push(buildMssh(node.instance.id));
});

slaveResources.forEach((node) => {
  msshCommands.push(buildMssh(node.instance.id));
});

info.mssh = pulumi.all(msshCommands);

info.newUsers = newUsers.map((user) => user.credentials);

exports.info = info;
