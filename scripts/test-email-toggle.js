const assert = require('assert');
const { sendOrderEmail } = require('../lib/email');

const baseOptions = {
  to: ['orders@example.com'],
  subject: 'בדיקת מייל',
  text: 'בדיקת מייל',
  html: '<p>בדיקת מייל</p>',
  order: { orderId: 'TEST-1' },
  pdfBuffer: null,
  pdfError: '',
};

function createResendClient() {
  const calls = [];

  return {
    calls,
    client: {
      emails: {
        async send(payload) {
          calls.push(payload);
          return { error: null };
        },
      },
    },
  };
}

async function runCase(name, options) {
  const fakeResend = createResendClient();
  const result = await sendOrderEmail(baseOptions, {
    env: options.env,
    edgeConfigGet: options.edgeConfigGet,
    resendClient: fakeResend.client,
  });

  assert.strictEqual(fakeResend.calls.length, options.expectedCalls, name + ': unexpected Resend call count');
  assert.strictEqual(Boolean(result.skippedEmail), options.expectedSkipped, name + ': unexpected skip result');

  if (options.expectedCalls) {
    const payload = fakeResend.calls[0];
    assert.strictEqual(payload.from, 'פרינוּק <orders@prinuk.co.il>', name + ': unexpected sender');
    assert.strictEqual(payload.replyTo, 'prinuk10@gmail.com', name + ': unexpected reply-to');
  } else {
    assert.strictEqual(result.success, true, name + ': skipped email should be successful');
    assert.strictEqual(Boolean(result.reason), true, name + ': skipped email should include a reason');
  }
}

async function main() {
  await runCase('production enabled', {
    env: { VERCEL_TARGET_ENV: 'production' },
    edgeConfigGet: async flagName => {
      assert.strictEqual(flagName, 'sendEmailsProduction');
      return true;
    },
    expectedCalls: 1,
    expectedSkipped: false,
  });

  await runCase('production disabled', {
    env: { VERCEL_TARGET_ENV: 'production' },
    edgeConfigGet: async flagName => {
      assert.strictEqual(flagName, 'sendEmailsProduction');
      return false;
    },
    expectedCalls: 0,
    expectedSkipped: true,
  });

  await runCase('preview enabled', {
    env: { VERCEL_ENV: 'preview' },
    edgeConfigGet: async flagName => {
      assert.strictEqual(flagName, 'sendEmailsPreview');
      return true;
    },
    expectedCalls: 1,
    expectedSkipped: false,
  });

  await runCase('preview disabled', {
    env: { VERCEL_ENV: 'preview' },
    edgeConfigGet: async flagName => {
      assert.strictEqual(flagName, 'sendEmailsPreview');
      return false;
    },
    expectedCalls: 0,
    expectedSkipped: true,
  });

  await runCase('missing flag', {
    env: { VERCEL_TARGET_ENV: 'production' },
    edgeConfigGet: async () => undefined,
    expectedCalls: 0,
    expectedSkipped: true,
  });

  await runCase('edge config read error', {
    env: { VERCEL_ENV: 'development' },
    edgeConfigGet: async () => {
      throw new Error('Edge Config unavailable');
    },
    expectedCalls: 0,
    expectedSkipped: true,
  });

  console.log('Email toggle tests OK');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
