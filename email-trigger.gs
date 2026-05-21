/**
 * פונקציה שרצה כל דקה ומטפלת בהזמנות חדשות:
 * - שולחת מייל התראה לבעל העסק
 * - שולחת עותק מייל ללקוח
 * - מעדכנת את דף הליקוט
 * - משנה סטטוס ל"טופל"
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
  var ordersSheet = ss.getSheetByName(PRINOK_CONFIG.ORDERS_SHEET_NAME);

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
  var statusCol = statusColIndex + 1;

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
    var shouldProcessOrder = status === 'חדש' && shouldProcessOrderFromCustomerEmailStatus_(customerEmailStatus, customerEmail);
    var shouldSendCustomerEmail = shouldAttemptCustomerEmail_(customerEmailStatus, customerEmail, customerEmailError);

    if (!shouldProcessOrder && !shouldSendCustomerEmail) {
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
        lineTotal: lineTotal
      };
    });

    if (shouldProcessOrder) {
      trySendOrderNotification_(settings, orderData, normalizedItems);
    }

    var customerEmailResult = null;

    if (shouldSendCustomerEmail) {
      customerEmailResult = sendCustomerCopyWithRetryLimit_(settings, orderData, normalizedItems, customerEmailError);
    }

    if (shouldProcessOrder) {
      try {
        appendPickingOrder_(ss, orderData, normalizedItems);
      } catch (e) {
        Logger.log('עדכון דף ליקוט נכשל להזמנה ' + orderId + ': ' + e.message);
      }

      ordersSheet.getRange(rowNumber, statusCol).setValue('טופל');
    }

    if (customerEmailResult) {
      updateCustomerEmailStatus_(ordersSheet, rowNumber, customerEmailResult);
    }

    processedCount++;
  }

  if (processedCount > 0) {
    Logger.log('עובדו ' + processedCount + ' הזמנות חדשות.');
  }
}

function shouldProcessOrderFromCustomerEmailStatus_(status, email) {
  if (!email) {
    return status === 'לא נמסר מייל';
  }

  return status === 'לא נשלח' || status === 'ממתין לשליחה';
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
    return {
      status: 'כתובת מייל לא תקינה',
      error: 'לא נשלח: כתובת המייל אינה תקינה.'
    };
  }

  var previousRetryCount = getCustomerEmailRetryCount_(previousError);
  var result = trySendCustomerCopy_(settings, orderData, normalizedItems);

  if (result.status !== 'נכשל') {
    return result;
  }

  if (isInvalidCustomerEmailError_(result.error)) {
    return {
      status: 'כתובת מייל לא תקינה',
      error: result.error || 'לא נשלח: כתובת המייל אינה תקינה.'
    };
  }

  var retryCount = previousRetryCount + 1;

  return {
    status: retryCount >= 3 ? 'נכשל סופית' : 'נכשל',
    error: 'ניסיון ' + retryCount + '/3: ' + (result.error || 'שליחת המייל נכשלה.')
  };
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
