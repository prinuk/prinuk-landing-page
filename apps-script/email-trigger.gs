/**
 * פונקציה שרצה כל דקה ומטפלת בהזמנות חדשות:
 * - שולחת מייל התראה לבעל העסק
 * - שולחת עותק מייל ללקוח
 * - מעדכנת את דף הליקוט
 * - לא משנה את סטטוס הטיפול בהזמנה
 *
 * להוספה ל-Apps Script:
 * 1. מעתיקים את כל הקוד הזה
 * 2. ב-Apps Script יוצרים קובץ חדש (+ ליד Files) בשם emailTrigger
 * 3. מדביקים את הקוד
 * 4. מגדירים טריגר (ראו הוראות ב-README)
 */

function processNewOrders() {
  var lock = LockService.getScriptLock();

  if (!lock.tryLock(5000)) {
    return;
  }

  try {
    processNewOrders_();
  } finally {
    lock.releaseLock();
  }
}

function processNewOrders_() {
  var ss = getSpreadsheet_();
  var ordersSheet = ensureSheet_(ss, PRINOK_CONFIG.ORDERS_SHEET_NAME, getOrderHeaders_());

  if (!ordersSheet || ordersSheet.getLastRow() < 2) {
    return;
  }

  var productSheet = getProductSheet_(ss);
  var settings = getSettings_(ss, productSheet);
  var orderItemsSheet = ss.getSheetByName(PRINOK_CONFIG.ORDER_ITEMS_SHEET_NAME);

  var orderHeaders = getOrderHeaders_();
  var statusColIndex = orderHeaders.indexOf('סטטוס');
  var customerEmailColIndex = orderHeaders.indexOf('אימייל לקוח');
  var customerEmailStatusColIndex = orderHeaders.indexOf('סטטוס מייל לקוח');
  var customerEmailErrorColIndex = orderHeaders.indexOf('שגיאת מייל לקוח');
  var businessEmailStatusColIndex = orderHeaders.indexOf('סטטוס מייל פרינוק');
  var businessEmailErrorColIndex = orderHeaders.indexOf('שגיאת מייל פרינוק');
  var telegramStatusColIndex = orderHeaders.indexOf('סטטוס טלגרם פרינוק');
  var telegramErrorColIndex = orderHeaders.indexOf('שגיאת טלגרם פרינוק');

  var lastRow = ordersSheet.getLastRow();
  var allRows = ordersSheet.getRange(2, 1, lastRow - 1, orderHeaders.length).getValues();

  var allItems = [];

  if (orderItemsSheet && orderItemsSheet.getLastRow() >= 2) {
    allItems = readTable_(orderItemsSheet);
  }

  var itemsByOrderId = {};

  allItems.forEach(function (item) {
    var orderId = item['מספר הזמנה'];

    if (!itemsByOrderId[orderId]) {
      itemsByOrderId[orderId] = [];
    }

    itemsByOrderId[orderId].push(item);
  });

  var processedCount = 0;

  for (var i = 0; i < allRows.length; i++) {
    var row = allRows[i];
    var status = String(row[statusColIndex] || '').trim();
    var customerEmail = String(row[customerEmailColIndex] || '').trim();
    var customerEmailStatus = String(row[customerEmailStatusColIndex] || '').trim();
    var customerEmailError = String(row[customerEmailErrorColIndex] || '').trim();
    var businessEmailStatus = String(row[businessEmailStatusColIndex] || '').trim();
    var businessEmailError = String(row[businessEmailErrorColIndex] || '').trim();
    var telegramStatus = String(row[telegramStatusColIndex] || '').trim();
    var telegramError = String(row[telegramErrorColIndex] || '').trim();
    var shouldSendCustomerEmail = shouldAttemptCustomerEmail_(customerEmailStatus, customerEmail, customerEmailError);
    var shouldSendBusinessEmail = shouldAttemptBusinessEmail_(businessEmailStatus, businessEmailError);
    var shouldSendTelegram = shouldAttemptTelegram_(telegramStatus, telegramError);

    if (!shouldSendCustomerEmail && !shouldSendBusinessEmail && !shouldSendTelegram) {
      continue;
    }

    var rowNumber = i + 2;
    var orderId = String(row[1] || '');
    var orderItems = itemsByOrderId[orderId] || [];

    var orderData = {
      timestamp: row[0],
      orderId: orderId,
      productSheetName: String(row[2] || ''),
      fullName: String(row[3] || ''),
      phone: String(row[4] || ''),
      email: customerEmail,
      title: settings.title,
      saleName: settings.saleName,
      logoUrl: settings.logoUrl,
      contactPhone: settings.contactPhone,
      contactEmail: settings.contactEmail,
      fulfillment: String(row[5] || ''),
      address: String(row[6] || ''),
      floor: String(row[7] || ''),
      apartment: String(row[8] || ''),
      notes: String(row[9] || ''),
      itemCount: Number(row[10] || 0),
      estimatedTotal: parsePrice_(row[12]),
      unpricedItemCount: Number(row[13] || 0)
    };

    var normalizedItems = orderItems.map(function (item) {
      var rawTotal = item['סכום מחושב'];
      var lineTotal = (rawTotal !== '' && rawTotal !== undefined && rawTotal !== null)
        ? Number(rawTotal)
        : '';

      return {
        product: {
          name: item['מוצר'],
          department: item['מחלקה'],
          price: parsePrice_(item['מחיר מהגיליון']),
          priceUnit: item['יחידת מחיר'] || ''
        },
        quantity: Number(item['כמות'] || 0),
        orderUnit: item['יחידת הזמנה'] || '',
        lineTotal: lineTotal,
        note: String(item['הערת מוצר'] || '').trim()
      };
    });

    var businessEmailResult = null;
    var customerEmailResult = null;
    var telegramResult = null;

    if (shouldSendTelegram) {
      telegramResult = sendNewOrderTelegramWithRetryLimit_(settings, orderData, normalizedItems, telegramError);
    }

    if (shouldSendBusinessEmail) {
      businessEmailResult = sendBusinessNotificationWithRetryLimit_(settings, orderData, normalizedItems, businessEmailError);
    }

    if (shouldSendCustomerEmail) {
      customerEmailResult = sendCustomerCopyWithRetryLimit_(settings, orderData, normalizedItems, customerEmailError);
    }

    if (status === 'חדש' && !pickingSheetHasOrder_(ss, orderId)) {
      try {
        appendPickingOrder_(ss, orderData, normalizedItems);
      } catch (e) {
        Logger.log('עדכון דף ליקוט נכשל להזמנה ' + orderId + ': ' + e.message);
      }
    }

    if (customerEmailResult) {
      updateCustomerEmailStatus_(ordersSheet, rowNumber, customerEmailResult);
    }

    if (businessEmailResult) {
      updateBusinessEmailStatus_(ordersSheet, rowNumber, businessEmailResult);
    }

    if (telegramResult) {
      updateTelegramStatus_(ordersSheet, rowNumber, telegramResult);
    }

    processedCount++;
  }

  if (processedCount > 0) {
    Logger.log('עובדו ' + processedCount + ' הזמנות חדשות.');
  }
}

function shouldAttemptCustomerEmail_(status, email, errorText) {
  if (!email) {
    return false;
  }

  if (status === 'לא נשלח' || status === 'ממתין לשליחה') {
    return true;
  }

  if (status !== 'נכשל') {
    return false;
  }

  if (isInvalidCustomerEmailError_(errorText)) {
    return false;
  }

  return getCustomerEmailRetryCount_(errorText) < 3;
}

function sendCustomerCopyWithRetryLimit_(settings, orderData, normalizedItems, previousError) {
  if (!isValidCustomerEmail_(orderData.email)) {
    var invalidError = 'לא נשלח: כתובת המייל אינה תקינה.';
    var invalidTelegram = trySendEmailProblemTelegramAlert_(settings, orderData, normalizedItems, 'customer', invalidError);
    return {
      status: 'כתובת מייל לא תקינה',
      error: invalidError + formatTelegramAlertNote_(invalidTelegram)
    };
  }

  var previousRetryCount = getCustomerEmailRetryCount_(previousError);
  var result = trySendCustomerCopy_(settings, orderData, normalizedItems);

  if (result.status !== 'נכשל') {
    return result;
  }

  if (isInvalidCustomerEmailError_(result.error)) {
    var customerInvalidTelegram = trySendEmailProblemTelegramAlert_(settings, orderData, normalizedItems, 'customer', result.error || '');
    return {
      status: 'כתובת מייל לא תקינה',
      error: (result.error || 'לא נשלח: כתובת המייל אינה תקינה.') + formatTelegramAlertNote_(customerInvalidTelegram)
    };
  }

  var retryCount = previousRetryCount + 1;
  var fallbackNote = '';

  if (retryCount >= 3) {
    var customerTelegram = trySendEmailProblemTelegramAlert_(settings, orderData, normalizedItems, 'customer', result.error || '');
    fallbackNote = formatTelegramAlertNote_(customerTelegram);
  }

  return {
    status: retryCount >= 3 ? 'נכשל סופית' : 'נכשל',
    error: 'ניסיון ' + retryCount + '/3: ' + (result.error || 'שליחת המייל נכשלה.') + fallbackNote
  };
}

function shouldAttemptBusinessEmail_(status, errorText) {
  if (status === 'לא נשלח' || status === 'ממתין לשליחה') {
    return true;
  }

  if (status !== 'נכשל') {
    return false;
  }

  if (isInvalidCustomerEmailError_(errorText)) {
    return false;
  }

  return getCustomerEmailRetryCount_(errorText) < 3;
}

function sendBusinessNotificationWithRetryLimit_(settings, orderData, normalizedItems, previousError) {
  if (!settings.notificationEmails) {
    return {
      status: 'לא הוגדר מייל',
      error: ''
    };
  }

  var previousRetryCount = getCustomerEmailRetryCount_(previousError);
  var result = trySendOrderNotification_(settings, orderData, normalizedItems);

  if (result.status !== 'נכשל') {
    return result;
  }

  if (isInvalidCustomerEmailError_(result.error)) {
    var businessInvalidTelegram = trySendEmailProblemTelegramAlert_(settings, orderData, normalizedItems, 'business', result.error || '');
    return {
      status: 'כתובת מייל פרינוּק לא תקינה',
      error: (result.error || 'לא נשלח: כתובת המייל של פרינוּק אינה תקינה.') + formatTelegramAlertNote_(businessInvalidTelegram)
    };
  }

  var retryCount = previousRetryCount + 1;
  var fallbackNote = '';

  if (retryCount >= 3) {
    var telegramResult = trySendEmailProblemTelegramAlert_(settings, orderData, normalizedItems, 'business', result.error || '');
    fallbackNote = formatTelegramAlertNote_(telegramResult);
  }

  return {
    status: retryCount >= 3 ? 'נכשל סופית' : 'נכשל',
    error: 'ניסיון ' + retryCount + '/3: ' + (result.error || 'שליחת מייל פרינוּק נכשלה.') + fallbackNote
  };
}

function shouldAttemptTelegram_(status, errorText) {
  if (status === 'לא נשלח' || status === 'ממתין לשליחה') {
    return true;
  }

  if (status !== 'נכשל') {
    return false;
  }

  return getCustomerEmailRetryCount_(errorText) < 3;
}

function sendNewOrderTelegramWithRetryLimit_(settings, orderData, normalizedItems, previousError) {
  var previousRetryCount = getCustomerEmailRetryCount_(previousError);
  var result = trySendNewOrderTelegramAlert_(settings, orderData, normalizedItems);

  if (result.status !== 'נכשל') {
    return result;
  }

  var retryCount = previousRetryCount + 1;

  return {
    status: retryCount >= 3 ? 'נכשל סופית' : 'נכשל',
    error: 'ניסיון ' + retryCount + '/3: ' + (result.error || 'שליחת טלגרם נכשלה.')
  };
}

function formatTelegramAlertNote_(telegramResult) {
  telegramResult = telegramResult || {
    status: '',
    error: ''
  };

  if (telegramResult.status === 'נשלח לטלגרם') {
    return ' | נשלחה התראת טלגרם דחופה';
  }

  if (telegramResult.status === 'לא הוגדר טלגרם') {
    return ' | לא נשלחה התראת טלגרם: לא הוגדר טלגרם';
  }

  return ' | התראת טלגרם נכשלה: ' + (telegramResult.error || telegramResult.status || 'לא ידוע');
}

function getCustomerEmailRetryCount_(errorText) {
  var match = String(errorText || '').match(/ניסיון\s+(\d+)\/3/);
  return match ? Number(match[1]) || 0 : 0;
}

function isValidCustomerEmail_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function isInvalidCustomerEmailError_(errorText) {
  var text = String(errorText || '').toLowerCase();
  return text.indexOf('כתובת המייל אינה תקינה') !== -1 ||
    text.indexOf('invalid email') !== -1 ||
    text.indexOf('invalid recipient') !== -1 ||
    text.indexOf('recipient address required') !== -1;
}

function pickingSheetHasOrder_(ss, orderId) {
  var sheet = ss.getSheetByName(PRINOK_CONFIG.PICKING_SHEET_NAME);

  if (!sheet || !orderId || sheet.getLastRow() < 1) {
    return false;
  }

  var values = sheet.getDataRange().getDisplayValues();

  for (var row = 0; row < values.length; row++) {
    for (var col = 0; col < values[row].length; col++) {
      if (String(values[row][col] || '').trim() === orderId) {
        return true;
      }
    }
  }

  return false;
}
