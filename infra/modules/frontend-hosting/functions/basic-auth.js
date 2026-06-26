import cf from 'cloudfront';

const kvs = cf.kvs();

async function handler(event) {
  const req = event.request;
  const sent = req.headers.authorization && req.headers.authorization.value;
  let expected;
  try {
    expected = await kvs.get('staging-basic-auth');
  } catch (e) {
    expected = null;
  }
  if (sent && expected && sent === expected) {
    return req;
  }
  return {
    statusCode: 401,
    statusDescription: 'Unauthorized',
    headers: { 'www-authenticate': { value: 'Basic realm="Mythrun staging"' } },
  };
}
