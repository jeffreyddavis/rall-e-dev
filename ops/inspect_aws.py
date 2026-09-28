"""Read-only AWS inventory. Credentials are read in memory and never printed or saved."""
import sys, re, hashlib, hmac, datetime, urllib.request, urllib.parse, urllib.error, json
import xml.etree.ElementTree as ET

env = {}
with open(sys.argv[1], encoding='utf-8-sig') as f:
    for line in f:
        match = re.match(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$', line)
        if match:
            env[match[1]] = match[2].strip('"\'')
key = env.get('AWS_ACCESS_KEY_ID') or env.get('AWS_ACCESS')
secret = env.get('AWS_SECRET_ACCESS_KEY') or env.get('AWS_SECRET')
region = env.get('AWS_REGION', 'us-east-1')
if not key or not secret:
    sys.exit('AWS access credentials were not found in the supplied environment file.')

def call(service, host, path='/', query='', payload='', target=None, signing_region=None):
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    date = stamp[:8]
    signing_region = signing_region or region
    headers = {'host': host, 'x-amz-date': stamp, 'content-type': 'application/x-www-form-urlencoded' if not target else 'application/x-amz-json-1.1'}
    if target: headers['x-amz-target'] = target
    signed = ';'.join(sorted(headers))
    canonical = '\n'.join(['POST' if payload else 'GET', path, query, ''.join(k + ':' + headers[k] + '\n' for k in sorted(headers)), signed, hashlib.sha256(payload.encode()).hexdigest()])
    scope = '/'.join([date, signing_region, service, 'aws4_request'])
    string = '\n'.join(['AWS4-HMAC-SHA256', stamp, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    def sign(k, m): return hmac.new(k, m.encode(), hashlib.sha256).digest()
    signing_key = sign(sign(sign(sign(('AWS4'+secret).encode(),date),signing_region),service),'aws4_request')
    headers['authorization'] = f'AWS4-HMAC-SHA256 Credential={key}/{scope}, SignedHeaders={signed}, Signature={hmac.new(signing_key,string.encode(),hashlib.sha256).hexdigest()}'
    request=urllib.request.Request('https://'+host+path+('?' + query if query else ''), data=payload.encode() if payload else None, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=25) as response: return response.read()
    except urllib.error.HTTPError as error:
        body=error.read().decode()
        code=re.search(r'<Code>(.*?)</Code>',body)
        print(service, 'HTTP',error.code,code.group(1) if code else 'access denied or unavailable')
        return None

print('Configured AWS region:', region)
raw=call('ec2',f'ec2.{region}.amazonaws.com',payload=urllib.parse.urlencode({'Action':'DescribeInstances','Version':'2016-11-15','MaxResults':'100'}))
if raw:
    doc=ET.fromstring(raw); ns={'e':doc.tag.split('}')[0][1:]}
    for item in doc.findall('.//e:instancesSet/e:item',ns):
        def field(name): return item.findtext('e:'+name,default='',namespaces=ns)
        tags={tag.findtext('e:key',namespaces=ns):tag.findtext('e:value',namespaces=ns) for tag in item.findall('e:tagSet/e:item',ns)}
        print(json.dumps({'instance':field('instanceId'),'name':tags.get('Name'),'state':field('instanceState/e:name'),'public_ip':field('ipAddress'),'key_pair':field('keyName'),'image':field('imageId')}))
    if doc.find('e:nextToken',ns) is not None: print('Inventory paginated: more instances exist.')
raw=call('ssm',f'ssm.{region}.amazonaws.com',payload='{"MaxResults":50}',target='AmazonSSM.DescribeInstanceInformation')
if raw:
    for item in json.loads(raw).get('InstanceInformationList',[]):
        print('SSM',json.dumps({k:item.get(k) for k in ['InstanceId','PingStatus','PlatformName','PlatformVersion']}))
raw=call('route53','route53.amazonaws.com',path='/2013-04-01/hostedzone',signing_region='us-east-1')
if raw:
    doc=ET.fromstring(raw); ns={'r':doc.tag.split('}')[0][1:]}
    for zone in doc.findall('.//r:HostedZone',ns):
        name=zone.findtext('r:Name',namespaces=ns)
        if name and 'joinfitapp' in name: print('DNS zone:',name,'ID:',zone.findtext('r:Id',namespaces=ns))
