const pulumi = require('@pulumi/pulumi');
const aws = require('@pulumi/aws');

class DnsResource extends pulumi.ComponentResource {
  constructor(name, args, opts = {}) {
    const {
      ingressDnsName,
      ingressZoneId,
    } = args;

    super('resource:group:DnsResource', name, args, opts);
    const appConfig = new pulumi.Config('app');
    let domainName = appConfig.require('domainName');

    const dnsZone = new aws.route53.Zone('zone-dns', {
      name: domainName,
    });

    // key is Id for the entry
    const allRecords = {
      apexRecord: {
        name: pulumi.concat('app.', domainName, '.'),
        type: 'A',
        value: {
          name: ingressDnsName,
          zoneId: ingressZoneId,
          evaluateTargetHealth: true,
        },
        isAlias: true,
      },
      apiCname: {
        name: pulumi.concat('api.', domainName, '.'),
        type: 'CNAME',
        value: pulumi.concat('app.', domainName, '.'),
      },
    };

    const lastDomainChar = domainName.charAt(domainName.length - 1);

    // remove last dot from the domain
    if (lastDomainChar === '.') {
      domainName = domainName.slice(0, -1);
    }

    const dnsRecords = pulumi.all(Object.entries(allRecords)).apply(
      (dnsRecs) => dnsRecs.map(([key, data]) => {
        const records = pulumi.output(data.value).apply((v) => (Array.isArray(v) ? v : [v]));
        const valueKey = data.isAlias ? 'aliases' : 'records';

        const recArgs = {
          zoneId: dnsZone.zoneId,
          type: data.type,
          name: pulumi.output(data.name || '').apply((name) => name),
          [valueKey]: records,
          allowOverwrite: true,
        };

        if (!data.isAlias) {
          recArgs.ttl = 10;
        }

        const rec = new aws.route53.Record(key, recArgs);

        return [recArgs, rec];
      }),
    );

    this.dnsZone = dnsZone;
    this.dnsRecords = dnsRecords;

    this.registerOutputs({
      dnsZone,
    });
  }
}

module.exports = DnsResource;
