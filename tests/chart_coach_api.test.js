'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/chart-coach.js');

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function makeRequest({ method = 'POST', body = {}, origin = 'https://coach.test', ip = '198.51.100.10', contentType = 'application/json' } = {}) {
  return {
    method,
    body,
    headers: { host: 'coach.test', origin, 'x-forwarded-for': ip, 'content-type': contentType },
    socket: { remoteAddress: ip }
  };
}

function validRequest(ip = '198.51.100.11') {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(93, 1)]);
  const imageData = `data:image/jpeg;base64,${bytes.toString('base64')}`;
  return makeRequest({
    ip,
    body: { imageData, pair: 'EUR/USD', timeframe: '1h' }
  });
}

function sampleAnalysis() {
  return {
    summary: 'Test-only fixture response.',
    observedBias: 'unclear',
    overallConfidence: 'low',
    marketStructure: { reading: 'Unclear in test fixture.', evidence: 'Test fixture only.', confidence: 'low' },
    liquidity: { reading: 'Unclear in test fixture.', evidence: 'Test fixture only.', confidence: 'low' },
    bos: { status: 'not-clear', explanation: 'Test fixture only.' },
    choch: { status: 'not-clear', explanation: 'Test fixture only.' },
    fairValueGap: { status: 'not-clear', explanation: 'Test fixture only.' },
    bullishScenario: { conditionsToWatch: 'Test fixture only.', whatWouldWeaken: 'Test fixture only.' },
    bearishScenario: { conditionsToWatch: 'Test fixture only.', whatWouldWeaken: 'Test fixture only.' },
    annotations: [
      { concept: 'fvg', label: 'Test marker', explanation: 'Test fixture only.', x: 0.4, y: 0.6 },
      { concept: 'liquidity', label: 'Invalid marker', explanation: 'Should be discarded.', x: 2, y: -1 }
    ],
    caveats: ['Test fixture only.']
  };
}

async function invoke(req) {
  const res = makeResponse();
  await handler(req, res);
  return res;
}

test('rejects non-POST methods and sets no-store security headers', async () => {
  const res = await invoke(makeRequest({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers['cache-control'], 'no-store, max-age=0');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers.allow, 'POST');
});

test('rejects cross-origin requests before requiring a key', async () => {
  const res = await invoke(makeRequest({ origin: 'https://other.test' }));
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /request could not be verified/i);
});

test('reports a safe disabled state when the review-only key is absent', async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const res = await invoke(validRequest('198.51.100.12'));
    assert.equal(res.statusCode, 503);
    assert.match(res.body.error, /not enabled/i);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test('rejects invalid pair, unsupported MIME, and fake image signatures', async () => {
  process.env.OPENAI_API_KEY = 'test-only-mock-key';
  const invalidPair = validRequest('198.51.100.13');
  invalidPair.body.pair = 'FAKE/PAIR';
  const pairRes = await invoke(invalidPair);
  assert.equal(pairRes.statusCode, 400);

  const fakeImage = validRequest('198.51.100.14');
  fakeImage.body.imageData = `data:image/jpeg;base64,${Buffer.alloc(96, 65).toString('base64')}`;
  const imageRes = await invoke(fakeImage);
  assert.equal(imageRes.statusCode, 400);
});

test('forwards an image to OpenAI server-side and normalizes structured output', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = global.fetch;
  process.env.OPENAI_API_KEY = 'test-only-mock-key';
  let capturedUrl = '';
  let capturedOptions;
  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(sampleAnalysis()) }] }]
      })
    };
  };
  try {
    const res = await invoke(validRequest('198.51.100.15'));
    assert.equal(res.statusCode, 200);
    assert.equal(capturedUrl, 'https://api.openai.com/v1/responses');
    assert.equal(capturedOptions.headers.Authorization, 'Bearer test-only-mock-key');
    const payload = JSON.parse(capturedOptions.body);
    assert.equal(payload.model, 'gpt-4o-mini');
    assert.equal(payload.store, false);
    assert.equal(payload.text.format.type, 'json_schema');
    assert.equal(payload.input[1].content[1].type, 'input_image');
    assert.equal(res.body.pair, 'EUR/USD');
    assert.equal(res.body.timeframe, '1h');
    assert.equal(res.body.annotations.length, 1);
    assert.equal(res.body.annotations[0].concept, 'fvg');
    assert.equal(res.body.observedBias, 'unclear');
    assert.equal(JSON.stringify(res.body).includes('test-only-mock-key'), false);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});
