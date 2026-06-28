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
    // SPA deep-link routing. This REPLACES the distribution-level
    // custom_error_response (403/404 -> /index.html), which also mangled the API's
    // /api/* 403/404 responses (it broke the callback's /me 403 onboarding signal).
    // /api/* has its OWN CloudFront behavior with no function association, so it
    // never reaches here. A final path segment with no '.' is a client route ->
    // serve the SPA shell; assets (with an extension) pass straight to S3.
    var lastSegment = req.uri.substring(req.uri.lastIndexOf('/') + 1);
    if (lastSegment.indexOf('.') === -1) {
      req.uri = '/index.html';
    }
    return req;
  }
  return {
    statusCode: 401,
    statusDescription: 'Unauthorized',
    headers: { 'www-authenticate': { value: 'Basic realm="Mythrun staging"' } },
  };
}
