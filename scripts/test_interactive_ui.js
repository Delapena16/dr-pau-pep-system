require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { spawn, execSync } = require('child_process');

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
  const otp = readLatestOtpForEmail(email);
  const step2 = await requestJson('POST', '/api/auth/verify-otp', {
    email,
    otpCode: otp || '000000'
  });
  const cookieStr = (step2.cookies || []).map((c) => c.split(';')[0]).join('; ');
  return { step1, step2, cookie: cookieStr };
}

async function runStaticDomAndInteractionAudit() {
  console.log('\n[PART 1] DOM BINDING, MASTER-DETAIL ROW SELECTION & UX AUDIT');

  const html = fs.readFileSync(path.join(ROOT_DIR, 'public', 'index.html'), 'utf-8');
  const js = fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'app.js'), 'utf-8');
  const css = fs.readFileSync(path.join(ROOT_DIR, 'public', 'css', 'styles.css'), 'utf-8');

  const htmlIds = new Set();
  const idRegex = /\bid=["']([^"']+)["']/g;
  let m;
  while ((m = idRegex.exec(html)) !== null) {
    htmlIds.add(m[1]);
  }

  const jsIds = new Set();
  const getByIdRegex = /getElementById\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = getByIdRegex.exec(js)) !== null) {
    jsIds.add(m[1]);
  }

  const missingIds = [...jsIds].filter((id) => !htmlIds.has(id));
  assertCheck(
    missingIds.length === 0,
    `All ${jsIds.size} getElementById() references in app.js match DOM IDs in index.html`,
    missingIds.join(', ')
  );

  assertCheck(
    !html.includes('id="roleWorkflowGuideBar"') && !js.includes('Step 1: Register new walk-in'),
    'Instructional "Step 1 / Step 2" helper banners removed from UI'
  );

  assertCheck(
    js.includes('.btn-assess-triage') &&
      js.includes('tr.patient-row') &&
      js.includes("document.getElementById('physTriageQueueBody').addEventListener('click'"),
    'Event delegation bound on #physTriageQueueBody for both .btn-assess-triage and tr.patient-row'
  );

  assertCheck(
    css.includes('.clinical-table tbody tr.active-row') &&
      css.includes('#F3E8FF') &&
      css.includes('#7A1FA2'),
    'Selected patient row active state (#F3E8FF background & 4px #7A1FA2 border) styled in styles.css'
  );

  assertCheck(
    js.includes("selectedCat === 'Category I'") &&
      js.includes('Complete Assessment (No Vaccine Needed)') &&
      js.includes('ERIG + Anti-Rabies Required'),
    'Smart contextual form defaults (Category I disables vial dropdown; Category III shows ERIG badge)'
  );

  assertCheck(
    html.includes('data-rec-kpi-filter=') &&
      html.includes('data-phys-kpi-filter=') &&
      js.includes("document.querySelectorAll('[data-phys-kpi-filter]')"),
    'Clickable KPI filter cards bound for both Receptionist and Physician workspaces'
  );

  assertCheck(
    html.includes('Log Dose &amp; Update Chart') &&
      html.includes('Save Notes Only') &&
      html.includes('Update Forecast'),
    'Natural consumer-grade button labels ("Log Dose & Update Chart", "Save Notes Only", "Update Forecast") present'
  );

  // Execute app.js in a simulated DOM environment to verify zero TypeError/ReferenceError on bind & interaction
  let runtimeError = null;
  let rowSelectionSwitchedCorrectly = false;
  let pokaYokeWorked = false;

  try {
    const elementsById = {};
    const makeEl = (id = '') => {
      const classes = new Set();
      const listeners = {};
      const attrs = {};
      return {
        id,
        value: id === 'physWoundCategory' ? 'Category II' : '',
        textContent: '',
        innerHTML: '',
        checked: true,
        disabled: false,
        classList: {
          add: (...c) => c.forEach((x) => classes.add(x)),
          remove: (...c) => c.forEach((x) => classes.delete(x)),
          toggle: (c, force) => {
            if (force === undefined) {
              if (classes.has(c)) classes.delete(c);
              else classes.add(c);
            } else if (force) {
              classes.add(c);
            } else {
              classes.delete(c);
            }
          },
          contains: (c) => classes.has(c)
        },
        setAttribute: (k, v) => {
          attrs[k] = v;
        },
        getAttribute: (k) => attrs[k] || null,
        addEventListener: (evt, fn) => {
          listeners[evt] = listeners[evt] || [];
          listeners[evt].push(fn);
        },
        trigger: (evt, eventObj = {}) => {
          (listeners[evt] || []).forEach((fn) =>
            fn({ preventDefault: () => {}, target: { reset: () => {}, closest: () => null }, ...eventObj })
          );
        },
        querySelectorAll: () => [],
        focus: () => {},
        reset: () => {}
      };
    };

    htmlIds.forEach((id) => {
      elementsById[id] = makeEl(id);
    });

    const docListeners = {};
    const sandboxWindow = {
      setTimeout: (fn) => 1,
      clearTimeout: () => {},
      fetch: async () => ({
        ok: true,
        json: async () => ({
          data: {
            user: {
              fullName: 'Dr. Paulo R. Santos, MD',
              email: 'physician@drpauclinic.ph',
              role: 'Physician'
            },
            patients: [
              {
                patientId: 'PEP-2026-001',
                fullName: 'Reynaldo Sarmiento',
                age: 29,
                sex: 'Male',
                purok: 'Purok 1, Kapitan Pepe',
                animalType: 'Stray Dog',
                biteSite: 'Right Hand (Palm)',
                woundCategory: 'Pending',
                pepSchedule: [{ doseDay: 'Day 0', scheduledDate: '2026-10-18', status: 'Pending' }]
              },
              {
                patientId: 'PEP-2026-002',
                fullName: 'Clarissa Dizon-Gomez',
                age: 24,
                sex: 'Female',
                purok: 'Purok 4, Kapitan Pepe',
                animalType: 'Cat',
                biteSite: 'Left Wrist',
                woundCategory: 'Pending',
                pepSchedule: [{ doseDay: 'Day 0', scheduledDate: '2026-10-18', status: 'Pending' }]
              },
              {
                patientId: 'PEP-2026-003',
                fullName: 'Mateo Villanueva',
                age: 19,
                sex: 'Male',
                purok: 'Purok 3, Kapitan Pepe',
                animalType: 'Stray Dog',
                biteSite: 'Right Calf',
                woundCategory: 'Category III',
                pepSchedule: [
                  { doseDay: 'Day 0', scheduledDate: '2026-10-14', status: 'Fulfilled' },
                  { doseDay: 'Day 3', scheduledDate: '2026-10-18', status: 'Pending' }
                ]
              }
            ],
            inventory: [
              { vaccineType: 'anti-rabies', currentStock: 84, batchNumber: 'VRB-2026-A104', expirationDate: '2027-06-30' }
            ]
          }
        })
      })
    };

    const sandboxDoc = {
      getElementById: (id) => elementsById[id] || makeEl(id),
      querySelectorAll: () => [],
      addEventListener: (evt, fn) => {
        docListeners[evt] = fn;
      }
    };

    vm.runInNewContext(js, {
      window: sandboxWindow,
      document: sandboxDoc,
      fetch: sandboxWindow.fetch,
      console,
      setTimeout: sandboxWindow.setTimeout,
      clearTimeout: sandboxWindow.clearTimeout,
      Date,
      Number,
      String,
      Boolean,
      Array,
      Object,
      Math
    });

    if (docListeners.DOMContentLoaded) {
      await docListeners.DOMContentLoaded();
    }

    // Simulate clicking Clarissa Dizon-Gomez (PEP-2026-002) via #physTriageQueueBody event delegation
    elementsById.physTriageQueueBody.trigger('click', {
      target: {
        closest: () => ({
          getAttribute: () => 'PEP-2026-002'
        })
      }
    });

    const clarissaSelected =
      elementsById.physSelectedPatientId.value === 'PEP-2026-002' &&
      elementsById.physActivePatientBanner.innerHTML.includes('Clarissa Dizon-Gomez') &&
      elementsById.physDoseDaySelect.value === 'Day 0';

    // Simulate switching to Mateo Villanueva (PEP-2026-003) and verifying Day 3 auto-selection
    sandboxWindow.selectPatient('PEP-2026-003');
    const mateoSelected =
      elementsById.physSelectedPatientId.value === 'PEP-2026-003' &&
      elementsById.physActivePatientBanner.innerHTML.includes('Mateo Villanueva') &&
      elementsById.physDoseDaySelect.value === 'Day 3';


    // Test Category I Poka-Yoke
    elementsById.physWoundCategory.value = 'Category I';
    elementsById.physWoundCategory.trigger('change');
    const cat1DisabledVial = elementsById.physVaccineSelect.disabled === true;
    const cat1ButtonLabel =
      elementsById.physSaveTriageOnlyBtn.textContent === 'Complete Assessment (No Vaccine Needed)';

    // Test Category III badge
    elementsById.physWoundCategory.value = 'Category III';
    elementsById.physWoundCategory.trigger('change');
    const cat3EnabledVial = elementsById.physVaccineSelect.disabled === false;
    const cat3BadgeShown = !elementsById.physCat3ErigBadge.classList.contains('hidden');

    pokaYokeWorked = cat1DisabledVial && cat1ButtonLabel && cat3EnabledVial && cat3BadgeShown;
    rowSelectionSwitchedCorrectly = clarissaSelected && mateoSelected;
  } catch (err) {
    runtimeError = err;
  }

  assertCheck(
    runtimeError === null && rowSelectionSwitchedCorrectly && pokaYokeWorked,
    'DOM runtime execution of app.js (Clarissa PEP-2026-002 Day 0 & Mateo PEP-2026-003 Day 3 switching + Category I/III Poka-Yoke) completed with 0 errors',
    runtimeError ? runtimeError.stack : ''
  );
}

async function restartFreshServer() {
  if (process.platform === 'win32') {
    try {
      execSync(
        'powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 5000 -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -ne 0 } | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"',
        { stdio: 'ignore' }
      );
    } catch (e) {
      // ignore if nothing was listening
    }
  }

  await new Promise((r) => setTimeout(r, 600));

  const proc = spawn(process.execPath, [path.join(ROOT_DIR, 'server.js')], {
    cwd: ROOT_DIR,
    stdio: 'ignore'
  });

  for (let i = 0; i < 120; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const health = await requestJson('GET', '/api/health');
      if (health.status === 200) {
        return proc;
      }
    } catch (e) {
      // wait until listening
    }
  }
  throw new Error('Server failed to start on port 5000.');
}

async function runLiveApiAndClinicalSimulation() {
  console.log('\n[PART 2] 15 REST API ENDPOINTS, RBAC 403 BOUNDARIES & CLARISSA (PEP-2026-002) E2E TEST');

  const spawnedServer = await restartFreshServer();

  try {
    // 1. Receptionist Login & Session Verification
    const recAuth = await loginAsRole('receptionist@drpauclinic.ph', 'Reception@12345');
    assertCheck(
      recAuth.step1.status === 200 && recAuth.step2.status === 200,
      'API 1 & 2: POST /api/auth/login & POST /api/auth/verify-otp (Receptionist 2FA)'
    );

    const meRes = await requestJson('GET', '/api/auth/me', null, recAuth.cookie);
    assertCheck(meRes.status === 200 && meRes.body.data?.user?.role === 'Receptionist', 'API 3: GET /api/auth/me');

    // 2. Receptionist Endpoints & Validation
    const walkInRes = await requestJson(
      'POST',
      '/api/receptionist/register-walkin',
      {
        fullName: 'Benigno Solis',
        age: 27,
        sex: 'Male',
        contactNumber: '09178823412',
        purok: 'Purok 2, Kapitan Pepe',
        barangay: 'Brgy. Kapitan Pepe',
        animalType: 'Dog',
        biteSite: 'Right Hand',
        consentGiven: true
      },
      recAuth.cookie
    );
    assertCheck(
      walkInRes.status === 200 && walkInRes.body.message.includes("Added Benigno Solis to Doctor's Queue"),
      "API 4: POST /api/receptionist/register-walkin adds patient & returns 'Added [Name] to Doctor's Queue'"
    );

    const recQueueRes = await requestJson('GET', '/api/receptionist/queue', null, recAuth.cookie);
    assertCheck(recQueueRes.status === 200 && recQueueRes.body.data?.patients?.length >= 10, 'API 5: GET /api/receptionist/queue');

    const recFollowRes = await requestJson('GET', '/api/receptionist/followup-today', null, recAuth.cookie);
    assertCheck(recFollowRes.status === 200, 'API 6: GET /api/receptionist/followup-today');

    const checkinRes = await requestJson('PUT', '/api/receptionist/checkin/PEP-2026-006', {}, recAuth.cookie);
    assertCheck(
      checkinRes.status === 200 && checkinRes.body.data?.patientRecord?.checkedInForTriage === true,
      'API 7: PUT /api/receptionist/checkin/:id checks in returning booster patient'
    );

    // 3. RBAC 403 checks for Receptionist
    const recForbiddenTriage = await requestJson(
      'POST',
      '/api/physician/triage/PEP-2026-002',
      { woundCategory: 'Category II' },
      recAuth.cookie
    );
    assertCheck(
      recForbiddenTriage.status === 403,
      'RBAC Boundary: Receptionist blocked from Physician Triage API with HTTP 403 Forbidden'
    );

    // 4. Physician Login & Clarissa Dizon-Gomez (PEP-2026-002) Triage + Day 0 Dose Test
    const physAuth = await loginAsRole('physician@drpauclinic.ph', 'Physician@12345');
    assertCheck(physAuth.step2.status === 200, 'Physician 2FA login completed');

    const physQueueRes = await requestJson('GET', '/api/physician/queue', null, physAuth.cookie);
    const clarissaBefore = (physQueueRes.body.data?.patients || []).find(
      (p) => p.patientId === 'PEP-2026-002'
    );
    assertCheck(
      physQueueRes.status === 200 &&
        clarissaBefore &&
        clarissaBefore.fullName === 'Clarissa Dizon-Gomez' &&
        clarissaBefore.woundCategory === 'Pending',
      'API 8: GET /api/physician/queue retrieves Clarissa Dizon-Gomez (PEP-2026-002) in Pending state'
    );

    const batchesBeforeRes = await requestJson('GET', '/api/physician/batches', null, physAuth.cookie);
    const rabiesBefore = (batchesBeforeRes.body.data?.inventory || [])
      .filter((i) => i.vaccineType === 'anti-rabies')
      .reduce((sum, i) => sum + Number(i.currentStock || 0), 0);
    assertCheck(
      batchesBeforeRes.status === 200 && rabiesBefore > 0,
      `API 9: GET /api/physician/batches (Initial Anti-Rabies stock: ${rabiesBefore} vials)`
    );

    // Simulate clicking Clarissa Dizon-Gomez (PEP-2026-002) and clicking "Save Notes Only" first
    const saveNotesRes = await requestJson(
      'POST',
      '/api/physician/triage/PEP-2026-002',
      {
        woundCategory: 'Category II',
        allergyNotes: 'Negative equine skin test; no known drug allergies',
        clinicalNotes: 'Cat scratch on left wrist; washed 15 mins.',
        administerDose: false
      },
      physAuth.cookie
    );
    assertCheck(
      saveNotesRes.status === 200 && saveNotesRes.body.data?.vialsDeducted === 0,
      'API 10: POST /api/physician/triage/PEP-2026-002 ("Save Notes Only" deducts 0 vials)'
    );

    // Log Clarissa's Day 0 dose via /api/physician/log-dose/PEP-2026-002
    const logDoseRes = await requestJson(
      'POST',
      '/api/physician/log-dose/PEP-2026-002',
      {
        doseDay: 'Day 0',
        vaccineType: 'anti-rabies'
      },
      physAuth.cookie
    );
    const clarissaAfter = logDoseRes.body.data?.patientRecord;
    const scheduleDays = (clarissaAfter?.pepSchedule || []).map((d) => d.doseDay);
    const day0Obj = (clarissaAfter?.pepSchedule || []).find((d) => d.doseDay === 'Day 0');

    assertCheck(
      logDoseRes.status === 200 && clarissaAfter?.clinicalStatus === 'Under Treatment',
      'API 11: POST /api/physician/log-dose/PEP-2026-002 transitions Clarissa from Pending to Under Treatment'
    );

    assertCheck(
      scheduleDays.length === 5 &&
        ['Day 0', 'Day 3', 'Day 7', 'Day 14', 'Day 28'].every((d) => scheduleDays.includes(d)) &&
        day0Obj?.status === 'Fulfilled',
      'Clarissa (PEP-2026-002) Day 0, 3, 7, 14, 28 schedule populated & Day 0 marked Fulfilled'
    );

    const batchesAfterRes = await requestJson('GET', '/api/physician/batches', null, physAuth.cookie);
    const rabiesAfter = (batchesAfterRes.body.data?.inventory || [])
      .filter((i) => i.vaccineType === 'anti-rabies')
      .reduce((sum, i) => sum + Number(i.currentStock || 0), 0);
    assertCheck(
      rabiesAfter === rabiesBefore - 1,
      `Inventory anti-rabies vial count decremented by 1 (${rabiesBefore} -> ${rabiesAfter})`
    );

    // RBAC 403 check for Physician
    const physForbiddenRestock = await requestJson(
      'POST',
      '/api/admin/inventory/restock',
      {
        vaccineType: 'ERIG',
        brandName: 'Equirab',
        batchNumber: 'EQB-2026-R309',
        vialsAdded: 10,
        expirationDate: '2027-05-10'
      },
      physAuth.cookie
    );
    assertCheck(
      physForbiddenRestock.status === 403,
      'RBAC Boundary: Physician blocked from SuperAdmin Restock API with HTTP 403 Forbidden'
    );

    // 5. SuperAdmin Login & Endpoints
    const adminAuth = await loginAsRole('admin@drpauclinic.ph', 'Admin@12345');
    assertCheck(adminAuth.step2.status === 200, 'SuperAdmin 2FA login completed');

    const overviewRes = await requestJson('GET', '/api/admin/overview', null, adminAuth.cookie);
    assertCheck(overviewRes.status === 200, 'API 12: GET /api/admin/overview');

    const restockRes = await requestJson(
      'POST',
      '/api/admin/inventory/restock',
      {
        vaccineType: 'anti-rabies',
        brandName: 'Verorab (Purified Vero Cell Rabies Vaccine)',
        batchNumber: 'VRB-2026-A104',
        vialsAdded: 1,
        lowStockThreshold: 15,
        expirationDate: '2027-06-30'
      },
      adminAuth.cookie
    );
    assertCheck(
      restockRes.status === 200 || restockRes.status === 201,
      'API 13: POST /api/admin/inventory/restock'
    );

    const forecastRecalcRes = await requestJson(
      'POST',
      '/api/admin/forecast/recalculate',
      {},
      adminAuth.cookie
    );
    assertCheck(
      forecastRecalcRes.status === 200 &&
        Array.isArray(forecastRecalcRes.body.data?.vialForecasts),
      'API 14: POST /api/admin/forecast/recalculate updates 30-day demand forecast live'
    );

    const createStaffRes = await requestJson(
      'POST',
      '/api/admin/staff',
      { fullName: 'Test Nurse', email: 'test.nurse@drpauclinic.ph', password: 'Nurse@12345', role: 'Receptionist' },
      adminAuth.cookie
    );
    const newStaffId = createStaffRes.body.data?.staffMember?.userId;
    const updateStaffRes = await requestJson(
      'PUT',
      `/api/admin/staff/${newStaffId}`,
      { fullName: 'Test Nurse Updated', email: 'test.nurse@drpauclinic.ph', password: '', role: 'Physician' },
      adminAuth.cookie
    );
    assertCheck(
      createStaffRes.status === 201 &&
        updateStaffRes.status === 200 &&
        updateStaffRes.body.data?.staffMember?.role === 'Physician',
      'Staff CRUD: POST then PUT /api/admin/staff/:id updates name and role'
    );

    const forbiddenStaffUpdate = await requestJson(
      'PUT',
      `/api/admin/staff/${newStaffId}`,
      { fullName: 'X', email: 'x@drpauclinic.ph', role: 'Physician' },
      physAuth.cookie
    );
    const deleteStaffRes = await requestJson('DELETE', `/api/admin/staff/${newStaffId}`, null, adminAuth.cookie);
    const deleteAgainRes = await requestJson('DELETE', `/api/admin/staff/${newStaffId}`, null, adminAuth.cookie);
    assertCheck(
      forbiddenStaffUpdate.status === 403 && deleteStaffRes.status === 200 && deleteAgainRes.status === 404,
      'Staff CRUD: DELETE removes account, repeat returns 404, non-admin PUT blocked with 403'
    );


    const staffListRes = await requestJson('GET', '/api/admin/staff', null, adminAuth.cookie);
    const logoutRes = await requestJson('POST', '/api/auth/logout', {}, adminAuth.cookie);
    assertCheck(
      staffListRes.status === 200 && logoutRes.status === 200,
      'API 15: GET /api/admin/staff & POST /api/auth/logout'
    );
  } finally {
    if (spawnedServer) {
      spawnedServer.kill();
    }
  }
}

(async () => {
  console.log('================================================================================');
  console.log(' DR. PAU ANIMAL BITE CENTER — INTERACTIVE UI & FULL-STACK TEST SUITE');
  console.log('================================================================================');

  await runStaticDomAndInteractionAudit();
  await runLiveApiAndClinicalSimulation();

  console.log('\n================================================================================');
  console.log(` INTERACTIVE UI & API SUMMARY: ${passCount} PASSED | ${failCount} FAILED`);
  console.log('================================================================================\n');

  process.exit(failCount > 0 ? 1 : 0);
})();

