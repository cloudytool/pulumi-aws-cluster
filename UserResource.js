const pulumi = require('@pulumi/pulumi');
const aws = require('@pulumi/aws');

const { genResName } = require('./utils');

class UserResource extends pulumi.ComponentResource {
  constructor(name, args, opts = {}) {
    super('resource:group:UserResource', name, args, opts);

    const {
      path = '/system/',
      forceDestroy = true,
      policy,
      projectName,
    } = args;

    const userResName = genResName(name, 'user');
    const userPolicyResName = genResName(name, 'user-policy');
    const accessKeyResName = genResName(name, 'access-key');

    const user = new aws.iam.User(userResName, {
      path,
      name,
      forceDestroy,
      tags: {
        type: pulumi.concat(projectName, '-user'),
        Name: pulumi.concat(projectName, '-', name),
      },
    });

    const userPolicy = new aws.iam.UserPolicy(userPolicyResName, {
      user: user.name,
      policy,
    });

    const accessKey = new aws.iam.AccessKey(accessKeyResName, {
      user: user.name,
    });

    this.user = user;
    this.userPolicy = userPolicy;

    this.userName = user.name;
    this.accessKey = accessKey;
    this.secret = accessKey.secret;

    const credentials = {
      userName: user.name,
      encryptedSecret: accessKey.encryptedSecret,
      accessKeyId: accessKey.id,
    };

    this.credentials = credentials;

    this.registerOutputs({
      user,
      userPolicy,
      credentials,
    });
  }
}

module.exports = UserResource;
