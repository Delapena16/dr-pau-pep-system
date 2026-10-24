require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');

const BASE_URL = 'http://localhost:5000';
const ROOT_DIR = path.join(__dirname, '..');

let passCount = 0;
let failCount = 0;

function assertCheck(condition, label, detail = '') {
  if (condition) {
    passCount += 1;
    console.log(`  [PASS] ${label}`);
  } else {
    failCount += 1;
    console.error(`  [FAIL] ${label}${detail ? ' -> ' + detail : ''}`);
  }
}

function requestJson(method, urlPath, bodyObj = null, cookieHeader = '') {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
    const payload = bodyObj ? JSON.stringify(bodyObj) : null;

    const headers = {
      Accept: 'application/json'
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let parsed = {};
          try {
            parsed = JSON.parse(raw);
          } catch (e) {
            parsed = { raw };
          }
          const setCookies = res.headers['set-cookie'] || [];
          resolve({
            status: res.statusCode,
            headers: res.headers,
            cookies: setCookies,
            body: parsed
          });
        });
      }
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function readLatestOtpForEmail(email) {
  const logFile = path.join(ROOT_DIR, 'logs', 'mfa_dispatch.log');
  if (!fs.existsSync(logFile)) return null;
  const lines = fs.readFileSync(logFile, 'utf-8').trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    if (line.includes(email)) {
      const match = line.match(/:\s*(\d{6})\s*\(/);
      if (match) return match[1];
    }
  }
  return null;
}

async function loginAsRole(email, password) {
  const step1 = await requestJson('POST', '/api/auth/login', { email, password });
  if (step1.status !== 200) {
    return { step1, step2: null, cookie: '' };
  }
  const otp = readLatestOtpForEmail(email);
  const step2 = await requestJson('POST', '/api/auth/verify-otp', {
    email,
    otpCode: otp || '000000'
  });
  const cookieStr = (step2.cookies || []).map((c) => c.split(';')[0]).join('; ');
  return { step1, step2, cookie: cookieStr };
}

(async () => {
  console.log('================================================================================');
  console.log(' DR. PAU PEP SYSTEM — INVENTORY SPOILAGE / VOID TEST SUITE');
  console.log('================================================================================\n');

  try {
    // 1. SuperAdmin Login
    const adminAuth = await loginAsRole('admin@drpauclinic.ph', 'Admin@12345');
    assertCheck(adminAuth.step2?.status === 200, 'SuperAdmin 2FA login successful');

    // Fetch current inventory
    const invRes = await requestJson('GET', '/api/admin/inventory', null, adminAuth.cookie);
    assertCheck(invRes.status === 200, 'GET /api/admin/inventory retrieved');
    const inventoryList = invRes.body.data?.inventory || [];
    assertCheck(inventoryList.length > 0, `Inventory contains ${inventoryList.length} batches`);

    const targetBatch = inventoryList.find((i) => i.currentStock > 5) || inventoryList[0];
    const initialStock = targetBatch.currentStock;
    const batchLotId = targetBatch.batchNumber;
    console.log(`  [INFO] Target Lot: ${batchLotId} (${targetBatch.vaccineType}) with initial stock: ${initialStock} vials`);

    // 2. Validation Checks: Missing fields
    const missingLotRes = await requestJson(
      'POST',
      '/api/inventory/spoilage',
      { vialsToDeduct: 1, reason: 'Broken Vial' },
      adminAuth.cookie
    );
    assertCheck(
      missingLotRes.status === 400 && missingLotRes.body.message.includes('Batch Lot ID'),
      'Validation: Missing batchLotId returns HTTP 400'
    );

    const invalidCountRes = await requestJson(
      'POST',
      '/api/inventory/spoilage',
      { batchLotId, vialsToDeduct: 0, reason: 'Broken Vial' },
      adminAuth.cookie
    );
    assertCheck(
      invalidCountRes.status === 400 && invalidCountRes.body.message.includes('positive integer'),
      'Validation: Non-positive vialsToDeduct (0) returns HTTP 400'
    );

    // 3. Stock Exceeded Check: Deduct more vials than available
    const excessiveRes = await requestJson(
      'POST',
      '/api/inventory/spoilage',
      { batchLotId, vialsToDeduct: initialStock + 100, reason: 'Broken Vial' },
      adminAuth.cookie
    );
    assertCheck(
      excessiveRes.status === 400 && excessiveRes.body.message.includes('Cannot void'),
      `Safety Boundary: Deducting ${initialStock + 100} vials when only ${initialStock} available returns HTTP 400`
    );

    // 4. Non-Existent Batch Check
    const nonExistentRes = await requestJson(
      'POST',
      '/api/inventory/spoilage',
      { batchLotId: 'NON-EXISTENT-LOT-999', vialsToDeduct: 1, reason: 'Clerical Error' },
      adminAuth.cookie
    );
    assertCheck(
      nonExistentRes.status === 404,
      'Safety Boundary: Non-existent batchLotId returns HTTP 404'
    );

    // 5. RBAC Protection: Non-Admin attempts
    const physAuth = await loginAsRole('physician@drpauclinic.ph', 'Physician@12345');
    const physForbiddenRes = await requestJson(
      'POST',
      '/api/inventory/spoilage',
      { batchLotId, vialsToDeduct: 1, reason: 'Broken Vial' },
      physAuth.cookie
    );
    assertCheck(
      physForbiddenRes.status === 403,
      'RBAC Boundary: Physician blocked from /api/inventory/spoilage with HTTP 403 Forbidden'
    );

    const recepAuth = await loginAsRole('receptionist@drpauclinic.ph', 'Reception@12345');
    const recepForbiddenRes = await requestJson(
      'POST',
      '/api/inventory/spoilage',
      { batchLotId, vialsToDeduct: 1, reason: 'Broken Vial' },
      recepAuth.cookie
    );
    assertCheck(
      recepForbiddenRes.status === 403,
      'RBAC Boundary: Receptionist blocked from /api/inventory/spoilage with HTTP 403 Forbidden'
    );

    // 6. Valid Spoilage Void Execution
    const voidCount = 2;
    const voidReason = 'Physical Damage / Broken Vial During Unpacking';
    const validVoidRes = await requestJson(
      'POST',
      '/api/inventory/spoilage',
      {
        batchLotId,
        vialsToDeduct: voidCount,
        reason: voidReason
      },
      adminAuth.cookie
    );
    assertCheck(
      validVoidRes.status === 200,
      `SuperAdmin POST /api/inventory/spoilage voids ${voidCount} vials successfully (HTTP 200)`
    );

    const afterStock = validVoidRes.body.data?.remainingStock;
    assertCheck(
      afterStock === initialStock - voidCount,
      `Stock count accurately decremented (${initialStock} -> ${afterStock})`
    );

    // 7. Verify Audit Log entry created
    const overviewRes = await requestJson('GET', '/api/admin/overview', null, adminAuth.cookie);
    const auditLogs = overviewRes.body.data?.recentAuditLogs || [];
    const latestSpoilageLog = auditLogs.find(
      (log) => log.actionType === 'INVENTORY_SPOILAGE_VOID' && log.description.includes(batchLotId)
    );
    assertCheck(
      Boolean(latestSpoilageLog) && latestSpoilageLog.description.includes(voidReason),
      'Immutable Ledger: AuditLog record created with actionType INVENTORY_SPOILAGE_VOID and void reason'
    );

    // 8. Test alias route: /api/admin/inventory/spoilage
    const aliasRes = await requestJson(
      'POST',
      '/api/admin/inventory/spoilage',
      {
        batchLotId,
        vialsToDeduct: 1,
        reason: 'Clerical Typo on Expiry Date'
      },
      adminAuth.cookie
    );
    assertCheck(
      aliasRes.status === 200 && aliasRes.body.data?.remainingStock === afterStock - 1,
      'Router Alias: POST /api/admin/inventory/spoilage operates identically'
    );

  } catch (err) {
    console.error('Test execution error:', err);
    failCount += 1;
  }

  console.log('\n================================================================================');
  console.log(` INVENTORY SPOILAGE / VOID SUMMARY: ${passCount} PASSED | ${failCount} FAILED`);
  console.log('================================================================================\n');

  process.exit(failCount > 0 ? 1 : 0);
})();
