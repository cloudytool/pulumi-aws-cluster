const pulumi = require('@pulumi/pulumi');
const awsx = require('@pulumi/awsx');

class IngressResource extends pulumi.ComponentResource {
  constructor(name, args, opts = {}) {
    const {
      vpc,
      targetInstance,
    } = args;

    super('resource:group:IngressResource', name, args, opts);

    const lb = new awsx.lb.ApplicationLoadBalancer('load-balancer', {
      vpc,
      external: true,
    });

    // create rule that listens 80 port
    const httpListener = lb.createListener('web-listener', { port: 80 });
    httpListener.attachTarget('http-target', targetInstance);

    this.applicationLoadBalancer = lb;
    this.httpListener = httpListener;

    this.registerOutputs({
      applicationLoadBalancer: lb,
    });
  }
}

module.exports = IngressResource;
