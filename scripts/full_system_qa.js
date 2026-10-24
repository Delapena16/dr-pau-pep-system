require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const mongoose = require('mongoose');

const connectToDatabase = require('../config/db');
const Patient = require('../models/Patient');
const Inventory = require('../models/Inventory');

const ROOT_DIR = path.join(__dirname, '..');
const BASE_URL = `http://localhost:${process.env.PORT || 5000}`;
const MFA_LOG_PATH = path.join(ROOT_DIR, 'logs', 'mfa_dispatch.log');

let passedCount = 0;
let failedCount = 0;

function assertQa(condition, label, detail = '') {
  if (condition) {
    passedCount += 1;
    console.log(`  [PASS] ${label}`);
  } else {
    failedCount += 1;
    console.error(`  [FAIL] ${label}${detail ? ` -> ${detail}` : ''}`);
  }
}

function httpRequest(method, urlPath, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlPath, BASE_URL);
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const payload = body ? JSON.stringify(body) : null;
    if (payload) {
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch (e) {
            json = { raw };
          }
          resolve({ status: res.statusCode, data: json });
        });
      }
    );

    req.on('error', (err) => reject(err));
    if (payload) req.write(payload);
    req.end();
  });
}

async function ensureServerOnline() {
  try {
    const health = await httpRequest('GET', '/api/health');
    if (health.status === 200) {
      return null;
    }
  } catch (e) {
    // start server below
  }

  console.log('[INFO] Starting server.js for full-stack QA...');
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT_DIR,
    stdio: 'ignore'
  });

  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const health = await httpRequest('GET', '/api/health');
      if (health.status === 200) {
        return proc;
      }
    } catch (e) {
      // wait until listening
    }
  }
  throw new Error('Server did not start on port 5000 within 30s.');
}

function getLatestOtp(email) {
  const lines = fs.readFileSync(MFA_LOG_PATH, 'utf-8').trim().split(/\r?\n/);
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`6-Digit OTP for ${escaped} \\([^)]+\\): (\\d{6})`);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = lines[i].match(re);
    if (m) return m[1];
  }
  throw new Error(`No 6-digit OTP found for ${email}`);
}

async function loginRole(email, password, expectedRole) {
  const s1 = await httpRequest('POST', '/api/auth/login', { email, password });
  const p1 = s1.data && s1.data.data ? s1.data.data : {};
  assertQa(
    s1.status === 200 && p1.mfaRequired === true,
    `${expectedRole} Login Step 1 (Password + 6-digit OTP dispatch)`
  );

  const otpCode = getLatestOtp(email);
  const s2 = await httpRequest('POST', '/api/auth/verify-mfa', { email, otpCode });
  const p2 = s2.data && s2.data.data ? s2.data.data : {};
  assertQa(
    s2.status === 200 && Boolean(p2.token) && p2.user && p2.user.role === expectedRole,
    `${expectedRole} Login Step 2 (OTP verified & JWT issued)`
  );

  return p2.token;
}

function collectProjectSourceFiles(dirPath, fileList = []) {
  const skipDirs = new Set(['node_modules', '.git', 'logs']);
  const allowedExts = new Set(['.js', '.html', '.css', '.py', '.json']);

  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectProjectSourceFiles(fullPath, fileList);
    } else if (
      allowedExts.has(path.extname(entry.name)) ||
      entry.name === '.env.example'
    ) {
      if (entry.name !== 'package-lock.json') {
        fileList.push(fullPath);
      }
    }
  }
  return fileList;
}

async function runFullSystemQa() {
  console.log('================================================================================');
  console.log(' DR. PAU ANIMAL BITE CENTER — FULL-STACK & DOM/UX QA SUITE');
  console.log('================================================================================');

  let spawnedServer = null;

  try {
    // ------------------------------------------------------------------------
    // PART 1: STATIC CODE, DOM WIRING & STEALTH AUDIT
    // ------------------------------------------------------------------------
    console.log('\n[PART 1] STATIC CODE, DOM WIRING & STEALTH CHECK');

    const htmlPath = path.join(ROOT_DIR, 'public', 'index.html');
    const jsPath = path.join(ROOT_DIR, 'public', 'js', 'app.js');
    const htmlSource = fs.readFileSync(htmlPath, 'utf-8');
    const jsSource = fs.readFileSync(jsPath, 'utf-8');

    // 1A. Collect all id="..." attributes in public/index.html
    const htmlIds = new Set();
    const idRegex = /\bid=["']([^"']+)["']/g;
    let idMatch;
    while ((idMatch = idRegex.exec(htmlSource)) !== null) {
      htmlIds.add(idMatch[1]);
    }

    // Collect all document.getElementById('...') calls in public/js/app.js
    const jsGetByIdRegex = /document\.getElementById\(\s*['"]([^'"]+)['"]\s*\)/g;
    const missingDomIds = [];
    const checkedDomIds = new Set();
    let jsIdMatch;
    while ((jsIdMatch = jsGetByIdRegex.exec(jsSource)) !== null) {
      const targetId = jsIdMatch[1];
      checkedDomIds.add(targetId);
      if (!htmlIds.has(targetId)) {
        missingDomIds.push(targetId);
      }
    }

    assertQa(
      missingDomIds.length === 0 && checkedDomIds.size > 0,
      `Zero unmatched getElementById calls across ${checkedDomIds.size} referenced DOM IDs`,
      missingDomIds.length ? `Missing IDs: ${missingDomIds.join(', ')}` : ''
    );

    // 1B. Verify all onclick="fnName(...)" handlers have window.fnName defined in app.js
    const onclickRegex = /\bonclick=["']([a-zA-Z0-9_]+)\s*\(/g;
    const referencedOnclicks = new Set();
    let onclickMatch;
    while ((onclickMatch = onclickRegex.exec(htmlSource + '\n' + jsSource)) !== null) {
      referencedOnclicks.add(onclickMatch[1]);
    }

    const deadOnclicks = [];
    for (const fnName of referencedOnclicks) {
      const windowDefRegex = new RegExp(`window\\.${fnName}\\s*=\\s*(?:async\\s+)?function`);
      if (!windowDefRegex.test(jsSource)) {
        deadOnclicks.push(fnName);
      }
    }

    assertQa(
      deadOnclicks.length === 0 && referencedOnclicks.size > 0,
      `Zero dead onclick handlers across ${referencedOnclicks.size} interactive table actions`,
      deadOnclicks.length ? `Missing handlers: ${deadOnclicks.join(', ')}` : ''
    );

    // 1C. Verify UX elements: workflow guide bar, reset buttons, filter pills, WHO hints, forecast recalculate button
    const requiredDomIds = [
      'roleWorkflowGuideBar',
      'resetWalkInFormBtn',
      'resetPhysTriageFormBtn',
      'resetRestockFormBtn',
      'resetStaffFormBtn',
      'physCategoryClinicalHint',
      'refreshForecastBtn',
      'recQueueFilterTabs',
      'recFollowUpFilterTabs',
      'physTriageFilterTabs',
      'physRecordsFilterTabs',
      'adminRegistryFilterTabs'
    ];
    const missingRequiredControls = requiredDomIds.filter((id) => !htmlIds.has(id));
    assertQa(
      missingRequiredControls.length === 0,
      'All required UX controls (workflow guide bar, form reset buttons, filter pills, WHO hint, forecast refresh) exist in DOM',
      missingRequiredControls.join(', ')
    );

    // 1D. Scan all project files for forbidden AI/template strings
    const bannedPatterns = [
      ['Lo', 'rem'].join(''),
      ['Sep 1,', ' 2023'].join(''),
      ['Modules', ' 05'].join(''),
      ['SHA-', '256'].join(''),
      ['pyspark_inventory_', 'forecast.py'].join(''),
      ['LOC', 'KED'].join('')
    ];

    const allFiles = collectProjectSourceFiles(ROOT_DIR);
    for (const term of bannedPatterns) {
      const matchedFiles = [];
      for (const filePath of allFiles) {
        const content = fs.readFileSync(filePath, 'utf-8');
        if (content.includes(term)) {
          matchedFiles.push(path.relative(ROOT_DIR, filePath));
        }
      }
      assertQa(
        matchedFiles.length === 0,
        `Zero occurrences of forbidden string "${term}" across ${allFiles.length} project files`,
        matchedFiles.length ? `Found in: ${matchedFiles.join(', ')}` : ''
      );
    }

    // ------------------------------------------------------------------------
    // PART 2: END-TO-END CLINICAL SIMULATION & RBAC / EDGE-CASE VERIFICATION
    // ------------------------------------------------------------------------
    console.log('\n[PART 2] END-TO-END CLINICAL SIMULATION (RECEPTIONIST -> PHYSICIAN -> SUPERADMIN)');

    spawnedServer = await ensureServerOnline();
    await connectToDatabase();

    // 2A. Receptionist Flow
    const receptionistToken = await loginRole(
      'receptionist@drpauclinic.ph',
      'Reception@12345',
      'Receptionist'
    );

    // Edge-case test: negative age rejected
    const badAgeRes = await httpRequest(
      'POST',
      '/api/receptionist/patients',
      {
        fullName: 'Invalid Age Test',
        age: -5,
        sex: 'Male',
        contactNumber: '09178841209',
        purok: 'Purok 4, Kapitan Pepe',
        barangay: 'Brgy. Kapitan Pepe',
        animalType: 'Dog',
        biteSite: 'Left Hand',
        consentGiven: true
      },
      receptionistToken
    );
    assertQa(
      badAgeRes.status === 400,
      'Edge-Case Validation: Negative age (-5) rejected with HTTP 400'
    );

    // Edge-case test: invalid phone number rejected
    const badPhoneRes = await httpRequest(
      'POST',
      '/api/receptionist/patients',
      {
        fullName: 'Invalid Phone Test',
        age: 26,
        sex: 'Female',
        contactNumber: '12345',
        purok: 'Purok 4, Kapitan Pepe',
        barangay: 'Brgy. Kapitan Pepe',
        animalType: 'Cat',
        biteSite: 'Right Wrist',
        consentGiven: true
      },
      receptionistToken
    );
    assertQa(
      badPhoneRes.status === 400,
      'Edge-Case Validation: Invalid mobile number ("12345") rejected with HTTP 400'
    );

    // Valid Walk-In Registration from Purok 4, Kapitan Pepe
    const walkInRes = await httpRequest(
      'POST',
      '/api/receptionist/patients',
      {
        fullName: 'Gabrielito Mercado',
        age: 27,
        sex: 'Male',
        contactNumber: '09178841209',
        purok: 'Purok 4, Kapitan Pepe',
        barangay: 'Brgy. Kapitan Pepe',
        animalType: 'Stray Dog',
        biteSite: 'Right Ankle',
        biteStatus: 'Unprovoked stray dog bite in Purok 4',
        day0WalkInDate: '2026-10-17',
        consentGiven: true
      },
      receptionistToken
    );

    const walkInPatient =
      walkInRes.data && walkInRes.data.data ? walkInRes.data.data.patientRecord : null;
    assertQa(
      walkInRes.status === 200 &&
        walkInPatient &&
        walkInPatient.purok.includes('Purok 4') &&
        walkInPatient.clinicalStatus === 'Waiting for Doctor',
      'Receptionist registers new walk-in patient from Purok 4, Kapitan Pepe'
    );

    const queueCheckRes = await httpRequest(
      'GET',
      '/api/receptionist/patients?query=Gabrielito',
      null,
      receptionistToken
    );
    const queueList =
      queueCheckRes.data && queueCheckRes.data.data ? queueCheckRes.data.data.patients : [];
    assertQa(
      queueCheckRes.status === 200 &&
        queueList.some((p) => p.patientId === walkInPatient.patientId),
      'New walk-in patient immediately appears in the waiting queue'
    );

    // Receptionist attempts Physician Triage API -> 403 Forbidden
    const recForbiddenTriage = await httpRequest(
      'POST',
      `/api/physician/patients/${walkInPatient.patientId}/assess`,
      { woundCategory: 'Category III', administerDose: true },
      receptionistToken
    );
    assertQa(
      recForbiddenTriage.status === 403,
      'RBAC Isolation: Receptionist blocked from Physician Triage API with HTTP 403 Forbidden'
    );

    // 2B. Physician Flow
    const physicianToken = await loginRole(
      'physician@drpauclinic.ph',
      'Physician@12345',
      'Physician'
    );

    const initialRabiesBatches = await Inventory.find({ vaccineType: 'anti-rabies' }).lean();
    const initialRabiesStock = initialRabiesBatches.reduce(
      (sum, b) => sum + Number(b.currentStock || 0),
      0
    );

    // Fetch waiting patient as Physician
    const physQueueRes = await httpRequest(
      'GET',
      '/api/physician/patients',
      null,
      physicianToken
    );
    const physPatients =
      physQueueRes.data && physQueueRes.data.data ? physQueueRes.data.data.patients : [];
    const targetWaitingPatient = physPatients.find(
      (p) => p.patientId === walkInPatient.patientId
    );
    assertQa(
      Boolean(targetWaitingPatient),
      'Physician fetches waiting patient from Doctor Triage Queue'
    );

    // Submit WHO Category III triage + administer Day 0 dose
    const triageSubmitRes = await httpRequest(
      'POST',
      `/api/physician/patients/${walkInPatient.patientId}/assess`,
      {
        woundCategory: 'Category III',
        allergyNotes: 'Negative equine skin test (0.1 mL ID)',
        clinicalNotes: 'Transdermal bite on right ankle; infiltrated ERIG and gave Day 0 PVRV.',
        administerDose: true,
        doseDay: 'Day 0',
        vaccineType: 'anti-rabies'
      },
      physicianToken
    );

    const triagedPayload =
      triageSubmitRes.data && triageSubmitRes.data.data ? triageSubmitRes.data.data : {};
    const updatedSchedule = triagedPayload.patientRecord
      ? triagedPayload.patientRecord.pepSchedule
      : [];
    const expectedDays = ['Day 0', 'Day 3', 'Day 7', 'Day 14', 'Day 28'];
    const hasAllFiveDays =
      updatedSchedule.length === 5 &&
      expectedDays.every((d, idx) => updatedSchedule[idx].doseDay === d);

    assertQa(
      triageSubmitRes.status === 200 &&
        triagedPayload.patientRecord.woundCategory === 'Category III' &&
        hasAllFiveDays &&
        updatedSchedule[0].status === 'Fulfilled',
      'Physician submits WHO Category III triage + Day 0 dose; Days 0, 3, 7, 14, 28 generated'
    );

    const afterRabiesBatches = await Inventory.find({ vaccineType: 'anti-rabies' }).lean();
    const afterRabiesStock = afterRabiesBatches.reduce(
      (sum, b) => sum + Number(b.currentStock || 0),
      0
    );
    assertQa(
      afterRabiesStock === initialRabiesStock - 1,
      `Inventory anti-rabies stock decremented accurately (${initialRabiesStock} -> ${afterRabiesStock})`
    );

    // Edge-case test: Prevent double-clicking / re-deducting already completed Day 0 dose
    const doubleDoseRes = await httpRequest(
      'PATCH',
      `/api/physician/patients/${walkInPatient.patientId}/schedule`,
      {
        doseDay: 'Day 0',
        doseAdministered: true,
        vaccineType: 'anti-rabies'
      },
      physicianToken
    );
    assertQa(
      doubleDoseRes.status === 400,
      'Edge-Case Validation: Re-deducting completed Day 0 dose blocked with HTTP 400'
    );

    // Physician attempts Inventory Restock -> 403 Forbidden
    const physForbiddenRestock = await httpRequest(
      'POST',
      '/api/admin/inventory',
      {
        vaccineType: 'anti-tetanus',
        brandName: 'Tetavax',
        batchNumber: 'TTX-2026-B204',
        vialsAdded: 25,
        expirationDate: '2027-03-20'
      },
      physicianToken
    );
    assertQa(
      physForbiddenRestock.status === 403,
      'RBAC Isolation: Physician blocked from Inventory Restock API with HTTP 403 Forbidden'
    );

    // 2C. SuperAdmin Flow
    const adminToken = await loginRole('admin@drpauclinic.ph', 'Admin@12345', 'SuperAdmin');

    const beforeTetanusBatch = await Inventory.findOne({ batchNumber: 'TTX-2026-B204' }).lean();
    const initialTetanusStock = beforeTetanusBatch ? Number(beforeTetanusBatch.currentStock) : 0;

    // SuperAdmin restocks +25 vials of anti-tetanus
    const restockTetanusRes = await httpRequest(
      'POST',
      '/api/admin/inventory',
      {
        vaccineType: 'anti-tetanus',
        brandName: 'Tetavax (Adsorbed Tetanus Toxoid 0.5mL)',
        batchNumber: 'TTX-2026-B204',
        vialsAdded: 25,
        lowStockThreshold: 10,
        expirationDate: '2027-03-20'
      },
      adminToken
    );
    const restockedVial =
      restockTetanusRes.data && restockTetanusRes.data.data
        ? restockTetanusRes.data.data.vialRecord
        : null;
    assertQa(
      (restockTetanusRes.status === 200 || restockTetanusRes.status === 201) &&
        restockedVial &&
        Number(restockedVial.currentStock) === initialTetanusStock + 25,
      `SuperAdmin restocks +25 vials of anti-tetanus (${initialTetanusStock} -> ${
        restockedVial ? restockedVial.currentStock : 'N/A'
      })`
    );

    // SuperAdmin fetches 30-day/90-day Forecast and triggers live recalculation
    const forecastGetRes = await httpRequest('GET', '/api/admin/forecast', null, adminToken);
    const forecastRecalcRes = await httpRequest(
      'POST',
      '/api/admin/forecast/recalculate',
      {},
      adminToken
    );
    const forecastData =
      forecastRecalcRes.data && forecastRecalcRes.data.data
        ? forecastRecalcRes.data.data
        : {};
    assertQa(
      forecastGetRes.status === 200 &&
        forecastRecalcRes.status === 200 &&
        Array.isArray(forecastData.vialForecasts) &&
        forecastData.vialForecasts.length === 3 &&
        Array.isArray(forecastData.purokBreakdown) &&
        forecastData.purokBreakdown.length === 7,
      'SuperAdmin fetches & recalculates 30-day/90-day Forecast and Purok 1-7 surveillance data (200 OK)'
    );

    // Restore exact seed state (clean up temporary test patient and restore vial counts)
    if (walkInPatient && walkInPatient._id) {
      await Patient.findByIdAndDelete(walkInPatient._id);
    }
    const deductedBatch = triagedPayload.batchNumber || 'VRB-2026-A104';
    await Inventory.updateOne({ batchNumber: deductedBatch }, { $inc: { currentStock: 1 } });
    await Inventory.updateOne({ batchNumber: 'TTX-2026-B204' }, { $inc: { currentStock: -25 } });

    console.log('\n================================================================================');
    console.log(` FULL-STACK QA SUMMARY: ${passedCount} PASSED | ${failedCount} FAILED`);
    console.log('================================================================================');

    if (failedCount > 0) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('[FATAL QA ERROR]:', err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    if (spawnedServer) {
      spawnedServer.kill();
    }
  }
}

runFullSystemQa();
