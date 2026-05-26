var PRINOK_CONFIG = {
  SPREADSHEET_ID: '',
  PRODUCTS_SHEET_NAME: 'מוצרים',
  SETTINGS_SHEET_NAME: 'הגדרות',
  ORDERS_SHEET_NAME: 'הזמנות',
  ORDER_ITEMS_SHEET_NAME: 'פריטי הזמנות',
  PICKING_SHEET_NAME: 'דפי ליקוט',
  ARCHIVE_SPREADSHEET_NAME: 'ארכיון הזמנות פרינוּק',
  PDF_LOGO_FILE_NAME: 'prinuk-logo-for-pdf.jpg',
  MAX_LOGO_DATA_URL_LENGTH: 250000,
  MAX_LOGO_BYTES: 250000,
  PRICING_SPREADSHEET_NAME: 'חישוב מחירים',
  CATEGORY_ORDER: ['ירקות', 'פירות', 'עלים', 'מיוחדים'],
  DEFAULT_FORM_TITLE: 'פרינוּק - המכירה השבועית',
  DEFAULT_FORM_DESCRIPTION: 'בחרו את הפירות והירקות שתרצו להזמין.',
  DEFAULT_CLOSED_MESSAGE: 'ההזמנות עוד לא נפתחו. הטופס ייפתח בקרוב.',
  DEFAULT_PICKUP_TEXT: 'המכירה תתקיים ביום שלישי ברחוב עוזיאל 101 בין השעות 10:00-19:00',
  DEFAULT_CONTACT_PHONE: '0535234975',
  DEFAULT_CONTACT_EMAIL: 'prinuk10@gmail.com'
};

function doGet() {
  return HtmlService
    .createHtmlOutputFromFile('Index')
    .setTitle('פרינוּק - המכירה השבועית')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getCatalog() {
  var ss = getSpreadsheet_();
  var sheet = getProductSheet_(ss);
  var settings = getSettings_(ss, sheet);
  var products = readProducts_(sheet);
  var categories = groupProducts_(products);

  return {
    sheetName: sheet.getName(),
    settings: settings,
    products: products,
    categories: categories
  };
}

function submitOrder(payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    return saveOrder_(payload);
  } finally {
    lock.releaseLock();
  }
}

function setupPrinokOrderSheets() {
  var ss = getSpreadsheet_();
  ensureSettingsSheet_(ss);
  ensureProductsSheet_(ss);
  ensureSheet_(ss, PRINOK_CONFIG.ORDERS_SHEET_NAME, getOrderHeaders_());
  ensureSheet_(ss, PRINOK_CONFIG.ORDER_ITEMS_SHEET_NAME, getOrderItemHeaders_());
  ensurePickingSheet_(ss);
  Logger.log('גיליונות ההזמנות נוצרו / עודכנו בהצלחה.');
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('פרינוּק')
    .addItem('הכן גיליונות הזמנות', 'setupPrinokOrderSheets')
    .addItem('רענן מוצרים מחישוב מחירים', 'refreshProductsFromPricingFile')
    .addItem('צור PDF מחירון', 'createPriceListPdf')
    .addItem('צור PDF מחירון בעמוד אחד', 'createOnePagePriceListPdf')
    .addItem('צור PDF מחירון עלים', 'createLeavesPriceListPdf')
    .addItem('צור PDF מחירון מיוחדים', 'createSpecialsPriceListPdf')
    .addItem('צור PDF פלייר מחירים', 'createDesignedPriceFlyerPdf')
    .addItem('צור PDF טופס הזמנה', 'createPrintableOrderFormPdf')
    .addItem('צור PDF שלטי מוצרים', 'createProductSignsPdf')
    .addItem('רענן דפי ליקוט', 'refreshPickingSheets')
    .addItem('סיכום משקל מוערך', 'refreshWeightSummary')
    .addSeparator()
    .addItem('העבר הזמנות לארכיון ונקה', 'archiveOrdersAndClear')
    .addItem('בדיקת קטלוג', 'logPrinokCatalog')
    .addItem('בדיקת טלגרם', 'testTelegramAlert')
    .addToUi();
}

function logPrinokCatalog() {
  var catalog = getCatalog();
  Logger.log(JSON.stringify(catalog, null, 2));
}

function testTelegramAlert() {
  var ss = getSpreadsheet_();
  ensureSettingsSheet_(ss);
  var productSheet = getProductSheet_(ss);
  var settings = getSettings_(ss, productSheet);
  var order = {
    timestamp: new Date(),
    orderId: 'TEST-' + Utilities.formatDate(new Date(), PRINOK_CONFIG.TIMEZONE, 'yyyyMMdd-HHmmss'),
    productSheetName: productSheet.getName(),
    fullName: 'בדיקת מערכת',
    phone: settings.contactPhone || PRINOK_CONFIG.DEFAULT_CONTACT_PHONE,
    email: '',
    fulfillment: 'בדיקה',
    address: '',
    floor: '',
    apartment: '',
    notes: 'בדיקת חיבור טלגרם - לא נוצרה הזמנה בגיליון',
    itemCount: 0,
    estimatedTotal: 0,
    unpricedItemCount: 0
  };
  var result = trySendNewOrderTelegramAlert_(settings, order, []);
  var message = result.status + (result.error ? ': ' + result.error : '');

  ss.toast(message, 'בדיקת טלגרם', 8);

  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (error) {
    Logger.log(message);
  }
}

function refreshProductsFromPricingFile() {
  var result = refreshProductsFromPricingFile_();
  var message = result.isOpen === false
    ? 'לא נמצא גיליון בשם "' + result.sheetName + '" בקובץ "' + result.fileName + '". גיליון מוצרים נוקה והטופס מציג שההזמנות עוד לא נפתחו.'
    : 'גיליון מוצרים רוענן מתוך "' + result.fileName + '" / "' + result.sheetName + '". ' + result.rowCount + ' שורות הועתקו.';

  Logger.log(message);
  getSpreadsheet_().toast(message, 'פרינוּק', 8);
}

function createPriceListPdf() {
  var result = createPriceListPdf_();
  var message = 'המחירון נוצר בהצלחה: ' + result.fileName + '\n' + result.url;

  if (result.emailRecipients) {
    message += '\n\nהמחירון נשלח למייל: ' + result.emailRecipients;
  } else {
    message += '\n\nלא נשלח מייל כי לא הוגדר אימייל התראות או מייל ליצירת קשר בגיליון הגדרות.';
  }

  Logger.log(message);
  getSpreadsheet_().toast(result.emailRecipients ? 'המחירון נוצר ונשלח למייל.' : 'המחירון נוצר ונשמר בדרייב.', 'פרינוּק', 8);

  try {
    SpreadsheetApp.getUi().alert('המחירון נוצר', message, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (error) {
  }
}

function createDesignedPriceFlyerPdf() {
  var result = createDesignedPriceFlyerPdf_();
  var message = 'פלייר המחירים נוצר בהצלחה: ' + result.fileName + '\n' + result.url;

  if (result.emailRecipients) {
    message += '\n\nהפלייר נשלח למייל: ' + result.emailRecipients;
  } else {
    message += '\n\nלא נשלח מייל כי לא הוגדר אימייל התראות או מייל ליצירת קשר בגיליון הגדרות.';
  }

  Logger.log(message);
  getSpreadsheet_().toast(result.emailRecipients ? 'פלייר המחירים נוצר ונשלח למייל.' : 'פלייר המחירים נוצר ונשמר בדרייב.', 'פרינוּק', 8);

  try {
    SpreadsheetApp.getUi().alert('פלייר המחירים נוצר', message, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (error) {
  }
}

function createPrintableOrderFormPdf() {
  var result = createPrintableOrderFormPdf_();
  var message = 'טופס ההזמנה נוצר בהצלחה: ' + result.fileName + '\n' + result.url;

  Logger.log(message);
  getSpreadsheet_().toast('טופס ההזמנה נוצר ונשמר בדרייב.', 'פרינוּק', 8);

  try {
    SpreadsheetApp.getUi().alert('טופס ההזמנה נוצר', message, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (error) {
  }
}

function createOnePagePriceListPdf() {
  runCompactPriceListMenu_(
    { columns: 3, titleSuffix: 'בעמוד אחד', fileLabel: 'מחירון-עמוד-אחד' },
    'המחירון בעמוד אחד נוצר'
  );
}

function createLeavesPriceListPdf() {
  runCompactPriceListMenu_(
    { columns: 2, category: 'עלים', titleSuffix: 'עלים', fileLabel: 'מחירון-עלים' },
    'מחירון העלים נוצר'
  );
}

function createSpecialsPriceListPdf() {
  runCompactPriceListMenu_(
    { columns: 2, category: 'מיוחדים', titleSuffix: 'מיוחדים', fileLabel: 'מחירון-מיוחדים' },
    'מחירון המיוחדים נוצר'
  );
}

function runCompactPriceListMenu_(opts, alertTitle) {
  var result = createCompactPriceListPdf_(opts);
  var message = result.fileName + '\n' + result.url;

  Logger.log(message);
  getSpreadsheet_().toast('המחירון נוצר ונשמר בדרייב.', 'פרינוּק', 8);

  try {
    SpreadsheetApp.getUi().alert(alertTitle, message, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (error) {
  }
}

function createProductSignsPdf() {
  var result = createProductSignsPdf_();
  var message = 'שלטי המוצרים נוצרו בהצלחה: ' + result.fileName + '\n' + result.url;

  Logger.log(message);
  getSpreadsheet_().toast('שלטי המוצרים נוצרו ונשמרו בדרייב.', 'פרינוּק', 8);

  try {
    SpreadsheetApp.getUi().alert('שלטי המוצרים נוצרו', message, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (error) {
  }
}

function archiveOrdersAndClear() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.alert(
    'העברת הזמנות לארכיון',
    'הפעולה תעתיק את כל ההזמנות ופריטי ההזמנות לארכיון, ואז תנקה את גיליונות ההזמנות הפעילים ואת דפי הליקוט. להמשיך?',
    ui.ButtonSet.YES_NO
  );

  if (response !== ui.Button.YES) {
    return;
  }

  var result = archiveOrdersAndClear_();
  var message = [
    'הפעולה הסתיימה.',
    '',
    'הזמנות שהועברו לארכיון: ' + result.orderCount,
    'שורות פריטים שהועברו לארכיון: ' + result.itemCount,
    'שם מכירה בארכיון: ' + result.saleName,
    'גיליון בארכיון: ' + result.archiveSheetName,
    'קובץ ארכיון: ' + result.archiveSpreadsheetUrl
  ].join('\n');

  Logger.log(message);
  getSpreadsheet_().toast('ההזמנות הועברו לארכיון והקובץ נוקה.', 'פרינוּק', 8);
  ui.alert('הסתיים', message, ui.ButtonSet.OK);
}

function refreshPickingSheets() {
  var ss = getSpreadsheet_();
  var ordersSheet = ss.getSheetByName(PRINOK_CONFIG.ORDERS_SHEET_NAME);
  var orderItemsSheet = ss.getSheetByName(PRINOK_CONFIG.ORDER_ITEMS_SHEET_NAME);
  var pickingSheet = ensurePickingSheet_(ss);

  pickingSheet.getDataRange().breakApart();
  pickingSheet.clear();
  setupPickingSheet_(pickingSheet);

  if (!ordersSheet || !orderItemsSheet || ordersSheet.getLastRow() < 2 || orderItemsSheet.getLastRow() < 2) {
    Logger.log('אין עדיין הזמנות לדפי ליקוט.');
    return;
  }

  var orders = readTable_(ordersSheet);
  var items = readTable_(orderItemsSheet);
  var itemsByOrderId = {};

  items.forEach(function(item) {
    var orderId = item['מספר הזמנה'];

    if (!itemsByOrderId[orderId]) {
      itemsByOrderId[orderId] = [];
    }

    itemsByOrderId[orderId].push(item);
  });

  orders.forEach(function(order) {
    appendPickingOrderFromRows_(ss, order, itemsByOrderId[order['מספר הזמנה']] || []);
  });

  Logger.log('דפי הליקוט רועננו בהצלחה.');
}

// Build a "סיכום משקל" tab: total estimated weight per product across all
// rows in פריטי הזמנות. Only items priced by the kilo have a weight; for
// those, the calculated sum already embeds the weight (sum = weight × price),
// so the weight is recovered as sum ÷ price — which is exact when the item
// was ordered by ק״ג and the estimate when it was ordered by units. Items
// priced per unit have no weight and are skipped.
var WEIGHT_SUMMARY_SHEET_NAME = 'סיכום משקל';

function refreshWeightSummary() {
  var ss = getSpreadsheet_();
  var orderItemsSheet = ss.getSheetByName(PRINOK_CONFIG.ORDER_ITEMS_SHEET_NAME);
  var ui = SpreadsheetApp.getUi();

  if (!orderItemsSheet || orderItemsSheet.getLastRow() < 2) {
    ui.alert('אין עדיין פריטי הזמנות לסיכום משקל.');
    return;
  }

  var items = readTable_(orderItemsSheet);
  var byProduct = {};
  var order = [];

  items.forEach(function(item) {
    var name = String(item['מוצר'] || '').trim();

    if (!name) {
      return;
    }

    // Weight only applies to items priced by the kilo.
    if (getUnitType_(item['יחידת מחיר']) !== 'kg') {
      return;
    }

    var quantity = parseQuantity_(item['כמות']);

    if (!isFinite(quantity) || quantity <= 0) {
      return;
    }

    if (!byProduct[name]) {
      byProduct[name] = {
        name: name,
        department: String(item['מחלקה'] || '').trim(),
        weightKg: 0,
        lines: 0,
        unknownUnits: 0
      };
      order.push(name);
    }

    var agg = byProduct[name];
    agg.lines++;

    if (getUnitType_(item['יחידת הזמנה']) === 'kg') {
      // Ordered by weight: the quantity is already in kilograms.
      agg.weightKg += quantity;
      return;
    }

    // Ordered by units on a kg-priced item: recover the estimated weight
    // from the calculated sum (sum = estimated weight × price).
    var sum = parsePrice_(item['סכום מחושב']);
    var price = parsePrice_(item['מחיר מהגיליון']);

    if (isFinite(sum) && sum > 0 && isFinite(price) && price > 0) {
      agg.weightKg += sum / price;
    } else {
      // No estimate was available for this item — flag it for manual weighing.
      agg.unknownUnits += quantity;
    }
  });

  var rows = order.map(function(name) {
    return byProduct[name];
  });

  rows.sort(function(a, b) {
    if (a.department !== b.department) {
      return a.department < b.department ? -1 : 1;
    }
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });

  var COLS = 5;
  var headers = ['מוצר', 'מחלקה', 'משקל מוערך (ק״ג)', 'שורות הזמנה', 'הערה'];
  var output = [];
  var totalWeight = 0;

  rows.forEach(function(r) {
    var weight = Math.round(r.weightKg * 100) / 100;
    totalWeight += weight;

    var note = r.unknownUnits > 0
      ? ('כולל ' + formatAmount_(r.unknownUnits) + ' יח׳ ללא הערכת משקל — לשקול ידנית')
      : '';

    output.push([r.name, r.department, weight, r.lines, note]);
  });

  totalWeight = Math.round(totalWeight * 100) / 100;

  var sheet = ss.getSheetByName(WEIGHT_SUMMARY_SHEET_NAME) || ss.insertSheet(WEIGHT_SUMMARY_SHEET_NAME);
  sheet.getDataRange().breakApart();
  sheet.clear();
  applySheetDirection_(sheet);

  sheet.getRange(1, 1, 1, COLS).setValues([['סיכום משקל מוערך', '', '', '', '']]);
  sheet.getRange(1, 1, 1, COLS).merge()
    .setFontWeight('bold')
    .setFontSize(16)
    .setHorizontalAlignment('center')
    .setBackground('#e5f2ec');

  var subtitle = 'עודכן: ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm')
    + ' · המשקלים מוערכים. פריטים שתומחרו לפי יחידה אינם נכללים.';
  sheet.getRange(2, 1, 1, COLS).setValues([[subtitle, '', '', '', '']]);
  sheet.getRange(2, 1, 1, COLS).merge()
    .setHorizontalAlignment('center')
    .setFontColor('#667074');

  sheet.getRange(3, 1, 1, COLS).setValues([headers])
    .setFontWeight('bold')
    .setBackground('#f1f4ef');

  if (output.length) {
    sheet.getRange(4, 1, output.length, COLS).setValues(output);

    var totalRow = 4 + output.length;
    sheet.getRange(totalRow, 1, 1, COLS).setValues([['סה״כ', '', totalWeight, '', '']]);
    sheet.getRange(totalRow, 1, 1, COLS)
      .setFontWeight('bold')
      .setBackground('#e5f2ec');
  } else {
    sheet.getRange(4, 1, 1, COLS).setValues([['אין פריטים לפי משקל בהזמנות.', '', '', '', '']]);
  }

  sheet.setFrozenRows(3);
  sheet.setColumnWidth(1, 240);
  sheet.setColumnWidth(2, 110);
  sheet.setColumnWidth(3, 140);
  sheet.setColumnWidth(4, 110);
  sheet.setColumnWidth(5, 300);

  ui.alert('סיכום המשקל עודכן', 'סוכמו ' + rows.length + ' מוצרים לפי משקל, סה״כ כ-' + totalWeight + ' ק״ג.', ui.ButtonSet.OK);
}

function formatAmount_(value) {
  var rounded = Math.round(value * 100) / 100;
  return isWholeNumber_(rounded) ? String(Math.round(rounded)) : String(rounded);
}

function normalizeCustomerPhone_(value) {
  var digits = String(value || '').replace(/\D/g, '');

  if (digits.indexOf('9725') === 0 && digits.length === 12) {
    return '0' + digits.slice(3);
  }

  return digits;
}

function isValidCustomerPhone_(phone) {
  return /^05\d{8}$/.test(phone);
}

function saveOrder_(payload) {
  payload = payload || {};

  var ss = getSpreadsheet_();
  var productSheet = getProductSheet_(ss);
  var settings = getSettings_(ss, productSheet);
  var products = readProducts_(productSheet);
  var productMap = {};

  products.forEach(function(product) {
    productMap[product.id] = product;
  });

  var customer = payload.customer || {};
  var delivery = payload.delivery || {};
  var items = payload.items || [];
  var fulfillment = String(payload.fulfillment || '').trim();
  var notes = String(payload.notes || '').trim();

  var fullName = String(customer.fullName || '').trim();
  var phone = normalizeCustomerPhone_(customer.phone);
  var customerEmail = String(customer.email || '').trim();

  if (!fullName) {
    throw new Error('חסר שם מלא.');
  }

  if (!isValidCustomerPhone_(phone)) {
    throw new Error('מספר הטלפון הנייד אינו תקין. הזינו מספר שמתחיל ב-05 ובו 10 ספרות.');
  }

  if (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    throw new Error('כתובת המייל אינה תקינה.');
  }

  if (fulfillment === 'איסוף') {
    fulfillment = 'איסוף עצמי';
  }

  if (fulfillment !== 'איסוף עצמי' && fulfillment !== 'משלוח') {
    throw new Error('יש לבחור שיטת הזמנה.');
  }

  if (fulfillment === 'משלוח') {
    if (!String(delivery.address || '').trim()) {
      throw new Error('חסרה כתובת למשלוח.');
    }

    if (!String(delivery.floor || '').trim()) {
      throw new Error('חסרה קומה למשלוח.');
    }
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('לא נבחרו מוצרים להזמנה.');
  }

  var normalizedItems = [];

  items.forEach(function(item) {
    var product = productMap[item.id];

    if (!product) {
      throw new Error('אחד המוצרים אינו קיים יותר בקטלוג. יש לרענן ולנסות שוב.');
    }

    var quantity = parseQuantity_(item.quantity);
    var note = String(item.note || '').trim().slice(0, 300);
    var mode = String(item.mode || '').trim();

    if (!quantity || quantity <= 0) {
      return;
    }

    if (product.unitType === 'unit') {
      mode = 'unit';
    }

    if (product.unitType === 'kg' && mode !== 'kg' && mode !== 'unit') {
      throw new Error('בחירת יחידת הזמנה לא תקינה עבור ' + product.name + '.');
    }

    if (product.unitType !== 'kg' && mode !== 'unit') {
      mode = 'unit';
    }

    if (mode === 'unit' && !isWholeNumber_(quantity)) {
      throw new Error('במוצר ' + product.name + ' יש להזין יחידות במספר שלם.');
    }

    if (mode === 'kg' && !isHalfStep_(quantity)) {
      throw new Error('במוצר ' + product.name + ' יש להזין משקל במספר שלם או חצי.');
    }

    var orderUnit = mode === 'kg' ? 'ק״ג' : 'יחידות';
    var lineTotal = '';

    if (canCalculateLineTotal_(mode, product.priceUnit)) {
      lineTotal = roundMoney_(quantity * product.price);
    }

    normalizedItems.push({
      product: product,
      mode: mode,
      quantity: quantity,
      orderUnit: orderUnit,
      lineTotal: lineTotal,
      note: note
    });
  });

  if (normalizedItems.length === 0) {
    throw new Error('לא נבחרו מוצרים להזמנה.');
  }

  var estimatedTotal = roundMoney_(normalizedItems.reduce(function(total, line) {
    return typeof line.lineTotal === 'number' ? total + line.lineTotal : total;
  }, 0));
  var unpricedItemCount = normalizedItems.filter(function(line) {
    return typeof line.lineTotal !== 'number';
  }).length;

  var now = new Date();
  var timezone = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  var orderId = 'P-' + Utilities.formatDate(now, timezone, 'yyyyMMdd-HHmmss') + '-' + Math.floor(1000 + Math.random() * 9000);

  var ordersSheet = ensureSheet_(ss, PRINOK_CONFIG.ORDERS_SHEET_NAME, getOrderHeaders_());
  var orderItemsSheet = ensureSheet_(ss, PRINOK_CONFIG.ORDER_ITEMS_SHEET_NAME, getOrderItemHeaders_());
  var customerEmailStatus = customerEmail ? 'ממתין לשליחה' : 'לא נמסר מייל';
  var businessEmailStatus = settings.notificationEmails ? 'ממתין לשליחה' : 'לא הוגדר מייל';
  var orderData = {
    timestamp: now,
    orderId: orderId,
    productSheetName: productSheet.getName(),
    fullName: fullName,
    phone: phone,
    email: customerEmail,
    title: settings.title,
    saleName: settings.saleName,
    logoUrl: settings.logoUrl,
    contactPhone: settings.contactPhone,
    contactEmail: settings.contactEmail,
    fulfillment: fulfillment,
    address: String(delivery.address || '').trim(),
    floor: String(delivery.floor || '').trim(),
    apartment: String(delivery.apartment || '').trim(),
    notes: notes,
    itemCount: normalizedItems.length,
    estimatedTotal: estimatedTotal,
    unpricedItemCount: unpricedItemCount
  };
  var orderRowNumber = ordersSheet.getLastRow() + 1;

  ordersSheet.appendRow([
    now,
    orderId,
    productSheet.getName(),
    fullName,
    phone,
    fulfillment,
    orderData.address,
    orderData.floor,
    orderData.apartment,
    notes,
    normalizedItems.length,
    'חדש',
    estimatedTotal,
    unpricedItemCount,
    customerEmail,
    customerEmailStatus,
    '',
    businessEmailStatus,
    '',
    'ממתין לשליחה',
    ''
  ]);

  var itemRows = normalizedItems.map(function(line) {
    return [
      now,
      orderId,
      line.product.name,
      line.product.department,
      line.mode === 'kg' ? 'משקל' : 'יחידות',
      line.quantity,
      line.orderUnit,
      line.product.price,
      line.product.priceUnit || line.product.unit,
      line.lineTotal,
      line.note
    ];
  });

  orderItemsSheet
    .getRange(orderItemsSheet.getLastRow() + 1, 1, itemRows.length, itemRows[0].length)
    .setValues(itemRows);

  appendPickingOrder_(ss, orderData, normalizedItems);
  var businessEmailResult = trySendOrderNotification_(settings, orderData, normalizedItems);
  var customerEmailResult = trySendCustomerCopy_(settings, orderData, normalizedItems);
  var telegramResult = trySendNewOrderTelegramAlert_(settings, orderData, normalizedItems);
  updateBusinessEmailStatus_(ordersSheet, orderRowNumber, businessEmailResult);
  updateCustomerEmailStatus_(ordersSheet, orderRowNumber, customerEmailResult);
  updateTelegramStatus_(ordersSheet, orderRowNumber, telegramResult);

  return {
    ok: true,
    orderId: orderId,
    itemCount: normalizedItems.length,
    estimatedTotal: estimatedTotal,
    unpricedItemCount: unpricedItemCount,
    customerEmailStatus: customerEmailResult.status,
    customerEmailError: customerEmailResult.error
  };
}

function getSpreadsheet_() {
  if (PRINOK_CONFIG.SPREADSHEET_ID) {
    return SpreadsheetApp.openById(PRINOK_CONFIG.SPREADSHEET_ID);
  }

  return SpreadsheetApp.getActiveSpreadsheet();
}

function getProductSheet_(ss) {
  if (PRINOK_CONFIG.PRODUCTS_SHEET_NAME) {
    var namedSheet = ss.getSheetByName(PRINOK_CONFIG.PRODUCTS_SHEET_NAME);

    if (!namedSheet) {
      namedSheet = ensureProductsSheet_(ss);
    }

    return namedSheet;
  }

  var ignored = {};
  ignored[PRINOK_CONFIG.ORDERS_SHEET_NAME] = true;
  ignored[PRINOK_CONFIG.ORDER_ITEMS_SHEET_NAME] = true;
  ignored[PRINOK_CONFIG.PICKING_SHEET_NAME] = true;
  ignored[PRINOK_CONFIG.SETTINGS_SHEET_NAME] = true;

  var sheets = ss.getSheets();
  var fallback = null;

  for (var i = 0; i < sheets.length; i++) {
    var sheet = sheets[i];

    if (ignored[sheet.getName()]) {
      continue;
    }

    if (!fallback) {
      fallback = sheet;
    }

    if (looksLikeProductsSheet_(sheet)) {
      return sheet;
    }
  }

  if (!fallback) {
    throw new Error('לא נמצא גיליון מוצרים.');
  }

  return fallback;
}

function ensureProductsSheet_(ss) {
  var sheetName = PRINOK_CONFIG.PRODUCTS_SHEET_NAME || 'מוצרים';
  var sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 6).setValues([getProductHeaders_()]);
    sheet.setFrozenRows(1);
  }

  applySheetDirection_(sheet);
  return sheet;
}

function looksLikeProductsSheet_(sheet) {
  if (sheet.getLastRow() < 1 || sheet.getLastColumn() < 4) {
    return false;
  }

  var headers = sheet.getRange(1, 1, 1, Math.min(sheet.getLastColumn(), 12)).getValues()[0];
  var map = buildColumnMap_(headers);

  return map.detectedName && map.detectedPrice;
}

function getSettings_(ss, productSheet) {
  var settings = {
    title: PRINOK_CONFIG.DEFAULT_FORM_TITLE,
    description: PRINOK_CONFIG.DEFAULT_FORM_DESCRIPTION,
    closedMessage: PRINOK_CONFIG.DEFAULT_CLOSED_MESSAGE,
    saleName: '',
    pickupText: PRINOK_CONFIG.DEFAULT_PICKUP_TEXT,
    logoUrl: '',
    notificationEmails: '',
    whatsappPhone: '',
    telegramBotToken: '',
    telegramChatId: '',
    contactPhone: PRINOK_CONFIG.DEFAULT_CONTACT_PHONE,
    contactEmail: PRINOK_CONFIG.DEFAULT_CONTACT_EMAIL,
    pricingSpreadsheetName: PRINOK_CONFIG.PRICING_SPREADSHEET_NAME,
    pricingSpreadsheetId: '',
    archiveSpreadsheetName: PRINOK_CONFIG.ARCHIVE_SPREADSHEET_NAME,
    archiveSpreadsheetId: ''
  };

  var sheet = ss.getSheetByName(PRINOK_CONFIG.SETTINGS_SHEET_NAME);

  if (!sheet || sheet.getLastRow() < 2) {
    return settings;
  }

  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();

  values.forEach(function(row) {
    var key = String(row[0] || '').trim();
    var value = String(row[1] || '').trim();

    if (!key || !value) {
      return;
    }

    if (key === 'כותרת') {
      settings.title = value;
      return;
    }

    if (key === 'תיאור') {
      settings.description = value;
      return;
    }

    if (key === 'הודעה כשההזמנות סגורות' || key === 'הודעת סגירה' || key === 'הודעה לפני פתיחת הזמנות') {
      settings.closedMessage = value;
      return;
    }

    if (key === 'שם מכירה') {
      settings.saleName = value;
      return;
    }

    if (key === 'פרטי איסוף') {
      settings.pickupText = value;
      return;
    }

    if (key === 'לוגו' || key === 'לוגו URL' || key === 'קישור לוגו') {
      settings.logoUrl = value;
      return;
    }

    if (key === 'אימייל התראות' || key === 'מייל התראות' || key === 'Email notifications') {
      settings.notificationEmails = value;
      return;
    }

    if (key === 'טלפון וואטסאפ' || key === 'וואטסאפ התראות') {
      settings.whatsappPhone = value;
      return;
    }

    if (key === 'טלגרם בוט טוקן' || key === 'Telegram bot token') {
      settings.telegramBotToken = value;
      return;
    }

    if (key === 'טלגרם צ׳אט ID' || key === 'טלגרם צאט ID' || key === 'Telegram chat ID') {
      settings.telegramChatId = value;
      return;
    }

    if (key === 'טלפון ליצירת קשר' || key === 'טלפון קשר') {
      settings.contactPhone = value;
      return;
    }

    if (key === 'מייל ליצירת קשר' || key === 'אימייל ליצירת קשר') {
      settings.contactEmail = value;
      return;
    }

    if (key === 'שם קובץ חישוב מחירים' || key === 'קובץ חישוב מחירים') {
      settings.pricingSpreadsheetName = value;
      return;
    }

    if (key === 'קישור קובץ חישוב מחירים' || key === 'מזהה קובץ חישוב מחירים' || key === 'קישור/מזהה קובץ חישוב מחירים') {
      settings.pricingSpreadsheetId = value;
      return;
    }

    if (key === 'שם קובץ ארכיון' || key === 'קובץ ארכיון') {
      settings.archiveSpreadsheetName = value;
      return;
    }

    if (key === 'קישור קובץ ארכיון' || key === 'מזהה קובץ ארכיון' || key === 'קישור/מזהה קובץ ארכיון') {
      settings.archiveSpreadsheetId = value;
    }
  });

  return settings;
}

function ensureSettingsSheet_(ss) {
  var sheet = ss.getSheetByName(PRINOK_CONFIG.SETTINGS_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(PRINOK_CONFIG.SETTINGS_SHEET_NAME);
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 2).setValues([['פרמטר', 'ערך']]);
    sheet.setFrozenRows(1);
  }

  upsertSettingRows_(sheet, [
    ['כותרת', PRINOK_CONFIG.DEFAULT_FORM_TITLE],
    ['תיאור', PRINOK_CONFIG.DEFAULT_FORM_DESCRIPTION],
    ['הודעה כשההזמנות סגורות', PRINOK_CONFIG.DEFAULT_CLOSED_MESSAGE],
    ['שם מכירה', ''],
    ['פרטי איסוף', PRINOK_CONFIG.DEFAULT_PICKUP_TEXT],
    ['לוגו', ''],
    ['אימייל התראות', ''],
    ['טלפון וואטסאפ', ''],
    ['טלגרם בוט טוקן', ''],
    ['טלגרם צ׳אט ID', ''],
    ['טלפון ליצירת קשר', PRINOK_CONFIG.DEFAULT_CONTACT_PHONE],
    ['מייל ליצירת קשר', PRINOK_CONFIG.DEFAULT_CONTACT_EMAIL],
    ['שם קובץ חישוב מחירים', PRINOK_CONFIG.PRICING_SPREADSHEET_NAME],
    ['קישור/מזהה קובץ חישוב מחירים', ''],
    ['שם קובץ ארכיון', PRINOK_CONFIG.ARCHIVE_SPREADSHEET_NAME],
    ['קישור/מזהה קובץ ארכיון', '']
  ]);

  applySheetDirection_(sheet);
  return sheet;
}

function upsertSettingRows_(sheet, rows) {
  var lastRow = sheet.getLastRow();
  var existing = {};

  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, 1).getValues().forEach(function(row) {
      var key = String(row[0] || '').trim();

      if (key) {
        existing[key] = true;
      }
    });
  }

  var missing = rows.filter(function(row) {
    return !existing[row[0]];
  });

  if (missing.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, missing.length, 2).setValues(missing);
  }
}

function refreshProductsFromPricingFile_() {
  var ss = getSpreadsheet_();
  var productSheet = ensureProductsSheet_(ss);
  var settings = getSettings_(ss, productSheet);
  var saleName = String(settings.saleName || '').trim();

  if (!saleName) {
    throw new Error('חסר "שם מכירה" בגיליון הגדרות. שם המכירה חייב להיות זהה לשם הגיליון בקובץ חישוב מחירים.');
  }

  var pricingSpreadsheet = openPricingSpreadsheet_(settings);
  var sourceSheet = pricingSpreadsheet.getSheetByName(saleName);

  if (!sourceSheet) {
    clearProductsForClosedSale_(productSheet);

    return {
      fileName: pricingSpreadsheet.getName(),
      sheetName: saleName,
      rowCount: 0,
      isOpen: false
    };
  }

  var lastRow = sourceSheet.getLastRow();
  var lastColumn = sourceSheet.getLastColumn();

  if (lastRow < 1 || lastColumn < 1) {
    throw new Error('הגיליון "' + saleName + '" בקובץ חישוב מחירים ריק.');
  }

  var sourceValues = sourceSheet.getRange(1, 1, lastRow, lastColumn).getValues();
  var targetHeaders = getCurrentProductHeaders_(productSheet);
  var mappedValues = mapPricingValuesToProducts_(sourceValues, targetHeaders);

  productSheet.clearContents();
  productSheet.getRange(1, 1, mappedValues.length, mappedValues[0].length).setValues(mappedValues);
  productSheet.setFrozenRows(1);
  applySheetDirection_(productSheet);

  return {
    fileName: pricingSpreadsheet.getName(),
    sheetName: sourceSheet.getName(),
    rowCount: Math.max(mappedValues.length - 1, 0),
    isOpen: true
  };
}

function clearProductsForClosedSale_(productSheet) {
  var headers = getCurrentProductHeaders_(productSheet);

  productSheet.clearContents();
  productSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  productSheet.setFrozenRows(1);
  applySheetDirection_(productSheet);
}

function getCurrentProductHeaders_(productSheet) {
  if (productSheet.getLastRow() < 1 || productSheet.getLastColumn() < 1) {
    return getProductHeaders_();
  }

  var headers = productSheet
    .getRange(1, 1, 1, Math.max(productSheet.getLastColumn(), getProductHeaders_().length))
    .getValues()[0]
    .map(function(header) {
      return String(header || '').trim();
    })
    .filter(function(header) {
      return header;
    });

  return headers.length ? headers : getProductHeaders_();
}

function mapPricingValuesToProducts_(sourceValues, targetHeaders) {
  if (!sourceValues.length) {
    return [targetHeaders];
  }

  var sourceHeaders = sourceValues[0].map(function(header) {
    return String(header || '').trim();
  });
  var sourceMap = {};

  sourceHeaders.forEach(function(header, index) {
    if (header) {
      sourceMap[normalizeHeader_(header)] = index;
    }
  });

  var columnIndexes = targetHeaders.map(function(targetHeader) {
    var candidates = getPricingSourceHeaderCandidates_(targetHeader);

    for (var i = 0; i < candidates.length; i++) {
      var key = normalizeHeader_(candidates[i]);

      if (Object.prototype.hasOwnProperty.call(sourceMap, key)) {
        return sourceMap[key];
      }
    }

    return null;
  });

  var missingRequired = [];

  targetHeaders.forEach(function(header, index) {
    if (['שם', 'מחלקה', 'יחידת מכירה', 'מחיר'].indexOf(header) !== -1 && columnIndexes[index] === null) {
      missingRequired.push(header === 'מחיר' ? 'מחיר לצרכן' : header);
    }
  });

  if (missingRequired.length) {
    throw new Error('חסרות בקובץ חישוב מחירים עמודות חובה: ' + missingRequired.join(', '));
  }

  var output = [targetHeaders];

  for (var rowIndex = 1; rowIndex < sourceValues.length; rowIndex++) {
    var sourceRow = sourceValues[rowIndex];
    var targetRow = columnIndexes.map(function(sourceIndex) {
      return sourceIndex === null ? '' : sourceRow[sourceIndex];
    });
    var hasContent = targetRow.some(function(value) {
      return String(value || '').trim();
    });

    if (hasContent) {
      output.push(targetRow);
    }
  }

  return output;
}

function getPricingSourceHeaderCandidates_(targetHeader) {
  if (targetHeader === 'מחיר') {
    return ['מחיר לצרכן', 'מחיר'];
  }

  return [targetHeader];
}

function openPricingSpreadsheet_(settings) {
  var explicitId = extractSpreadsheetId_(settings.pricingSpreadsheetId);

  if (explicitId) {
    return SpreadsheetApp.openById(explicitId);
  }

  var fileName = settings.pricingSpreadsheetName || PRINOK_CONFIG.PRICING_SPREADSHEET_NAME;
  var files = DriveApp.getFilesByName(fileName);

  while (files.hasNext()) {
    var file = files.next();

    try {
      return SpreadsheetApp.openById(file.getId());
    } catch (error) {
    }
  }

  throw new Error('לא נמצא קובץ Google Sheets בשם "' + fileName + '". אפשר להדביק את הקישור או המזהה שלו בגיליון הגדרות.');
}

function extractSpreadsheetId_(value) {
  var text = String(value || '').trim();

  if (!text) {
    return '';
  }

  var match = text.match(/\/d\/([a-zA-Z0-9-_]+)/);

  if (match) {
    return match[1];
  }

  return text;
}

function ensurePickingSheet_(ss) {
  var sheet = ss.getSheetByName(PRINOK_CONFIG.PICKING_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(PRINOK_CONFIG.PICKING_SHEET_NAME);
  }

  if (sheet.getLastRow() === 0) {
    setupPickingSheet_(sheet);
  }

  applySheetDirection_(sheet);
  return sheet;
}

function setupPickingSheet_(sheet) {
  sheet.getRange(1, 1, 1, 6).setValues([['דפי ליקוט להזמנות', '', '', '', '', '']]);
  sheet.getRange(1, 1, 1, 6)
    .merge()
    .setFontWeight('bold')
    .setFontSize(16)
    .setHorizontalAlignment('center')
    .setBackground('#e5f2ec');
  sheet.setFrozenRows(1);
  sheet.setColumnWidths(1, 6, 130);
  sheet.setColumnWidth(1, 220);
  sheet.setColumnWidth(2, 110);
  sheet.setColumnWidth(3, 80);
  sheet.setColumnWidth(4, 100);
  sheet.setColumnWidth(5, 120);
  sheet.setColumnWidth(6, 130);
}

function appendPickingOrder_(ss, order, items) {
  var rows = buildPickingRows_(order, items);
  var sheet = ensurePickingSheet_(ss);
  var startRow = sheet.getLastRow() + 2;

  sheet.getRange(startRow, 1, rows.length, 6).setValues(rows);
  formatPickingBlock_(sheet, startRow, rows.length);
}

function appendPickingOrderFromRows_(ss, orderRow, itemRows) {
  var order = {
    timestamp: orderRow['זמן'],
    orderId: orderRow['מספר הזמנה'],
    productSheetName: orderRow['גיליון מוצרים'],
    fullName: orderRow['שם מלא'],
    phone: orderRow['טלפון'],
    fulfillment: orderRow['שיטת הזמנה'],
    address: orderRow['כתובת'],
    floor: orderRow['קומה'],
    apartment: orderRow['דירה'],
    notes: orderRow['הערות'],
    itemCount: orderRow['מספר שורות'],
    estimatedTotal: parsePrice_(orderRow['סכום משוער']),
    unpricedItemCount: Number(orderRow['פריטים ללא חישוב'] || 0)
  };
  var items = itemRows.map(function(itemRow) {
    return {
      product: {
        name: itemRow['מוצר'],
        department: itemRow['מחלקה'],
        price: itemRow['מחיר מהגיליון'],
        priceUnit: itemRow['יחידת מחיר']
      },
      quantity: itemRow['כמות'],
      orderUnit: itemRow['יחידת הזמנה'],
      lineTotal: typeof itemRow['סכום מחושב'] === 'number' ? itemRow['סכום מחושב'] : '',
      note: String(itemRow['הערת מוצר'] || '').trim()
    };
  });

  appendPickingOrder_(ss, order, items);
}

function buildPickingRows_(order, items) {
  var addressText = buildAddressText_(order);
  var totalText = formatEstimatedTotal_(order.estimatedTotal, order.unpricedItemCount);
  var rows = [
    ['מספר הזמנה', order.orderId, 'לקוח', order.fullName, 'טלפון', order.phone],
    ['שיטת הזמנה', order.fulfillment, 'כתובת/איסוף', addressText, 'סכום משוער', totalText],
    ['הערות', order.notes || '', '', '', '', ''],
    ['מוצר', 'מחלקה', 'כמות', 'יחידה', 'מחיר', 'סכום']
  ];

  items.forEach(function(line) {
    var productText = line.note
      ? line.product.name + '\nהערה: ' + line.note
      : line.product.name;

    rows.push([
      productText,
      line.product.department,
      formatQuantity_(line.quantity),
      line.orderUnit,
      formatMoney_(line.product.price) + ' / ' + (line.product.priceUnit || ''),
      typeof line.lineTotal === 'number' ? formatMoney_(line.lineTotal) : 'לפי חישוב בפועל'
    ]);
  });

  return rows;
}

function formatPickingBlock_(sheet, startRow, rowCount) {
  sheet.getRange(startRow, 1, rowCount, 6)
    .setBorder(true, true, true, true, true, true, '#d9ded6', SpreadsheetApp.BorderStyle.SOLID)
    .setVerticalAlignment('middle');
  sheet.getRange(startRow, 1, 3, 6).setBackground('#f7f6f1');
  sheet.getRange(startRow, 1, 3, 6).setFontWeight('bold');
  sheet.getRange(startRow + 3, 1, 1, 6)
    .setBackground('#1f7a5a')
    .setFontColor('#ffffff')
    .setFontWeight('bold');
  sheet.getRange(startRow, 1, rowCount, 6).setWrap(true);
}

function trySendOrderNotification_(settings, order, items) {
  if (!settings.notificationEmails) {
    return {
      status: 'לא הוגדר מייל',
      error: ''
    };
  }

  try {
    var subject = 'הזמנה חדשה מפרינוּק - ' + order.fullName + ' - ' + order.orderId;
    var body = buildNotificationBody_(order, items);
    var emailAssets = getEmailInlineImageAssets_(settings);
    var pdf = createOrderPdfSafely_(settings, order, items);
    var options = {
      to: settings.notificationEmails,
      subject: subject,
      body: body,
      htmlBody: buildNotificationHtmlBody_(settings, order, items, emailAssets.logoCid)
    };

    if (pdf) {
      options.attachments = [pdf];
    }

    applyEmailInlineImageAssets_(options, emailAssets);
    var sendResult = sendEmailSafely_(options);

    return {
      status: sendResult.usedFallback ? 'נשלח ללא לוגו' : 'נשלח ל-Google',
      error: sendResult.usedFallback ? 'שליחת HTML נכשלה: ' + sendResult.firstError : ''
    };
  } catch (error) {
    Logger.log('שליחת מייל התראה נכשלה: ' + error.message);
    return {
      status: 'נכשל',
      error: error.message
    };
  }
}

function trySendNewOrderTelegramAlert_(settings, order, items) {
  return sendTelegramOrderAlert_(settings, order, items);
}

function trySendEmailProblemTelegramAlert_(settings, order, items, target, errorText) {
  return sendTelegramMessage_(settings, buildEmailProblemTelegramMessage_(settings, order, items, target, errorText));
}

function sendTelegramOrderAlert_(settings, order, items) {
  var message = buildNewOrderTelegramMessage_(settings, order, items);
  var textResult = sendTelegramMessage_(settings, message);

  if (textResult.status !== 'נשלח לטלגרם') {
    return textResult;
  }

  var pdf = createOrderPdfSafely_(settings, order, items);

  if (!pdf) {
    return {
      status: 'נשלח לטלגרם',
      error: 'הודעת הטלגרם נשלחה, אבל יצירת ה-PDF נכשלה.'
    };
  }

  var documentResult = sendTelegramDocument_(settings, pdf, buildTelegramDocumentCaption_(order, items));

  if (documentResult.status !== 'נשלח לטלגרם') {
    return {
      status: 'נשלח לטלגרם',
      error: 'הודעת הטלגרם נשלחה, אבל שליחת ה-PDF נכשלה: ' + (documentResult.error || 'לא ידוע')
    };
  }

  return {
    status: 'נשלח לטלגרם',
    error: ''
  };
}

function sendTelegramMessage_(settings, message) {
  var token = String(settings.telegramBotToken || '').trim();
  var chatId = String(settings.telegramChatId || '').trim();

  if (!token || !chatId) {
    return {
      status: 'לא הוגדר טלגרם',
      error: ''
    };
  }

  try {
    var response = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post',
      muteHttpExceptions: true,
      payload: {
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: 'true'
      }
    });
    var code = response.getResponseCode();

    if (code < 200 || code >= 300) {
      return {
        status: 'נכשל',
        error: 'Telegram HTTP ' + code + ': ' + response.getContentText()
      };
    }

    return {
      status: 'נשלח לטלגרם',
      error: ''
    };
  } catch (error) {
    return {
      status: 'נכשל',
      error: error.message
    };
  }
}

function sendTelegramDocument_(settings, documentBlob, caption) {
  var token = String(settings.telegramBotToken || '').trim();
  var chatId = String(settings.telegramChatId || '').trim();

  if (!token || !chatId) {
    return {
      status: 'לא הוגדר טלגרם',
      error: ''
    };
  }

  if (!documentBlob) {
    return {
      status: 'נכשל',
      error: 'לא נוצר קובץ PDF'
    };
  }

  try {
    var payload = {
      chat_id: chatId,
      document: documentBlob
    };

    if (caption) {
      payload.caption = caption;
      payload.parse_mode = 'HTML';
    }

    var response = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendDocument', {
      method: 'post',
      muteHttpExceptions: true,
      payload: payload
    });
    var code = response.getResponseCode();

    if (code < 200 || code >= 300) {
      return {
        status: 'נכשל',
        error: 'Telegram HTTP ' + code + ': ' + response.getContentText()
      };
    }

    return {
      status: 'נשלח לטלגרם',
      error: ''
    };
  } catch (error) {
    return {
      status: 'נכשל',
      error: error.message
    };
  }
}

function buildNewOrderTelegramMessage_(settings, order, items) {
  var lines = [
    '<b>הזמנה חדשה בפרינוּק</b>',
    'מספר הזמנה: ' + escapeTelegramHtml_(order.orderId),
    'לקוח: ' + escapeTelegramHtml_(order.fullName),
    'טלפון: ' + escapeTelegramHtml_(order.phone),
    'שיטת הזמנה: ' + escapeTelegramHtml_(order.fulfillment),
    'סכום משוער: ' + escapeTelegramHtml_(formatEstimatedTotal_(order.estimatedTotal, order.unpricedItemCount)),
    'מספר שורות: ' + escapeTelegramHtml_(String(items.length)),
    ''
  ];

  if (order.fulfillment === 'משלוח') {
    lines.push('כתובת: ' + escapeTelegramHtml_(buildAddressText_(order)));
  }

  if (order.notes) {
    lines.push('הערות: ' + escapeTelegramHtml_(order.notes));
  }

  return lines.join('\n');
}

function buildEmailProblemTelegramMessage_(settings, order, items, target, errorText) {
  var targetText = target === 'customer' ? 'מייל ללקוח' : 'מייל פרינוּק';
  return [
    '<b>בעיה דחופה בשליחת מייל</b>',
    'סוג תקלה: ' + escapeTelegramHtml_(targetText),
    'מספר הזמנה: ' + escapeTelegramHtml_(order.orderId),
    'לקוח: ' + escapeTelegramHtml_(order.fullName),
    'טלפון: ' + escapeTelegramHtml_(order.phone),
    order.email ? 'מייל לקוח: ' + escapeTelegramHtml_(order.email) : '',
    'שגיאה: ' + escapeTelegramHtml_(errorText || 'לא ידוע')
  ].filter(function(line) {
    return line;
  }).join('\n');
}

function buildTelegramDocumentCaption_(order, items) {
  return [
    '<b>PDF להזמנה חדשה</b>',
    'מספר הזמנה: ' + escapeTelegramHtml_(order.orderId),
    'לקוח: ' + escapeTelegramHtml_(order.fullName),
    'שורות: ' + escapeTelegramHtml_(String(items.length))
  ].join('\n');
}

function escapeTelegramHtml_(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function trySendCustomerCopy_(settings, order, items) {
  if (!order.email) {
    return {
      status: 'לא נמסר מייל',
      error: ''
    };
  }

  try {
    var subject = 'ההזמנה שלך בפרינוּק התקבלה - ' + order.orderId;
    var body = buildCustomerCopyBody_(order, items);
    var emailAssets = getEmailInlineImageAssets_(settings);
    var pdf = createOrderPdfSafely_(settings, order, items);
    var replyTo = String(settings.contactEmail || settings.notificationEmails || '').trim();
    var options = {
      to: order.email,
      subject: subject,
      body: body,
      htmlBody: buildCustomerCopyHtmlBody_(settings, order, items, emailAssets.logoCid),
      name: 'פרינוּק - המכירה השבועית'
    };

    if (pdf) {
      options.attachments = [pdf];
    }

    if (replyTo) {
      options.replyTo = replyTo;
    }

    applyEmailInlineImageAssets_(options, emailAssets);
    var sendResult = sendEmailSafely_(options);

    return {
      status: sendResult.usedFallback ? 'נשלח ללא לוגו' : 'נשלח ל-Google',
      error: sendResult.usedFallback ? 'שליחת HTML נכשלה: ' + sendResult.firstError : ''
    };
  } catch (error) {
    Logger.log('שליחת עותק מייל ללקוח נכשלה: ' + error.message);
    return {
      status: 'נכשל',
      error: error.message
    };
  }
}

function updateCustomerEmailStatus_(ordersSheet, orderRowNumber, result) {
  result = result || {
    status: '',
    error: ''
  };

  var headers = getOrderHeaders_();
  var statusColumn = headers.indexOf('סטטוס מייל לקוח') + 1;
  var errorColumn = headers.indexOf('שגיאת מייל לקוח') + 1;

  if (statusColumn > 0) {
    ordersSheet.getRange(orderRowNumber, statusColumn).setValue(result.status || '');
  }

  if (errorColumn > 0) {
    ordersSheet.getRange(orderRowNumber, errorColumn).setValue(result.error || '');
  }
}

function updateBusinessEmailStatus_(ordersSheet, orderRowNumber, result) {
  result = result || {
    status: '',
    error: ''
  };

  var headers = getOrderHeaders_();
  var statusColumn = headers.indexOf('סטטוס מייל פרינוק') + 1;
  var errorColumn = headers.indexOf('שגיאת מייל פרינוק') + 1;

  if (statusColumn > 0) {
    ordersSheet.getRange(orderRowNumber, statusColumn).setValue(result.status || '');
  }

  if (errorColumn > 0) {
    ordersSheet.getRange(orderRowNumber, errorColumn).setValue(result.error || '');
  }
}

function updateTelegramStatus_(ordersSheet, orderRowNumber, result) {
  result = result || {
    status: '',
    error: ''
  };

  var headers = getOrderHeaders_();
  var statusColumn = headers.indexOf('סטטוס טלגרם פרינוק') + 1;
  var errorColumn = headers.indexOf('שגיאת טלגרם פרינוק') + 1;

  if (statusColumn > 0) {
    ordersSheet.getRange(orderRowNumber, statusColumn).setValue(result.status || '');
  }

  if (errorColumn > 0) {
    ordersSheet.getRange(orderRowNumber, errorColumn).setValue(result.error || '');
  }
}

function createOrderPdf_(settings, order, items) {
  var html = buildOrderPdfHtml_(settings, order, items);

  return Utilities
    .newBlob(html, 'text/html', 'order-' + order.orderId + '.html')
    .getAs('application/pdf')
    .setName('הזמנה-' + safeFileName_(order.fullName) + '-' + order.orderId + '.pdf');
}

function createOrderPdfSafely_(settings, order, items) {
  try {
    return createOrderPdf_(settings, order, items);
  } catch (error) {
    Logger.log('יצירת PDF להזמנה נכשלה, המייל יישלח ללא קובץ מצורף: ' + error.message);
    return null;
  }
}

function buildOrderPdfHtml_(settings, order, items) {
  var rows = items.map(function(line) {
    var total = typeof line.lineTotal === 'number' ? formatMoney_(line.lineTotal) : 'לפי חישוב בפועל';
    var noteHtml = line.note
      ? '<div style="font-size:11px;color:#667074;margin-top:3px;">הערה: ' + escapeHtml_(line.note) + '</div>'
      : '';

    return [
      '<tr>',
      '<td>', escapeHtml_(line.product.name), noteHtml, '</td>',
      '<td>', escapeHtml_(line.product.department), '</td>',
      '<td>', escapeHtml_(formatQuantity_(line.quantity)), '</td>',
      '<td>', escapeHtml_(line.orderUnit), '</td>',
      '<td>', escapeHtml_(formatMoney_(line.product.price) + ' / ' + (line.product.priceUnit || '')), '</td>',
      '<td>', escapeHtml_(total), '</td>',
      '</tr>'
    ].join('');
  }).join('');

  return [
    '<!doctype html>',
    '<html dir="rtl" lang="he">',
    '<head>',
    '<meta charset="UTF-8">',
    '<style>',
    'body{font-family:Arial,Helvetica,sans-serif;color:#1e2528;margin:28px;line-height:1.45;}',
    getDocumentHeaderCss_(),
    '.box{border:1px solid #d9ded6;border-radius:8px;padding:14px;margin-bottom:16px;background:#f7f6f1;}',
    '.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;}',
    '.label{font-weight:bold;color:#165a43;}',
    'table{width:100%;border-collapse:collapse;margin-top:14px;}',
    'th{background:#1f7a5a;color:#fff;}',
    'th,td{border:1px solid #d9ded6;padding:8px;text-align:right;vertical-align:top;}',
    'tr:nth-child(even) td{background:#fbfcfa;}',
    '.notes{white-space:pre-wrap;}',
    '.total{font-size:18px;font-weight:bold;color:#165a43;}',
    '.notice{border:1px solid #d7e5db;background:#e5f2ec;color:#165a43;border-radius:8px;padding:10px 12px;margin-bottom:16px;font-weight:bold;}',
    '</style>',
    '</head>',
    '<body>',
    buildDocumentHeaderHtml_(settings, 'פרינוּק - פרטי הזמנה', [order.orderId]),
    '<div class="box grid">',
    '<div><span class="label">לקוח:</span> ', escapeHtml_(order.fullName), '</div>',
    '<div><span class="label">טלפון:</span> ', escapeHtml_(order.phone), '</div>',
    order.email ? '<div><span class="label">מייל:</span> ' + escapeHtml_(order.email) + '</div>' : '',
    '<div><span class="label">שיטת הזמנה:</span> ', escapeHtml_(order.fulfillment), '</div>',
    '<div><span class="label">כתובת/איסוף:</span> ', escapeHtml_(buildAddressText_(order)), '</div>',
    '<div><span class="label">סכום משוער:</span> <span class="total">', escapeHtml_(formatEstimatedTotal_(order.estimatedTotal, order.unpricedItemCount)), '</span></div>',
    '<div><span class="label">זמן הזמנה:</span> ', escapeHtml_(formatDateTime_(order.timestamp)), '</div>',
    '</div>',
    '<div class="notice">', escapeHtml_(getBillingNotice_()), '</div>',
    order.notes ? '<div class="box notes"><span class="label">הערות:</span><br>' + escapeHtml_(order.notes) + '</div>' : '',
    '<table>',
    '<thead><tr><th>מוצר</th><th>מחלקה</th><th>כמות</th><th>יחידה</th><th>מחיר</th><th>סכום</th></tr></thead>',
    '<tbody>', rows, '</tbody>',
    '</table>',
    '</body>',
    '</html>'
  ].join('');
}

function buildNotificationBody_(order, items) {
  var lines = [
    'התקבלה הזמנה חדשה.',
    '',
    'מספר הזמנה: ' + order.orderId,
    'לקוח: ' + order.fullName,
    'טלפון: ' + order.phone,
    order.email ? 'מייל לקוח: ' + order.email : '',
    'שיטת הזמנה: ' + order.fulfillment,
    'כתובת/איסוף: ' + buildAddressText_(order),
    'סכום משוער: ' + formatEstimatedTotal_(order.estimatedTotal, order.unpricedItemCount),
    getBillingNotice_(),
    order.notes ? 'הערות: ' + order.notes : '',
    '',
    'מוצרים:'
  ].filter(function(line) {
    return line !== '';
  });

  items.forEach(function(line) {
    var total = typeof line.lineTotal === 'number' ? formatMoney_(line.lineTotal) : 'לפי חישוב בפועל';
    lines.push('- ' + line.product.name + ': ' + formatQuantity_(line.quantity) + ' ' + line.orderUnit + ' | ' + total);
    if (line.note) {
      lines.push('  הערה: ' + line.note);
    }
  });

  return lines.join('\n');
}

function buildCustomerCopyBody_(order, items) {
  var lines = [
    'שלום ' + order.fullName + ',',
    '',
    'ההזמנה שלך בפרינוּק התקבלה בהצלחה.',
    'מספר הזמנה: ' + order.orderId,
    'שיטת הזמנה: ' + order.fulfillment,
    'כתובת/איסוף: ' + buildAddressText_(order),
    'סכום משוער: ' + formatEstimatedTotal_(order.estimatedTotal, order.unpricedItemCount),
    getBillingNotice_(),
    '',
    'מוצרים:'
  ];

  items.forEach(function(line) {
    var total = typeof line.lineTotal === 'number' ? formatMoney_(line.lineTotal) : 'לפי חישוב בפועל';
    lines.push('- ' + line.product.name + ': ' + formatQuantity_(line.quantity) + ' ' + line.orderUnit + ' | ' + total);
    if (line.note) {
      lines.push('  הערה: ' + line.note);
    }
  });

  lines.push('');
  lines.push('מצורף PDF עם פרטי ההזמנה.');
  lines.push('תודה, פרינוּק');

  return lines.join('\n');
}

function buildNotificationHtmlBody_(settings, order, items, logoCid) {
  return buildOrderEmailHtml_(
    settings,
    'התקבלה הזמנה חדשה',
    'התקבלה הזמנה חדשה בפרינוּק.',
    order,
    items,
    logoCid
  );
}

function buildCustomerCopyHtmlBody_(settings, order, items, logoCid) {
  return buildOrderEmailHtml_(
    settings,
    'ההזמנה שלך התקבלה',
    'שלום ' + order.fullName + ', ההזמנה שלך בפרינוּק התקבלה בהצלחה.',
    order,
    items,
    logoCid
  );
}

function buildOrderEmailHtml_(settings, title, intro, order, items, logoCid) {
  var contactText = buildDocumentContactText_(settings);
  var rows = items.map(function(line) {
    var total = typeof line.lineTotal === 'number' ? formatMoney_(line.lineTotal) : 'לפי חישוב בפועל';
    var noteHtml = line.note
      ? '<div style="font-size:12px;color:#667074;margin-top:3px;font-weight:normal;">הערה: ' + escapeHtml_(line.note) + '</div>'
      : '';

    return [
      '<tr>',
      '<td style="border:1px solid #d9ded6;padding:8px;text-align:right;font-weight:bold;">', escapeHtml_(line.product.name), noteHtml, '</td>',
      '<td style="border:1px solid #d9ded6;padding:8px;text-align:right;">', escapeHtml_(formatQuantity_(line.quantity)), '</td>',
      '<td style="border:1px solid #d9ded6;padding:8px;text-align:right;">', escapeHtml_(line.orderUnit), '</td>',
      '<td style="border:1px solid #d9ded6;padding:8px;text-align:right;">', escapeHtml_(total), '</td>',
      '</tr>'
    ].join('');
  }).join('');
  var logoHtml = logoCid
    ? '<img src="cid:' + escapeHtml_(logoCid) + '" alt="פרינוּק" width="76" height="76" style="display:block;width:76px;height:76px;object-fit:contain;border:0;">'
    : '';

  return [
    '<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;color:#1e2528;line-height:1.45;background:#ffffff;">',
    '<div style="max-width:720px;margin:0 auto;padding:18px;">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border-bottom:3px solid #1f7a5a;margin-bottom:18px;">',
    '<tr>',
    '<td style="width:92px;padding:0 0 12px;text-align:center;vertical-align:middle;">', logoHtml, '</td>',
    '<td style="padding:0 12px 12px;text-align:center;vertical-align:middle;">',
    '<div style="font-size:26px;font-weight:800;color:#1e2528;">', escapeHtml_(title), '</div>',
    '<div style="font-size:15px;font-weight:700;color:#165a43;margin-top:4px;">פרינוּק - המכירה השבועית</div>',
    contactText ? '<div style="font-size:13px;font-weight:700;color:#165a43;margin-top:4px;">' + escapeHtml_(contactText) + '</div>' : '',
    '</td>',
    '</tr>',
    '</table>',
    '<p style="font-size:16px;font-weight:700;margin:0 0 14px;">', escapeHtml_(intro), '</p>',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#f7f6f1;border:1px solid #d9ded6;border-radius:8px;margin-bottom:14px;">',
    '<tr><td style="padding:8px;font-weight:bold;color:#165a43;">מספר הזמנה:</td><td style="padding:8px;">', escapeHtml_(order.orderId), '</td></tr>',
    '<tr><td style="padding:8px;font-weight:bold;color:#165a43;">לקוח:</td><td style="padding:8px;">', escapeHtml_(order.fullName), '</td></tr>',
    '<tr><td style="padding:8px;font-weight:bold;color:#165a43;">טלפון:</td><td style="padding:8px;">', escapeHtml_(order.phone), '</td></tr>',
    order.email ? '<tr><td style="padding:8px;font-weight:bold;color:#165a43;">מייל:</td><td style="padding:8px;">' + escapeHtml_(order.email) + '</td></tr>' : '',
    '<tr><td style="padding:8px;font-weight:bold;color:#165a43;">שיטת הזמנה:</td><td style="padding:8px;">', escapeHtml_(order.fulfillment), '</td></tr>',
    '<tr><td style="padding:8px;font-weight:bold;color:#165a43;">כתובת/איסוף:</td><td style="padding:8px;">', escapeHtml_(buildAddressText_(order)), '</td></tr>',
    '<tr><td style="padding:8px;font-weight:bold;color:#165a43;">סכום משוער:</td><td style="padding:8px;font-weight:800;color:#165a43;">', escapeHtml_(formatEstimatedTotal_(order.estimatedTotal, order.unpricedItemCount)), '</td></tr>',
    '</table>',
    '<div style="border:1px solid #d7e5db;background:#e5f2ec;color:#165a43;border-radius:8px;padding:10px 12px;margin-bottom:14px;font-weight:bold;">', escapeHtml_(getBillingNotice_()), '</div>',
    order.notes ? '<div style="border:1px solid #d9ded6;border-radius:8px;padding:10px 12px;margin-bottom:14px;"><b style="color:#165a43;">הערות:</b><br>' + escapeHtml_(order.notes) + '</div>' : '',
    '<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-top:12px;">',
    '<thead><tr>',
    '<th style="border:1px solid #1f7a5a;background:#1f7a5a;color:#ffffff;padding:8px;text-align:right;">מוצר</th>',
    '<th style="border:1px solid #1f7a5a;background:#1f7a5a;color:#ffffff;padding:8px;text-align:right;">כמות</th>',
    '<th style="border:1px solid #1f7a5a;background:#1f7a5a;color:#ffffff;padding:8px;text-align:right;">יחידה</th>',
    '<th style="border:1px solid #1f7a5a;background:#1f7a5a;color:#ffffff;padding:8px;text-align:right;">סכום</th>',
    '</tr></thead>',
    '<tbody>', rows, '</tbody>',
    '</table>',
    '<p style="margin:16px 0 0;color:#667074;">מצורף PDF עם פרטי ההזמנה.</p>',
    '</div>',
    '</div>'
  ].join('');
}

function buildSimpleEmailHtml_(settings, title, paragraphs, logoCid) {
  var contactText = buildDocumentContactText_(settings);
  var logoHtml = logoCid
    ? '<img src="cid:' + escapeHtml_(logoCid) + '" alt="פרינוּק" width="76" height="76" style="display:block;width:76px;height:76px;object-fit:contain;border:0;">'
    : '';
  var paragraphHtml = (paragraphs || []).map(function(paragraph) {
    return '<p style="margin:0 0 10px;font-size:15px;">' + escapeHtml_(paragraph) + '</p>';
  }).join('');

  return [
    '<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;color:#1e2528;line-height:1.45;background:#ffffff;">',
    '<div style="max-width:680px;margin:0 auto;padding:18px;">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border-bottom:3px solid #1f7a5a;margin-bottom:18px;">',
    '<tr>',
    '<td style="width:92px;padding:0 0 12px;text-align:center;vertical-align:middle;">', logoHtml, '</td>',
    '<td style="padding:0 12px 12px;text-align:center;vertical-align:middle;">',
    '<div style="font-size:26px;font-weight:800;color:#1e2528;">', escapeHtml_(title), '</div>',
    '<div style="font-size:15px;font-weight:700;color:#165a43;margin-top:4px;">פרינוּק - המכירה השבועית</div>',
    contactText ? '<div style="font-size:13px;font-weight:700;color:#165a43;margin-top:4px;">' + escapeHtml_(contactText) + '</div>' : '',
    '</td>',
    '</tr>',
    '</table>',
    paragraphHtml,
    '</div>',
    '</div>'
  ].join('');
}

function getEmailInlineImageAssets_(settings) {
  var logoBlob = null;

  try {
    logoBlob = getLogoBlob_(settings);
  } catch (error) {
    Logger.log('טעינת לוגו למייל נכשלה, המייל יישלח ללא לוגו: ' + error.message);
  }

  if (!logoBlob) {
    return {
      logoCid: '',
      inlineImages: null
    };
  }

  var logoCid = 'prinokLogo';
  var inlineImages = {};
  inlineImages[logoCid] = logoBlob;

  return {
    logoCid: logoCid,
    inlineImages: inlineImages
  };
}

function applyEmailInlineImageAssets_(options, assets) {
  if (assets && assets.inlineImages) {
    options.inlineImages = assets.inlineImages;
  }

  return options;
}

function sendEmailSafely_(options) {
  try {
    MailApp.sendEmail(options);
    return {
      usedFallback: false,
      firstError: ''
    };
  } catch (error) {
    Logger.log('שליחת מייל HTML/לוגו נכשלה, מנסה לשלוח ללא לוגו ו-HTML: ' + error.message);

    var fallbackOptions = {};

    Object.keys(options || {}).forEach(function(key) {
      if (key !== 'htmlBody' && key !== 'inlineImages') {
        fallbackOptions[key] = options[key];
      }
    });

    MailApp.sendEmail(fallbackOptions);

    return {
      usedFallback: true,
      firstError: error.message
    };
  }
}

function getBillingNotice_() {
  return 'הסכום המוצג הוא הערכה בלבד. החיוב הסופי יתבצע בשעת ליקוט ההזמנה, לפי המשקל והכמויות בפועל.';
}

function buildDocumentHeaderHtml_(settings, documentTitle, metaParts) {
  var logoUrl = getDocumentLogoDataUrl_(settings);
  var contactText = buildDocumentContactText_(settings);
  var metaText = (metaParts || []).filter(function(part) {
    return String(part || '').trim();
  }).join(' | ');

  return [
    '<header class="doc-header">',
    logoUrl ? '<img class="doc-logo" src="' + escapeHtml_(logoUrl) + '" alt="פרינוּק">' : '',
    '<div class="doc-copy">',
    '<h1>', escapeHtml_(documentTitle), '</h1>',
    metaText ? '<div class="doc-meta">' + escapeHtml_(metaText) + '</div>' : '',
    contactText ? '<div class="doc-contact">' + escapeHtml_(contactText) + '</div>' : '',
    '</div>',
    '</header>'
  ].join('');
}

function getDocumentHeaderCss_() {
  return [
    '.doc-header{display:flex;align-items:center;justify-content:center;gap:14px;margin-bottom:16px;border-bottom:2px solid #1f7a5a;padding-bottom:12px;}',
    '.doc-logo{width:76px;height:76px;object-fit:contain;flex:0 0 auto;}',
    '.doc-copy{text-align:center;}',
    '.doc-copy h1{margin:0 0 5px;font-size:26px;line-height:1.15;}',
    '.doc-meta{color:#667074;font-size:13px;font-weight:bold;}',
    '.doc-contact{margin-top:4px;color:#165a43;font-size:12px;font-weight:bold;}'
  ].join('');
}

function getDocumentLogoUrl_(settings) {
  var configuredLogo = String(settings && settings.logoUrl || '').trim();

  return getConfiguredLogoPublicUrl_(configuredLogo)
    || getSharedPdfLogoUrl_(settings)
    || '';
}

function getDocumentLogoDataUrl_(settings) {
  var configuredLogo = String(settings && settings.logoUrl || '').trim();
  var configuredDataUrl = getLogoDataUrl_(configuredLogo);
  var embeddedDataUrl = getEmbeddedDefaultLogoDataUrl_();

  return (isReasonableLogoDataUrl_(configuredDataUrl) ? configuredDataUrl : '')
    || embeddedDataUrl
    || configuredDataUrl
    || '';
}

function isReasonableLogoDataUrl_(dataUrl) {
  var text = String(dataUrl || '');

  if (!text) {
    return false;
  }

  return text.length <= (PRINOK_CONFIG.MAX_LOGO_DATA_URL_LENGTH || 250000);
}

function getConfiguredLogoPublicUrl_(logoSource) {
  var source = String(logoSource || '').trim();

  if (!source || /^data:image\//i.test(source)) {
    return '';
  }

  var isHttpUrl = /^https?:\/\//i.test(source);
  var isDriveSource = source.indexOf('drive.google.com') !== -1
    || source.indexOf('docs.google.com') !== -1
    || !isHttpUrl;
  var fileId = isDriveSource ? extractDriveFileId_(source) : '';

  if (fileId) {
    try {
      var file = DriveApp.getFileById(fileId);
      ensureFileViewableByLink_(file);
      return buildDriveThumbnailUrl_(fileId);
    } catch (error) {
      Logger.log('הפיכת לוגו מדרייב לקישור ציבורי נכשלה: ' + error.message);
    }
  }

  return isHttpUrl ? source : '';
}

function getLogoDataUrl_(logoSource) {
  var source = String(logoSource || '').trim();

  if (!source) {
    return '';
  }

  if (/^data:image\//i.test(source)) {
    return source;
  }

  var isHttpUrl = /^https?:\/\//i.test(source);
  var isDriveSource = source.indexOf('drive.google.com') !== -1
    || source.indexOf('docs.google.com') !== -1
    || !isHttpUrl;
  var fileId = isDriveSource ? extractDriveFileId_(source) : '';

  if (fileId) {
    try {
      return blobToDataUrl_(DriveApp.getFileById(fileId).getBlob());
    } catch (error) {
      Logger.log('טעינת לוגו מדרייב נכשלה: ' + error.message);
    }
  }

  if (isHttpUrl) {
    try {
      var response = UrlFetchApp.fetch(source, {
        muteHttpExceptions: true
      });
      var code = response.getResponseCode();

      if (code >= 200 && code < 300) {
        return blobToDataUrl_(response.getBlob());
      }
    } catch (error) {
      Logger.log('טעינת לוגו מקישור חיצוני נכשלה: ' + error.message);
    }
  }

  return '';
}

function getEmbeddedDefaultLogoDataUrl_() {
  var logoData = getEmbeddedDefaultLogoData_();

  if (!logoData) {
    return '';
  }

  return 'data:' + logoData.mimeType + ';base64,' + logoData.base64;
}

function blobToDataUrl_(blob) {
  var contentType = String(blob.getContentType() || '').trim();

  if (contentType.indexOf('image/') !== 0) {
    return '';
  }

  return 'data:' + contentType + ';base64,' + Utilities.base64Encode(blob.getBytes());
}

function getLogoBlob_(settings) {
  var configuredLogo = String(settings && settings.logoUrl || '').trim();

  try {
    var configuredBlob = getLogoBlobFromSource_(configuredLogo);
    var embeddedBlob = getEmbeddedDefaultLogoBlob_();

    return chooseReasonableLogoBlob_(configuredBlob, embeddedBlob);
  } catch (error) {
    Logger.log('טעינת לוגו נכשלה: ' + error.message);
    return null;
  }
}

function chooseReasonableLogoBlob_(preferredBlob, fallbackBlob) {
  if (preferredBlob && isReasonableLogoBlob_(preferredBlob)) {
    return preferredBlob;
  }

  return fallbackBlob || preferredBlob || null;
}

function isReasonableLogoBlob_(blob) {
  if (!blob || !blob.getBytes) {
    return false;
  }

  try {
    return blob.getBytes().length <= (PRINOK_CONFIG.MAX_LOGO_BYTES || 250000);
  } catch (error) {
    return true;
  }
}

function getLogoBlobFromSource_(logoSource) {
  var source = String(logoSource || '').trim();

  if (!source) {
    return null;
  }

  if (/^data:image\//i.test(source)) {
    return createBlobFromDataImageUrl_(source, PRINOK_CONFIG.PDF_LOGO_FILE_NAME);
  }

  var isHttpUrl = /^https?:\/\//i.test(source);
  var isDriveSource = source.indexOf('drive.google.com') !== -1
    || source.indexOf('docs.google.com') !== -1
    || !isHttpUrl;
  var fileId = isDriveSource ? extractDriveFileId_(source) : '';

  if (fileId) {
    try {
      var driveBlob = DriveApp.getFileById(fileId).getBlob();
      return normalizeLogoBlob_(driveBlob);
    } catch (error) {
      Logger.log('טעינת לוגו מדרייב כקובץ נכשלה: ' + error.message);
    }
  }

  if (isHttpUrl) {
    try {
      var response = UrlFetchApp.fetch(source, {
        muteHttpExceptions: true
      });
      var code = response.getResponseCode();

      if (code >= 200 && code < 300) {
        return normalizeLogoBlob_(response.getBlob());
      }
    } catch (error) {
      Logger.log('טעינת לוגו מקישור חיצוני כקובץ נכשלה: ' + error.message);
    }
  }

  return null;
}

function getEmbeddedDefaultLogoBlob_() {
  var logoData = getEmbeddedDefaultLogoData_();

  if (!logoData) {
    return null;
  }

  return createLogoBlobFromBase64_(logoData.mimeType, logoData.base64, PRINOK_CONFIG.PDF_LOGO_FILE_NAME);
}

function createBlobFromDataImageUrl_(dataUrl, fileName) {
  var dataMatch = String(dataUrl || '').replace(/&amp;/g, '&').match(/^data:([^;]+);base64,([\s\S]+)$/);

  if (!dataMatch) {
    Logger.log('מקור הלוגו הוא data URL אך המבנה שלו אינו תקין.');
    return null;
  }

  return createLogoBlobFromBase64_(dataMatch[1], dataMatch[2], fileName);
}

function createLogoBlobFromBase64_(mimeType, base64, fileName) {
  var contentType = String(mimeType || '').trim();
  var cleanBase64 = String(base64 || '').replace(/\s/g, '');

  if (contentType.indexOf('image/') !== 0 || !cleanBase64) {
    return null;
  }

  cleanBase64 = cleanBase64.replace(/-/g, '+').replace(/_/g, '/');

  while (cleanBase64.length % 4) {
    cleanBase64 += '=';
  }

  try {
    return Utilities.newBlob(
      Utilities.base64Decode(cleanBase64),
      contentType,
      getLogoFileNameForContentType_(contentType, fileName)
    );
  } catch (error) {
    Logger.log('פענוח base64 של הלוגו נכשל, ממשיכים ללא לוגו: ' + error.message);
    return null;
  }
}

function getLogoFileNameForContentType_(contentType, fileName) {
  var type = String(contentType || '').toLowerCase();

  if (type === 'image/png') {
    return 'prinuk-logo.png';
  }

  if (type === 'image/gif') {
    return 'prinuk-logo.gif';
  }

  if (type === 'image/webp') {
    return 'prinuk-logo.webp';
  }

  if (type === 'image/jpeg' || type === 'image/jpg') {
    return PRINOK_CONFIG.PDF_LOGO_FILE_NAME;
  }

  return fileName || PRINOK_CONFIG.PDF_LOGO_FILE_NAME;
}

function normalizeLogoBlob_(blob) {
  var contentType = String(blob && blob.getContentType ? blob.getContentType() : '').trim();

  if (contentType.indexOf('image/') !== 0) {
    return null;
  }

  return blob.setName(getLogoFileNameForContentType_(contentType, PRINOK_CONFIG.PDF_LOGO_FILE_NAME));
}

function getSharedPdfLogoUrl_(settings) {
  try {
    var existingFiles = DriveApp.getFilesByName(PRINOK_CONFIG.PDF_LOGO_FILE_NAME);

    while (existingFiles.hasNext()) {
      var existingFile = existingFiles.next();

      if (!existingFile.isTrashed()) {
        ensureFileViewableByLink_(existingFile);
        return buildDriveThumbnailUrl_(existingFile.getId());
      }
    }

    var logoBlob = getLogoBlob_(settings);

    if (!logoBlob) {
      return '';
    }

    var ss = getSpreadsheet_();
    var logoFile = createDriveFileNearSpreadsheet_(ss, logoBlob.setName(PRINOK_CONFIG.PDF_LOGO_FILE_NAME));

    ensureFileViewableByLink_(logoFile);
    return buildDriveThumbnailUrl_(logoFile.getId());
  } catch (error) {
    Logger.log('יצירת קישור לוגו למסמכי PDF נכשלה: ' + error.message);
    return normalizeDriveImageUrl_(String(settings && settings.logoUrl || '').trim()) || '';
  }
}

function getEmbeddedDefaultLogoData_() {
  try {
    var html = HtmlService.createHtmlOutputFromFile('Index').getContent();
    var match = html.match(/<img[^>]+id=["']brandLogo["'][^>]+src=["']([^"']+)["']/i);

    if (match && match[1]) {
      var dataUrl = match[1].replace(/&amp;/g, '&');
      var dataMatch = dataUrl.match(/^data:([^;]+);base64,(.+)$/);

      if (dataMatch) {
        return {
          mimeType: dataMatch[1],
          base64: dataMatch[2]
        };
      }
    }
  } catch (error) {
  }

  return null;
}

function normalizeDriveImageUrl_(url) {
  var fileId = extractDriveFileId_(url);

  if (!fileId || fileId === url && url.indexOf('http') !== 0) {
    return '';
  }

  if (url.indexOf('drive.google.com') === -1 && url.indexOf('docs.google.com') === -1) {
    return url;
  }

  return buildDriveThumbnailUrl_(fileId);
}

function extractDriveFileId_(url) {
  var text = String(url || '').trim();

  if (!text) {
    return '';
  }

  var pathMatch = text.match(/\/d\/([a-zA-Z0-9-_]+)/);

  if (pathMatch) {
    return pathMatch[1];
  }

  var queryMatch = text.match(/[?&]id=([a-zA-Z0-9-_]+)/);

  if (queryMatch) {
    return queryMatch[1];
  }

  return text;
}

function buildDriveThumbnailUrl_(fileId) {
  return 'https://lh3.googleusercontent.com/d/' + encodeURIComponent(fileId) + '=w200';
}

function ensureFileViewableByLink_(file) {
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (error) {
    Logger.log('לא ניתן לשתף את קובץ הלוגו לצפייה בקישור: ' + error.message);
  }
}

function buildDocumentContactText_(settings) {
  var phone = String(settings && settings.contactPhone || PRINOK_CONFIG.DEFAULT_CONTACT_PHONE || '').trim();
  var email = String(settings && settings.contactEmail || PRINOK_CONFIG.DEFAULT_CONTACT_EMAIL || '').trim();
  var parts = [];

  if (phone) {
    parts.push('טלפון / וואטסאפ: ' + phone);
  }

  if (email) {
    parts.push('מייל: ' + email);
  }

  return parts.join(' | ');
}

function createPriceListPdf_() {
  var ss = getSpreadsheet_();
  var productSheet = getProductSheet_(ss);
  var settings = getSettings_(ss, productSheet);
  var products = readProducts_(productSheet);

  if (!products.length) {
    throw new Error('אין מוצרים פעילים ליצירת מחירון.');
  }

  var categories = groupProducts_(products);
  var html = buildPriceListPdfHtml_(settings, categories, products.length);
  var timezone = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  var timestamp = Utilities.formatDate(new Date(), timezone, 'yyyyMMdd-HHmm');
  var salePart = settings.saleName ? '-' + safeFileName_(settings.saleName) : '';
  var fileName = 'מחירון-פרינוּק' + salePart + '-' + timestamp + '.pdf';
  var pdf = Utilities
    .newBlob(html, 'text/html', 'price-list.html')
    .getAs('application/pdf')
    .setName(fileName);
  var file = createDriveFileNearSpreadsheet_(ss, pdf);
  var emailRecipients = sendPriceListPdfEmail_(settings, pdf, file, products.length);

  return {
    fileName: file.getName(),
    url: file.getUrl(),
    productCount: products.length,
    emailRecipients: emailRecipients
  };
}

function createDesignedPriceFlyerPdf_() {
  var ss = getSpreadsheet_();
  var productSheet = getProductSheet_(ss);
  var settings = getSettings_(ss, productSheet);
  var products = readProducts_(productSheet);

  if (!products.length) {
    throw new Error('אין מוצרים פעילים ליצירת פלייר מחירים.');
  }

  var categories = groupProducts_(products);
  var html = buildDesignedPriceFlyerPdfHtml_(settings, categories, products.length);
  var timezone = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  var timestamp = Utilities.formatDate(new Date(), timezone, 'yyyyMMdd-HHmm');
  var salePart = settings.saleName ? '-' + safeFileName_(settings.saleName) : '';
  var fileName = 'פלייר-מחירים-פרינוּק' + salePart + '-' + timestamp + '.pdf';
  var pdf = Utilities
    .newBlob(html, 'text/html', 'price-flyer.html')
    .getAs('application/pdf')
    .setName(fileName);
  var file = createDriveFileNearSpreadsheet_(ss, pdf);
  var emailRecipients = sendPriceFlyerPdfEmail_(settings, pdf, file, products.length);

  return {
    fileName: file.getName(),
    url: file.getUrl(),
    productCount: products.length,
    emailRecipients: emailRecipients
  };
}

function createPrintableOrderFormPdf_() {
  var ss = getSpreadsheet_();
  var productSheet = getProductSheet_(ss);
  var settings = getSettings_(ss, productSheet);
  var products = readProducts_(productSheet);

  if (!products.length) {
    throw new Error('אין מוצרים פעילים ליצירת טופס הזמנה.');
  }

  var categories = groupProducts_(products);
  var html = buildPrintableOrderFormPdfHtml_(settings, categories, products.length);
  var timezone = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  var timestamp = Utilities.formatDate(new Date(), timezone, 'yyyyMMdd-HHmm');
  var salePart = settings.saleName ? '-' + safeFileName_(settings.saleName) : '';
  var fileName = 'טופס-הזמנה-פרינוּק' + salePart + '-' + timestamp + '.pdf';
  var pdf = Utilities
    .newBlob(html, 'text/html', 'printable-order-form.html')
    .getAs('application/pdf')
    .setName(fileName);
  var file = createDriveFileNearSpreadsheet_(ss, pdf);

  return {
    fileName: file.getName(),
    url: file.getUrl(),
    productCount: products.length
  };
}

function createProductSignsPdf_() {
  var ss = getSpreadsheet_();
  var productSheet = getProductSheet_(ss);
  var settings = getSettings_(ss, productSheet);
  var products = readProducts_(productSheet);

  if (!products.length) {
    throw new Error('אין מוצרים פעילים ליצירת שלטי מוצרים.');
  }

  var html = buildProductSignsPdfHtml_(products);
  var timezone = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  var timestamp = Utilities.formatDate(new Date(), timezone, 'yyyyMMdd-HHmm');
  var salePart = settings.saleName ? '-' + safeFileName_(settings.saleName) : '';
  var fileName = 'שלטי-מוצרים-פרינוּק' + salePart + '-' + timestamp + '.pdf';
  var pdf = Utilities
    .newBlob(html, 'text/html', 'product-signs.html')
    .getAs('application/pdf')
    .setName(fileName);
  var file = createDriveFileNearSpreadsheet_(ss, pdf);

  return {
    fileName: file.getName(),
    url: file.getUrl(),
    productCount: products.length
  };
}

// One A4 page per two products (half a page each): big bold white name on
// a dark background, then the price with its billing unit (ק״ג / יחידה).
function buildProductSignsPdfHtml_(products) {
  var pages = [];

  for (var i = 0; i < products.length; i += 2) {
    var cells = buildProductSignCell_(products[i]);

    cells += products[i + 1]
      ? buildProductSignCell_(products[i + 1])
      : '<div class="sign"></div>';

    pages.push('<div class="page"><div class="frame">' + cells + '</div></div>');
  }

  return [
    '<!doctype html>',
    '<html dir="rtl" lang="he">',
    '<head>',
    '<meta charset="UTF-8">',
    '<style>',
    '@page{size:A4;margin:0;}',
    '*{box-sizing:border-box;margin:0;padding:0;}',
    'html,body{background:#2b2b2b;}',
    'body{font-family:Arial,Helvetica,sans-serif;color:#ffffff;}',
    '.page{width:210mm;height:297mm;background:#2b2b2b;padding:9mm;page-break-after:always;}',
    '.page:last-child{page-break-after:auto;}',
    '.frame{height:100%;border:3px solid #6f6f6f;border-radius:6px;display:flex;flex-direction:column;}',
    '.sign{flex:1 1 50%;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:12mm 14mm;}',
    '.sign .name{font-size:76px;font-weight:900;line-height:1.12;word-break:break-word;}',
    '.sign .price{font-size:76px;font-weight:900;line-height:1.12;margin-top:9mm;}',
    '</style>',
    '</head>',
    '<body>',
    pages.join(''),
    '</body>',
    '</html>'
  ].join('');
}

function buildProductSignCell_(product) {
  var unitLabel = getUnitType_(product.priceUnit) === 'kg' ? 'ק״ג' : 'יחידה';
  var priceLine = product.priceDisplay + ' ש״ח ' + unitLabel;

  return [
    '<div class="sign">',
    '<div class="name">', escapeHtml_(product.name), '</div>',
    '<div class="price">', escapeHtml_(priceLine), '</div>',
    '</div>'
  ].join('');
}

function buildPrintableOrderFormPdfHtml_(settings, categories, productCount) {
  var title = settings.title || PRINOK_CONFIG.DEFAULT_FORM_TITLE;
  var saleName = settings.saleName || '';
  var generatedAt = formatDateTime_(new Date());
  var pickupText = settings.pickupText || PRINOK_CONFIG.DEFAULT_PICKUP_TEXT;
  var sections = categories.map(function(category) {
    var rows = category.products.map(function(product) {
      return [
        '<tr>',
        '<td class="name">', escapeHtml_(product.name), '</td>',
        '<td>', escapeHtml_(product.unit || ''), '</td>',
        '<td>', escapeHtml_(formatPriceListPrice_(product)), '</td>',
        '<td class="box-cell"><div class="write-box"></div></td>',
        '<td class="box-cell"><div class="status-box"></div></td>',
        '</tr>'
      ].join('');
    }).join('');

    return [
      '<section class="category">',
      '<h2>', escapeHtml_(category.name), '</h2>',
      '<table>',
      '<thead><tr><th>מוצר</th><th>יחידת מכירה</th><th>מחיר</th><th>כמות</th><th>סטטוס</th></tr></thead>',
      '<tbody>', rows, '</tbody>',
      '</table>',
      '</section>'
    ].join('');
  }).join('');

  return [
    '<!doctype html>',
    '<html dir="rtl" lang="he">',
    '<head>',
    '<meta charset="UTF-8">',
    '<style>',
    '@page{size:A4;margin:16mm 12mm;}',
    'body{font-family:Arial,Helvetica,sans-serif;color:#1e2528;margin:0;line-height:1.35;}',
    getDocumentHeaderCss_(),
    '.details{border:1px solid #d9ded6;border-radius:8px;padding:10px;margin:0 0 12px;background:#f7f6f1;break-inside:avoid;}',
    '.details h2{margin:0 0 8px;font-size:17px;color:#165a43;}',
    '.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;}',
    '.line{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:bold;}',
    '.blank{display:inline-block;min-width:150px;border-bottom:1px solid #1e2528;height:18px;flex:1;}',
    '.small-blank{display:inline-block;min-width:72px;border-bottom:1px solid #1e2528;height:18px;}',
    '.checks{display:flex;gap:16px;align-items:center;font-size:13px;font-weight:bold;}',
    '.check{display:inline-block;width:13px;height:13px;border:1px solid #1e2528;margin-inline-start:5px;vertical-align:-2px;}',
    '.pickup{margin-top:8px;color:#667074;font-size:12px;font-weight:bold;}',
    '.notice{margin:0 0 12px;padding:8px 10px;border:1px solid #d7e5db;border-radius:8px;background:#e5f2ec;color:#165a43;font-size:12px;font-weight:bold;}',
    '.category{margin:0 0 14px;break-inside:auto;page-break-inside:auto;}',
    '.category h2{margin:0 0 7px;font-size:18px;color:#165a43;break-after:avoid;page-break-after:avoid;}',
    'table{width:100%;border-collapse:collapse;}',
    'thead{display:table-header-group;}',
    'th{background:#1f7a5a;color:#fff;font-size:12px;}',
    'th,td{border:1px solid #d9ded6;padding:6px 7px;text-align:right;vertical-align:middle;}',
    'td{font-size:12px;}',
    'td.name{font-weight:bold;}',
    'tr{break-inside:avoid;page-break-inside:avoid;}',
    'tr:nth-child(even) td{background:#fbfcfa;}',
    '.box-cell{width:62px;padding:4px;text-align:center;}',
    '.write-box,.status-box{height:22px;border:1px solid #1e2528;border-radius:3px;background:#fff;}',
    '.status-box{height:20px;}',
    '</style>',
    '</head>',
    '<body>',
    buildDocumentHeaderHtml_(settings, 'טופס הזמנה - ' + title, [
      saleName ? 'מכירה: ' + saleName : '',
      productCount + ' מוצרים',
      'נוצר בתאריך: ' + generatedAt
    ]),
    '<section class="details">',
    '<h2>פרטי המזמין</h2>',
    '<div class="grid">',
    '<div class="line">שם מלא <span class="blank"></span></div>',
    '<div class="line">טלפון <span class="blank"></span></div>',
    '<div class="checks"><span>שיטת הזמנה:</span><span><span class="check"></span>איסוף עצמי</span><span><span class="check"></span>משלוח</span></div>',
    '<div class="line">תאריך הזמנה <span class="small-blank"></span></div>',
    '<div class="line">כתובת למשלוח <span class="blank"></span></div>',
    '<div class="line">קומה <span class="small-blank"></span> דירה <span class="small-blank"></span></div>',
    '</div>',
    pickupText ? '<div class="pickup">פרטי איסוף: ' + escapeHtml_(pickupText) + '</div>' : '',
    '</section>',
    '<div class="notice">הסכום הסופי יחושב בשעת ליקוט ההזמנה לפי המשקל והכמויות בפועל.</div>',
    sections,
    '</body>',
    '</html>'
  ].join('');
}

function buildDesignedPriceFlyerPdfHtml_(settings, categories, productCount) {
  var saleName = settings.saleName || '';
  var generatedAt = formatDateTime_(new Date());
  var pickupText = settings.pickupText || PRINOK_CONFIG.DEFAULT_PICKUP_TEXT;
  var contactPhone = String(settings.contactPhone || PRINOK_CONFIG.DEFAULT_CONTACT_PHONE || '').trim();
  var contactEmail = String(settings.contactEmail || PRINOK_CONFIG.DEFAULT_CONTACT_EMAIL || '').trim();
  var logoDataUrl = getDocumentLogoDataUrl_(settings);
  var categorySections = categories.map(function(category) {
    return buildDesignedPriceFlyerCategoryHtml_(category);
  }).join('');

  return [
    '<!doctype html>',
    '<html dir="rtl" lang="he">',
    '<head>',
    '<meta charset="UTF-8">',
    '<style>',
    '@page{size:A4;margin:9mm;}',
    'body{font-family:Arial,Helvetica,sans-serif;color:#1e2528;margin:0;line-height:1.3;background:#fffaf2;}',
    '.flyer{border:2px solid #2a523e;border-radius:18px;padding:13px 14px 12px;background:#fffaf2;box-sizing:border-box;break-inside:auto;page-break-inside:auto;overflow:visible;}',
    '.flyer-header{display:table;width:100%;border-collapse:collapse;margin-bottom:9px;}',
    '.logo-cell{display:table-cell;width:92px;text-align:center;vertical-align:middle;}',
    '.logo{width:84px;height:84px;object-fit:contain;display:block;margin:0 auto;}',
    '.headline{display:table-cell;text-align:center;vertical-align:middle;padding:0 10px;}',
    '.bsad{font-size:14px;font-weight:bold;color:#8a6b3d;margin-bottom:2px;}',
    '.brand{font-size:48px;font-weight:900;line-height:.95;color:#8b1712;letter-spacing:0;}',
    '.subtitle{display:inline-block;margin-top:5px;padding:4px 18px;border-radius:5px;background:#2a523e;color:#fff7df;font-size:21px;font-weight:900;}',
    '.sale-name{margin-top:7px;font-size:20px;font-weight:900;color:#1e2528;}',
    '.meta-strip{margin:8px 0 10px;padding:7px 10px;border-top:1px solid #e0d5b6;border-bottom:1px solid #e0d5b6;text-align:center;color:#8a1710;font-size:14px;font-weight:800;}',
    '.category-list{margin:0;}',
    '.category-box{border:1px solid #d9cdaa;border-radius:12px;background:#fffdf8;overflow:visible;break-inside:auto;page-break-inside:auto;margin:0 0 10px;}',
    '.category-title{margin:0;padding:8px 10px;text-align:center;color:#fff;font-size:21px;font-weight:900;break-after:avoid;page-break-after:avoid;}',
    '.category-title.light{color:#1e2528;}',
    '.category-items{padding:8px 9px 9px;}',
    '.item-table{width:100%;border-collapse:collapse;table-layout:fixed;}',
    '.item-table tr{break-inside:avoid;page-break-inside:avoid;}',
    '.item-table td{border-bottom:1px dotted #d7c899;padding:3px 0;vertical-align:middle;}',
    '.item-table tr:last-child td{border-bottom:0;}',
    '.item-copy{width:54%;font-weight:900;color:#1e2528;}',
    '.item-name{display:block;font-size:13px;line-height:1.12;word-break:break-word;}',
    '.item-unit{display:block;font-size:9px;line-height:1.1;color:#8a6b3d;font-weight:800;margin-top:1px;}',
    '.leader-cell{padding:0 5px;}',
    '.leader{border-bottom:1px dotted #bda56f;height:1px;}',
    '.price-cell{width:52px;}',
    '.price-box{text-align:center;border:1px solid #2a523e;border-radius:7px;background:#fff;color:#2a523e;padding:2px 4px;line-height:1;}',
    '.currency{font-size:10px;font-weight:900;margin-inline-start:2px;}',
    '.amount{font-size:17px;font-weight:900;}',
    '.flyer-footer{margin-top:10px;border:1px solid #d9cdaa;border-radius:11px;background:#fff8e7;padding:9px 12px;text-align:center;color:#1e2528;font-weight:900;}',
    '.footer-title{font-size:15px;color:#8a1710;margin-bottom:5px;}',
    '.footer-contact{font-size:20px;color:#1e2528;}',
    '.footer-contact span{display:inline-block;margin:0 8px;}',
    '.footer-pickup{margin-top:6px;font-size:15px;color:#2a523e;}',
    '.footer-free{margin-top:5px;font-size:16px;color:#8a1710;}',
    '</style>',
    '</head>',
    '<body>',
    '<section class="flyer">',
    '<header class="flyer-header">',
    '<div class="logo-cell">', logoDataUrl ? '<img class="logo" src="' + escapeHtml_(logoDataUrl) + '" alt="פרינוּק">' : '', '</div>',
    '<div class="headline">',
    '<div class="bsad">בס״ד</div>',
    '<div class="brand">פרינוּק</div>',
    '<div class="subtitle">המכירה השבועית</div>',
    saleName ? '<div class="sale-name">' + escapeHtml_(saleName) + '</div>' : '',
    '</div>',
    '<div class="logo-cell"></div>',
    '</header>',
    '<div class="meta-strip">מחירון שבועי | ', productCount, ' מוצרים | נוצר בתאריך ', escapeHtml_(generatedAt), '</div>',
    '<div class="category-list">', categorySections, '</div>',
    '<footer class="flyer-footer">',
    '<div class="footer-title">ליצירת קשר או הזמנה בדרכים נוספות</div>',
    '<div class="footer-contact">',
    contactPhone ? '<span>טלפון / וואטסאפ: ' + escapeHtml_(contactPhone) + '</span>' : '',
    contactEmail ? '<span>מייל: ' + escapeHtml_(contactEmail) + '</span>' : '',
    '</div>',
    pickupText ? '<div class="footer-pickup">' + escapeHtml_(pickupText) + '</div>' : '',
    '<div class="footer-free">משלוח: 25 ש״ח. בהזמנה מעל 200 ש״ח המשלוח חינם.</div>',
    '</footer>',
    '</section>',
    '</body>',
    '</html>'
  ].join('');
}

function buildDesignedPriceFlyerCategoryHtml_(category) {
  var color = getFlyerCategoryColor_(category.name);
  var titleClass = category.name === 'עלים' ? 'category-title light' : 'category-title';
  var items = category.products.map(function(product) {
    return buildDesignedPriceFlyerItemHtml_(product);
  }).join('');

  return [
    '<section class="category-box">',
    '<h2 class="', titleClass, '" style="background:', color, ';">', escapeHtml_(category.name), '</h2>',
    '<div class="category-items"><table class="item-table"><tbody>', items, '</tbody></table></div>',
    '</section>'
  ].join('');
}

function buildDesignedPriceFlyerItemHtml_(product) {
  var priceUnit = product.priceUnit || product.unit || '';

  return [
    '<tr>',
    '<td class="item-copy">',
    '<span class="item-name">', escapeHtml_(product.name), '</span>',
    priceUnit ? '<span class="item-unit">ל-' + escapeHtml_(priceUnit) + '</span>' : '',
    '</td>',
    '<td class="leader-cell"><div class="leader"></div></td>',
    '<td class="price-cell"><div class="price-box"><span class="currency">₪</span><span class="amount">', escapeHtml_(product.priceDisplay), '</span></div></td>',
    '</tr>'
  ].join('');
}

function getFlyerCategoryColor_(categoryName) {
  var normalized = normalizeDepartment_(categoryName);

  if (normalized === 'ירקות') {
    return '#2A523e';
  }

  if (normalized === 'עלים') {
    return '#97A994';
  }

  if (normalized === 'פירות') {
    return '#D97A53';
  }

  return '#2A523e';
}

function buildPriceListPdfHtml_(settings, categories, productCount) {
  var title = settings.title || PRINOK_CONFIG.DEFAULT_FORM_TITLE;
  var saleName = settings.saleName || '';
  var generatedAt = formatDateTime_(new Date());
  var sections = categories.map(function(category) {
    var rows = category.products.map(function(product) {
      return [
        '<tr>',
        '<td class="name">', escapeHtml_(product.name), '</td>',
        '<td>', escapeHtml_(product.unit || ''), '</td>',
        '<td>', escapeHtml_(formatPriceListPrice_(product)), '</td>',
        '</tr>'
      ].join('');
    }).join('');

    return [
      '<section class="category">',
      '<h2>', escapeHtml_(category.name), '</h2>',
      '<table>',
      '<thead><tr><th>מוצר</th><th>יחידת מכירה</th><th>מחיר</th></tr></thead>',
      '<tbody>', rows, '</tbody>',
      '</table>',
      '</section>'
    ].join('');
  }).join('');

  return [
    '<!doctype html>',
    '<html dir="rtl" lang="he">',
    '<head>',
    '<meta charset="UTF-8">',
    '<style>',
    '@page{size:A4;margin:14mm 12mm;}',
    'body{font-family:Arial,Helvetica,sans-serif;color:#1e2528;margin:0;line-height:1.45;}',
    getDocumentHeaderCss_(),
    '.category{margin:0 0 18px;break-inside:auto;page-break-inside:auto;}',
    'h2{margin:0 0 8px;font-size:20px;color:#165a43;break-after:avoid;page-break-after:avoid;}',
    'table{width:100%;border-collapse:collapse;}',
    'thead{display:table-header-group;}',
    'th{background:#1f7a5a;color:#fff;font-size:14px;}',
    'th,td{border:1px solid #d9ded6;padding:8px 10px;text-align:right;vertical-align:middle;}',
    'td{font-size:14px;}',
    'td.name{font-weight:bold;}',
    'tr{break-inside:avoid;page-break-inside:avoid;}',
    'tr:nth-child(even) td{background:#fbfcfa;}',
    '</style>',
    '</head>',
    '<body>',
    buildDocumentHeaderHtml_(settings, 'מחירון - ' + title, [
      saleName ? 'מכירה: ' + saleName : '',
      productCount + ' מוצרים',
      'נוצר בתאריך: ' + generatedAt
    ]),
    sections,
    '</body>',
    '</html>'
  ].join('');
}

function formatPriceListPrice_(product) {
  var priceUnit = product.priceUnit || product.unit || '';
  return formatMoney_(product.price) + (priceUnit ? ' ל-' + priceUnit : '');
}

// Compact, single-page price list. opts: { columns, category, titleSuffix, fileLabel }
function createCompactPriceListPdf_(opts) {
  opts = opts || {};
  var ss = getSpreadsheet_();
  var productSheet = getProductSheet_(ss);
  var settings = getSettings_(ss, productSheet);
  var products = readProducts_(productSheet);

  if (opts.category) {
    products = products.filter(function(product) {
      return product.department === opts.category;
    });
  }

  if (!products.length) {
    throw new Error('אין מוצרים' + (opts.category ? ' בקטגוריה ' + opts.category : '') + ' ליצירת מחירון.');
  }

  var categories = groupProducts_(products);
  var html = buildCompactPriceListHtml_(settings, categories, products.length, opts);
  var timezone = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  var timestamp = Utilities.formatDate(new Date(), timezone, 'yyyyMMdd-HHmm');
  var salePart = settings.saleName ? '-' + safeFileName_(settings.saleName) : '';
  var fileName = (opts.fileLabel || 'מחירון') + '-פרינוּק' + salePart + '-' + timestamp + '.pdf';
  var pdf = Utilities
    .newBlob(html, 'text/html', 'price-list.html')
    .getAs('application/pdf')
    .setName(fileName);
  var file = createDriveFileNearSpreadsheet_(ss, pdf);

  return {
    fileName: file.getName(),
    url: file.getUrl(),
    productCount: products.length
  };
}

function buildCompactPriceListHtml_(settings, categories, productCount, opts) {
  opts = opts || {};
  var columns = opts.columns || 2;
  var title = settings.title || PRINOK_CONFIG.DEFAULT_FORM_TITLE;
  var saleName = settings.saleName || '';
  var generatedAt = formatDateTime_(new Date());
  var headTitle = 'מחירון' + (opts.titleSuffix ? ' ' + opts.titleSuffix : '') + ' - ' + title;

  // Flatten products in category order, then split evenly across columns.
  var entries = [];
  categories.forEach(function(category) {
    category.products.forEach(function(product) {
      entries.push({ cat: category.name, product: product });
    });
  });

  var perColumn = Math.ceil(entries.length / columns);
  var columnCells = [];

  for (var c = 0; c < columns; c++) {
    var slice = entries.slice(c * perColumn, (c + 1) * perColumn);

    if (!slice.length) {
      continue;
    }

    columnCells.push('<td class="col">' + renderCompactPriceColumn_(slice) + '</td>');
  }

  var colWidth = Math.floor(100 / Math.max(columnCells.length, 1));

  return [
    '<!doctype html>',
    '<html dir="rtl" lang="he">',
    '<head>',
    '<meta charset="UTF-8">',
    '<style>',
    '@page{size:A4;margin:10mm;}',
    'body{font-family:Arial,Helvetica,sans-serif;color:#1e2528;margin:0;line-height:1.25;}',
    getDocumentHeaderCss_(),
    '.doc-header{margin-bottom:10px;padding-bottom:8px;}',
    '.doc-logo{width:60px;height:60px;}',
    '.doc-copy h1{font-size:22px;}',
    'table.cols{width:100%;border-collapse:collapse;table-layout:fixed;}',
    'td.col{vertical-align:top;width:' + colWidth + '%;padding:0 7px;border-inline-start:1px solid #e6e9e1;}',
    'td.col:first-child{border-inline-start:0;}',
    'h3{margin:9px 0 4px;font-size:13px;color:#165a43;border-bottom:1px solid #1f7a5a;padding-bottom:3px;}',
    'h3:first-child{margin-top:0;}',
    '.row{display:flex;justify-content:space-between;gap:8px;font-size:11.5px;padding:2px 0;border-bottom:1px solid #f0f2ec;}',
    '.row .pname{font-weight:bold;overflow-wrap:anywhere;}',
    '.row .pprice{white-space:nowrap;color:#165a43;font-weight:bold;}',
    '</style>',
    '</head>',
    '<body>',
    buildDocumentHeaderHtml_(settings, headTitle, [
      saleName ? 'מכירה: ' + saleName : '',
      productCount + ' מוצרים',
      'נוצר בתאריך: ' + generatedAt
    ]),
    '<table class="cols"><tr>', columnCells.join(''), '</tr></table>',
    '</body>',
    '</html>'
  ].join('');
}

function renderCompactPriceColumn_(entries) {
  var html = [];
  var currentCat = null;

  entries.forEach(function(entry) {
    if (entry.cat !== currentCat) {
      currentCat = entry.cat;
      html.push('<h3>' + escapeHtml_(currentCat) + '</h3>');
    }

    html.push(
      '<div class="row">' +
      '<span class="pname">' + escapeHtml_(entry.product.name) + '</span>' +
      '<span class="pprice">' + escapeHtml_(formatPriceListPrice_(entry.product)) + '</span>' +
      '</div>'
    );
  });

  return html.join('');
}

function createDriveFileNearSpreadsheet_(ss, blob) {
  try {
    var spreadsheetFile = DriveApp.getFileById(ss.getId());
    var parents = spreadsheetFile.getParents();

    if (parents.hasNext()) {
      return parents.next().createFile(blob);
    }
  } catch (error) {
  }

  return DriveApp.createFile(blob);
}

function sendPriceListPdfEmail_(settings, pdf, file, productCount) {
  var recipients = String(settings.notificationEmails || settings.contactEmail || '').trim();

  if (!recipients) {
    return '';
  }

  var saleName = settings.saleName ? ' - ' + settings.saleName : '';
  var subject = 'מחירון פרינוּק' + saleName;
  var body = [
    'מצורף מחירון פרינוּק בפורמט PDF.',
    '',
    'מספר מוצרים: ' + productCount,
    'קישור לקובץ בדרייב: ' + file.getUrl(),
    '',
    'פרינוּק'
  ].join('\n');
  var emailAssets = getEmailInlineImageAssets_(settings);
  var options = {
    to: recipients,
    subject: subject,
    body: body,
    htmlBody: buildSimpleEmailHtml_(settings, 'מחירון פרינוּק', [
      'מצורף מחירון פרינוּק בפורמט PDF.',
      'מספר מוצרים: ' + productCount,
      'קישור לקובץ בדרייב: ' + file.getUrl()
    ], emailAssets.logoCid),
    attachments: [pdf]
  };

  applyEmailInlineImageAssets_(options, emailAssets);
  sendEmailSafely_(options);

  return recipients;
}

function sendPriceFlyerPdfEmail_(settings, pdf, file, productCount) {
  var recipients = String(settings.notificationEmails || settings.contactEmail || '').trim();

  if (!recipients) {
    return '';
  }

  var saleName = settings.saleName ? ' - ' + settings.saleName : '';
  var subject = 'פלייר מחירים פרינוּק' + saleName;
  var body = [
    'מצורף פלייר מחירים של פרינוּק בפורמט PDF.',
    '',
    'מספר מוצרים: ' + productCount,
    'קישור לקובץ בדרייב: ' + file.getUrl(),
    '',
    'פרינוּק'
  ].join('\n');
  var emailAssets = getEmailInlineImageAssets_(settings);
  var options = {
    to: recipients,
    subject: subject,
    body: body,
    htmlBody: buildSimpleEmailHtml_(settings, 'פלייר מחירים פרינוּק', [
      'מצורף פלייר מחירים של פרינוּק בפורמט PDF.',
      'מספר מוצרים: ' + productCount,
      'קישור לקובץ בדרייב: ' + file.getUrl()
    ], emailAssets.logoCid),
    attachments: [pdf]
  };

  applyEmailInlineImageAssets_(options, emailAssets);
  sendEmailSafely_(options);

  return recipients;
}

function archiveOrdersAndClear_() {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    var ss = getSpreadsheet_();
    var productSheet = getProductSheet_(ss);
    var settings = getSettings_(ss, productSheet);
    var saleName = settings.saleName || productSheet.getName() || 'ללא שם מכירה';
    var archivedAt = new Date();
    var orderHeaders = getOrderHeaders_();
    var itemHeaders = getOrderItemHeaders_();
    var ordersSheet = ensureSheet_(ss, PRINOK_CONFIG.ORDERS_SHEET_NAME, orderHeaders);
    var orderItemsSheet = ensureSheet_(ss, PRINOK_CONFIG.ORDER_ITEMS_SHEET_NAME, itemHeaders);
    var orderRows = getBodyRows_(ordersSheet, orderHeaders.length);
    var itemRows = getBodyRows_(orderItemsSheet, itemHeaders.length);
    var archiveSpreadsheet = openOrCreateArchiveSpreadsheet_(settings, ss);
    var archiveSheet = appendSaleArchive_(archiveSpreadsheet, saleName, archivedAt, orderHeaders, orderRows, itemHeaders, itemRows);


    clearSheetBody_(ordersSheet);
    clearSheetBody_(orderItemsSheet);
    resetPickingSheet_(ss);

    return {
      saleName: saleName,
      orderCount: orderRows.length,
      itemCount: itemRows.length,
      archiveSpreadsheetUrl: archiveSpreadsheet.getUrl(),
      archiveSheetName: archiveSheet.getName()
    };
  } finally {
    lock.releaseLock();
  }
}

function openOrCreateArchiveSpreadsheet_(settings, sourceSpreadsheet) {
  var explicitId = extractSpreadsheetId_(settings.archiveSpreadsheetId);

  if (explicitId) {
    return SpreadsheetApp.openById(explicitId);
  }

  var fileName = settings.archiveSpreadsheetName || PRINOK_CONFIG.ARCHIVE_SPREADSHEET_NAME;
  var files = DriveApp.getFilesByName(fileName);

  while (files.hasNext()) {
    var file = files.next();

    try {
      return SpreadsheetApp.openById(file.getId());
    } catch (error) {
    }
  }

  var archiveSpreadsheet = SpreadsheetApp.create(fileName);

  moveSpreadsheetNearSource_(archiveSpreadsheet, sourceSpreadsheet);
  applySheetDirection_(archiveSpreadsheet.getSheets()[0]);

  return archiveSpreadsheet;
}

function moveSpreadsheetNearSource_(targetSpreadsheet, sourceSpreadsheet) {
  try {
    var sourceFile = DriveApp.getFileById(sourceSpreadsheet.getId());
    var parents = sourceFile.getParents();

    if (!parents.hasNext()) {
      return;
    }

    DriveApp.getFileById(targetSpreadsheet.getId()).moveTo(parents.next());
  } catch (error) {
  }
}

function appendSaleArchive_(archiveSpreadsheet, saleName, archivedAt, orderHeaders, orderRows, itemHeaders, itemRows) {
  var sheetName = buildArchiveSheetName_(saleName);
  var sheet = archiveSpreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = archiveSpreadsheet.insertSheet(sheetName);
  }

  removeDefaultArchiveSheetIfEmpty_(archiveSpreadsheet, sheet);
  applySheetDirection_(sheet);

  var maxColumns = Math.max(orderHeaders.length, itemHeaders.length, 4);
  var rows = [];

  rows.push(padRow_(['ארכיון מכירה', saleName, 'תאריך ארכיון', archivedAt], maxColumns));
  rows.push(padRow_([''], maxColumns));
  rows.push(padRow_(['הזמנות'], maxColumns));
  rows.push(padRow_(orderHeaders, maxColumns));
  orderRows.forEach(function(row) {
    rows.push(padRow_(row, maxColumns));
  });
  rows.push(padRow_([''], maxColumns));
  rows.push(padRow_(['פריטי הזמנות'], maxColumns));
  rows.push(padRow_(itemHeaders, maxColumns));
  itemRows.forEach(function(row) {
    rows.push(padRow_(row, maxColumns));
  });

  var startRow = sheet.getLastRow() ? sheet.getLastRow() + 2 : 1;

  sheet.getRange(startRow, 1, rows.length, maxColumns).setValues(rows);
  formatSaleArchiveBlock_(sheet, startRow, rows.length, maxColumns, orderRows.length, itemRows.length);

  return sheet;
}

function formatSaleArchiveBlock_(sheet, startRow, rowCount, maxColumns, orderCount, itemCount) {
  sheet.getRange(startRow, 1, 1, maxColumns)
    .setBackground('#e5f2ec')
    .setFontWeight('bold')
    .setFontSize(14);
  sheet.getRange(startRow + 2, 1, 1, maxColumns)
    .setBackground('#1f7a5a')
    .setFontColor('#ffffff')
    .setFontWeight('bold');
  sheet.getRange(startRow + 3, 1, 1, maxColumns)
    .setBackground('#f7f6f1')
    .setFontWeight('bold');
  sheet.getRange(startRow + 5 + orderCount, 1, 1, maxColumns)
    .setBackground('#1f7a5a')
    .setFontColor('#ffffff')
    .setFontWeight('bold');
  sheet.getRange(startRow + 6 + orderCount, 1, 1, maxColumns)
    .setBackground('#f7f6f1')
    .setFontWeight('bold');
  sheet.getRange(startRow, 1, rowCount, maxColumns)
    .setBorder(true, true, true, true, true, true, '#d9ded6', SpreadsheetApp.BorderStyle.SOLID)
    .setWrap(true)
    .setVerticalAlignment('middle');
  sheet.setFrozenRows(0);
  sheet.autoResizeColumns(1, maxColumns);
}

function removeDefaultArchiveSheetIfEmpty_(archiveSpreadsheet, activeArchiveSheet) {
  var sheets = archiveSpreadsheet.getSheets();

  if (sheets.length <= 1) {
    return;
  }

  sheets.forEach(function(sheet) {
    if (sheet.getSheetId() === activeArchiveSheet.getSheetId()) {
      return;
    }

    if (sheet.getName() === 'Sheet1' && sheet.getLastRow() === 0) {
      archiveSpreadsheet.deleteSheet(sheet);
    }
  });
}

function buildArchiveSheetName_(saleName) {
  var name = String(saleName || 'ללא שם מכירה')
    .trim()
    .replace(/[\[\]\*\/\\\?:]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 99);

  return name || 'ללא שם מכירה';
}

function padRow_(row, length) {
  var output = row.slice();

  while (output.length < length) {
    output.push('');
  }

  return output.slice(0, length);
}

function getBodyRows_(sheet, columnCount) {
  if (!sheet || sheet.getLastRow() < 2) {
    return [];
  }

  return sheet
    .getRange(2, 1, sheet.getLastRow() - 1, columnCount)
    .getValues()
    .filter(function(row) {
      return row.some(function(value) {
        return String(value || '').trim();
      });
    });
}

function clearSheetBody_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) {
    return;
  }

  sheet
    .getRange(2, 1, sheet.getLastRow() - 1, Math.max(sheet.getLastColumn(), 1))
    .clearContent();
}

function resetPickingSheet_(ss) {
  var pickingSheet = ensurePickingSheet_(ss);

  pickingSheet.getDataRange().breakApart();
  pickingSheet.clear();
  setupPickingSheet_(pickingSheet);
}

function buildAddressText_(order) {
  if (order.fulfillment === 'משלוח') {
    return [
      order.address || '',
      order.floor ? 'קומה ' + order.floor : '',
      order.apartment ? 'דירה ' + order.apartment : ''
    ].filter(function(value) {
      return String(value || '').trim();
    }).join(', ');
  }

  return 'איסוף עצמי';
}

function formatEstimatedTotal_(estimatedTotal, unpricedItemCount) {
  var text = formatMoney_(estimatedTotal || 0);

  if (Number(unpricedItemCount || 0) > 0) {
    text += ' + ' + unpricedItemCount + ' פריטים לפי חישוב בפועל';
  }

  return text;
}

function readTable_(sheet) {
  var values = sheet.getDataRange().getValues();

  if (values.length < 2) {
    return [];
  }

  var headers = values[0].map(function(header) {
    return String(header || '').trim();
  });

  return values.slice(1)
    .filter(function(row) {
      return row.some(function(value) {
        return String(value || '').trim();
      });
    })
    .map(function(row) {
      var record = {};

      headers.forEach(function(header, index) {
        if (header) {
          record[header] = row[index];
        }
      });

      return record;
    });
}

function readProducts_(sheet) {
  var values = sheet.getDataRange().getValues();

  if (values.length < 2) {
    return [];
  }

  var headers = values[0];
  var columns = buildColumnMap_(headers);
  var products = [];

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var name = String(row[columns.name] || '').trim();
    var department = normalizeDepartment_(row[columns.department]);
    var unit = String(row[columns.unit] || '').trim() || 'יחידות';
    var priceUnit = columns.priceUnit === null
      ? unit
      : String(row[columns.priceUnit] || '').trim() || unit;
    var price = parsePrice_(row[columns.price]);
    var active = columns.active === null ? true : isActive_(row[columns.active]);

    if (!name || !active || !price || price <= 0) {
      continue;
    }

    var unitType = getUnitType_(unit);

    products.push({
      id: 'r' + (i + 1),
      rowNumber: i + 1,
      name: name,
      department: department,
      unit: unit,
      priceUnit: priceUnit,
      unitType: unitType,
      price: price,
      priceDisplay: formatPrice_(price)
    });
  }

  return products;
}

function buildColumnMap_(headers) {
  var map = {
    name: 0,
    department: 1,
    unit: 2,
    priceUnit: null,
    price: 3,
    active: null,
    detectedName: false,
    detectedPrice: false
  };

  headers.forEach(function(header, index) {
    var value = normalizeHeader_(header);

    if (!value) {
      return;
    }

    if (value === 'שם' || value === 'שם מוצר' || value === 'מוצר' || value === 'name' || value === 'product') {
      map.name = index;
      map.detectedName = true;
      return;
    }

    if (value.indexOf('מחלקה') !== -1 || value.indexOf('קטגוריה') !== -1 || value === 'department' || value === 'category') {
      map.department = index;
      return;
    }

    if ((value.indexOf('יחידת') !== -1 && value.indexOf('מחיר') !== -1) || value === 'יחידת מחיר' || value === 'price unit' || value === 'price_unit') {
      map.priceUnit = index;
      return;
    }

    if (value.indexOf('יחידת') !== -1 || value === 'יחידה' || value === 'unit') {
      map.unit = index;
      return;
    }

    if (value.indexOf('מחיר') !== -1 || value === 'price') {
      map.price = index;
      map.detectedPrice = true;
      return;
    }

    if (value.indexOf('פעיל') !== -1 || value.indexOf('זמין') !== -1 || value === 'active' || value === 'available') {
      map.active = index;
    }
  });

  return map;
}

function groupProducts_(products) {
  var byDepartment = {};

  products.forEach(function(product) {
    if (!byDepartment[product.department]) {
      byDepartment[product.department] = [];
    }

    byDepartment[product.department].push(product);
  });

  var order = PRINOK_CONFIG.CATEGORY_ORDER.slice();

  Object.keys(byDepartment).forEach(function(department) {
    if (order.indexOf(department) === -1) {
      order.push(department);
    }
  });

  return order
    .filter(function(department) {
      return byDepartment[department] && byDepartment[department].length;
    })
    .map(function(department) {
      byDepartment[department].sort(function(a, b) {
        return a.name.localeCompare(b.name, 'he');
      });

      return {
        name: department,
        products: byDepartment[department]
      };
    });
}

function ensureSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);

  if (!sheet) {
    sheet = ss.insertSheet(name);
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    applySheetDirection_(sheet);
    return sheet;
  }

  var firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  var hasHeaders = firstRow.some(function(value) {
    return String(value || '').trim();
  });

  if (!hasHeaders) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }

  var currentHeaders = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  var updatedHeaders = false;

  for (var i = 0; i < headers.length; i++) {
    if (!String(currentHeaders[i] || '').trim()) {
      currentHeaders[i] = headers[i];
      updatedHeaders = true;
    }
  }

  if (updatedHeaders) {
    sheet.getRange(1, 1, 1, headers.length).setValues([currentHeaders]);
  }

  applySheetDirection_(sheet);
  return sheet;
}

function applySheetDirection_(sheet) {
  try {
    sheet.setRightToLeft(true);
  } catch (error) {
  }
}

function getOrderHeaders_() {
  return [
    'זמן',
    'מספר הזמנה',
    'גיליון מוצרים',
    'שם מלא',
    'טלפון',
    'שיטת הזמנה',
    'כתובת',
    'קומה',
    'דירה',
    'הערות',
    'מספר שורות',
    'סטטוס',
    'סכום משוער',
    'פריטים ללא חישוב',
    'אימייל לקוח',
    'סטטוס מייל לקוח',
    'שגיאת מייל לקוח',
    'סטטוס מייל פרינוק',
    'שגיאת מייל פרינוק',
    'סטטוס טלגרם פרינוק',
    'שגיאת טלגרם פרינוק'
  ];
}

function getProductHeaders_() {
  return [
    'שם',
    'מחלקה',
    'יחידת מכירה',
    'מחיר',
    'יחידת מחיר',
    'פעיל'
  ];
}

function getOrderItemHeaders_() {
  return [
    'זמן',
    'מספר הזמנה',
    'מוצר',
    'מחלקה',
    'שיטת כמות',
    'כמות',
    'יחידת הזמנה',
    'מחיר מהגיליון',
    'יחידת מחיר',
    'סכום מחושב',
    'הערת מוצר'
  ];
}

function normalizeHeader_(value) {
  return String(value || '')
    .trim()
    .replace(/[״"]/g, '"')
    .replace(/[׳']/g, "'")
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizeDepartment_(value) {
  var department = String(value || '').trim();
  var normalized = department
    .replace(/[״"]/g, '"')
    .replace(/\s+/g, '')
    .toLowerCase();

  if (!normalized) {
    return 'אחר';
  }

  if (normalized === 'ירק' || normalized === 'ירקות') {
    return 'ירקות';
  }

  if (normalized === 'פרי' || normalized === 'פירות') {
    return 'פירות';
  }

  if (normalized === 'עלה' || normalized === 'עלים') {
    return 'עלים';
  }

  if (normalized === 'מיוחד' || normalized === 'מיוחדים') {
    return 'מיוחדים';
  }

  return department;
}

function getUnitType_(unit) {
  var value = String(unit || '')
    .trim()
    .replace(/[״"]/g, '"')
    .replace(/\s+/g, '');

  if (value.indexOf('קג') !== -1 || value.indexOf('ק"ג') !== -1) {
    return 'kg';
  }

  if (value.indexOf('יחידה') !== -1 || value.indexOf('יחידות') !== -1 || value.indexOf('יח') !== -1) {
    return 'unit';
  }

  return 'unit';
}

function canCalculateLineTotal_(mode, priceUnit) {
  var priceUnitType = getUnitType_(priceUnit);

  if (mode === 'kg') {
    return priceUnitType === 'kg';
  }

  return priceUnitType === 'unit';
}

function parsePrice_(value) {
  if (typeof value === 'number') {
    return value;
  }

  var cleaned = String(value || '')
    .replace(/[^\d.,-]/g, '')
    .replace(',', '.');

  return Number(cleaned);
}

function parseQuantity_(value) {
  if (typeof value === 'number') {
    return value;
  }

  var cleaned = String(value || '')
    .trim()
    .replace(',', '.');

  return Number(cleaned);
}

function isActive_(value) {
  if (value === '' || value === null || typeof value === 'undefined') {
    return true;
  }

  if (value === true) {
    return true;
  }

  if (value === false) {
    return false;
  }

  var text = String(value).trim().toLowerCase();

  return ['לא', 'לא פעיל', 'לא זמין', 'false', 'no', '0', 'כבוי'].indexOf(text) === -1;
}

function isWholeNumber_(value) {
  return Math.abs(value - Math.round(value)) < 0.000001;
}

function isHalfStep_(value) {
  return Math.abs(value * 2 - Math.round(value * 2)) < 0.000001;
}

function roundMoney_(value) {
  return Math.round(value * 100) / 100;
}

function formatPrice_(value) {
  var rounded = roundMoney_(value);

  if (isWholeNumber_(rounded)) {
    return String(Math.round(rounded));
  }

  return String(rounded).replace(/0+$/, '').replace(/\.$/, '');
}

function formatMoney_(value) {
  return '₪' + formatPrice_(Number(value || 0));
}

function formatQuantity_(value) {
  var number = Number(value || 0);

  if (isWholeNumber_(number)) {
    return String(Math.round(number));
  }

  return String(number).replace(/0+$/, '').replace(/\.$/, '');
}

function formatDateTime_(value) {
  if (!value) {
    return '';
  }

  var date = value instanceof Date ? value : new Date(value);

  if (isNaN(date.getTime())) {
    return String(value);
  }

  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm');
}

function safeFileName_(value) {
  return String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'לקוח';
}

function escapeHtml_(value) {
  return String(value || '').replace(/[&<>"']/g, function(char) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char];
  });
}
