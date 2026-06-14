// Sale management CLI (run in your terminal):
//   node --env-file=.env scripts/sale.mjs status
//   node --env-file=.env scripts/sale.mjs publish "שם המכירה"   (omit name → uses settings.saleName)
//   node --env-file=.env scripts/sale.mjs open
//   node --env-file=.env scripts/sale.mjs close
//
// publish needs PRICING_SPREADSHEET_ID + GOOGLE_CREDENTIALS in .env.
import saleLib from '../lib/sale.js';

const { publishSale, setSaleStatus, getSaleStatus } = saleLib;
const cmd = (process.argv[2] || '').trim();
const arg = process.argv[3];

setTimeout(() => {
  console.error('TIMEOUT after 30s.');
  process.exit(2);
}, 30000);

try {
  if (cmd === 'status') {
    console.log(await getSaleStatus());
  } else if (cmd === 'publish') {
    const r = await publishSale({ saleName: arg });
    console.log('✅ Published sale "' + r.saleName + '":');
    console.log('   updated: ' + r.updated + ' | added: ' + r.added + ' | hidden: ' + r.hidden + ' | in sale: ' + r.total);
    console.log('   sale is now OPEN.');
  } else if (cmd === 'open') {
    console.log('✅', await setSaleStatus('open'));
  } else if (cmd === 'close') {
    console.log('✅', await setSaleStatus('closed'), '(prices preserved)');
  } else {
    console.log('usage: status | publish [saleName] | open | close');
  }
  process.exit(0);
} catch (e) {
  console.error('❌ ' + (e.message || e));
  process.exit(1);
}
