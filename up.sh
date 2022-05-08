pulumi stack init --stack $1 --secrets-provider passphrase
pulumi up --stack $1 --non-interactive -y
