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
  console.log(' DR. PAU PEP MANAGEMENT SYSTEM — DEFENSE PATCH VERIFICATION');
  console.log('================================================================================\n');

  try {
    // 1. Receptionist Login & Sequential Dosing Test
    const recepAuth = await loginAsRole('receptionist@drpauclinic.ph', 'Reception@12345');
    assertCheck(recepAuth.step2?.status === 200, 'Receptionist logged in successfully via 2FA');

    // Register a new test patient
    const testPatientName = `Defense Patient ${Date.now()}`;
    const registerRes = await requestJson(
      'POST',
      '/api/receptionist/patients',
      {
        fullName: testPatientName,
        age: 32,
        sex: 'Female',
        contactNumber: '09181234567',
        purok: 'Purok 2, Kapitan Pepe',
        day0WalkInDate: '2026-10-19',
        animalType: 'Domestic Dog',
        biteSite: 'Right Forearm',
        consentGiven: true
      },
      recepAuth.cookie
    );
    assertCheck(registerRes.status === 200 || registerRes.status === 201, 'POST /api/receptionist/patients registers walk-in');
    const patientId = registerRes.body.data?.patientRecord?.patientId || registerRes.body.data?.patient?.patientId;
    assertCheck(Boolean(patientId), `New patient assigned ID: ${patientId}`);

    // Physician Login
    const physAuth = await loginAsRole('physician@drpauclinic.ph', 'Physician@12345');
    assertCheck(physAuth.step2?.status === 200, 'Physician logged in successfully via 2FA');

    // Physician Triage as Category II (populates schedule with +0, 3, 7, 14, 28 days)
    const triageRes = await requestJson(
      'POST',
      `/api/physician/triage/${patientId}`,
      {
        woundCategory: 'Category II',
        allergyNotes: 'No known allergies',
        clinicalNotes: 'Minor scratch, superficial',
        administerDose: false
      },
      physAuth.cookie
    );
    assertCheck(triageRes.status === 200, 'POST /api/physician/triage sets Category II');
    const schedule = triageRes.body.data?.patientRecord?.pepSchedule || triageRes.body.data?.patient?.pepSchedule || [];
    assertCheck(schedule.length === 5, '5-dose PEP schedule generated');

    // Verify date math: 0, 3, 7, 14, 28 days
    const d0 = new Date(schedule[0].scheduledDate);
    const d1 = new Date(schedule[1].scheduledDate);
    const d2 = new Date(schedule[2].scheduledDate);
    const d3 = new Date(schedule[3].scheduledDate);
    const d4 = new Date(schedule[4].scheduledDate);

    const diffDays = (a, b) => Math.round((b - a) / (1000 * 60 * 60 * 24));
    assertCheck(
      diffDays(d0, d1) === 3 &&
      diffDays(d0, d2) === 7 &&
      diffDays(d0, d3) === 14 &&
      diffDays(d0, d4) === 28,
      'PEP Schedule standard JS Date math verified (+0, +3, +7, +14, +28 days)'
    );

    // Sequential Dosing Test: Attempt to log Day 3 BEFORE Day 0 is fulfilled -> MUST return 400
    const outOfOrderRes = await requestJson(
      'POST',
      `/api/physician/log-dose/${patientId}`,
      {
        doseDay: 'Day 3',
        vaccineType: 'anti-rabies'
      },
      physAuth.cookie
    );
    assertCheck(
      outOfOrderRes.status === 400 && outOfOrderRes.body.message.includes('Sequential Dosing Violation'),
      'Enforce Sequential Dosing: Logging Day 3 before Day 0 returns 400 Sequential Dosing Violation'
    );

    // Scheduled dose PATCH route also enforces sequential dosing
    const outOfOrderPatchRes = await requestJson(
      'PATCH',
      `/api/physician/patients/${patientId}/schedule`,
      {
        doseDay: 'Day 7',
        doseAdministered: true,
        vaccineType: 'anti-rabies'
      },
      physAuth.cookie
    );
    assertCheck(
      outOfOrderPatchRes.status === 400 && outOfOrderPatchRes.body.message.includes('Sequential Dosing Violation'),
      'Enforce Sequential Dosing (PATCH /schedule): Logging Day 7 before Day 0 returns 400'
    );

    // Log Day 0 in proper sequence -> MUST succeed
    const validDoseRes = await requestJson(
      'POST',
      `/api/physician/log-dose/${patientId}`,
      {
        doseDay: 'Day 0',
        vaccineType: 'anti-rabies'
      },
      physAuth.cookie
    );
    assertCheck(
      validDoseRes.status === 200,
      'Logging Day 0 in sequence succeeds with 200 OK'
    );

    // Category I Logic Test: Create another patient, triage as Category I
    const cat1PatientName = `Cat1 Test ${Date.now()}`;
    const regCat1Res = await requestJson(
      'POST',
      '/api/receptionist/patients',
      {
        fullName: cat1PatientName,
        age: 22,
        sex: 'Male',
        contactNumber: '09191234567',
        purok: 'Purok 1, Kapitan Pepe',
        day0WalkInDate: '2026-10-19',
        animalType: 'Cat',
        biteSite: 'Intact skin',
        consentGiven: true
      },
      recepAuth.cookie
    );
    const cat1Id = regCat1Res.body.data?.patientRecord?.patientId || regCat1Res.body.data?.patient?.patientId;

    const cat1TriageRes = await requestJson(
      'POST',
      `/api/physician/triage/${cat1Id}`,
      {
        woundCategory: 'Category I',
        allergyNotes: 'None',
        clinicalNotes: 'Intact skin contact with saliva; thorough wash for 15 mins',
        administerDose: false
      },
      physAuth.cookie
    );
    const cat1Patient = cat1TriageRes.body.data?.patientRecord || cat1TriageRes.body.data?.patient;
    assertCheck(
      cat1TriageRes.status === 200 &&
      cat1Patient?.clinicalStatus === 'Wound Cleansing Only' &&
      (!cat1Patient?.pepSchedule || cat1Patient.pepSchedule.length === 0),
      'Category I Logic: Sets clinicalStatus = "Wound Cleansing Only", schedule empty/cleared'
    );

    // SuperAdmin Login for Demographics & Staff IAM Toggle tests
    const adminAuth = await loginAsRole('admin@drpauclinic.ph', 'Admin@12345');
    assertCheck(adminAuth.step2?.status === 200, 'SuperAdmin logged in successfully via 2FA');

    // Clerical Demographic Update route (PUT /api/patients/demographics/:id)
    const updateDemoRes = await requestJson(
      'PUT',
      `/api/patients/demographics/${patientId}`,
      {
        fullName: 'Defense Patient Updated Name',
        contactNumber: '09189998877',
        purok: 'Purok 5, Kapitan Pepe',
        // Attempt to tamper with medical fields:
        woundCategory: 'Category I',
        clinicalStatus: 'Discharged'
      },
      adminAuth.cookie
    );
    assertCheck(
      updateDemoRes.status === 200,
      'PUT /api/patients/demographics/:id updates clerical demographic data'
    );
    const updatedPatient = updateDemoRes.body.data?.patient;
    assertCheck(
      updatedPatient.fullName === 'Defense Patient Updated Name' &&
      updatedPatient.contactNumber === '09189998877' &&
      updatedPatient.purok === 'Purok 5, Kapitan Pepe',
      'Demographic fields (fullName, contactNumber, purok) successfully updated'
    );
    assertCheck(
      updatedPatient.woundCategory === 'Category II',
      'Medical data integrity preserved: woundCategory NOT modified by demographics route'
    );

    // Staff IAM Toggle: Create a staff account, toggle status to Deactivated
    const testStaffEmail = `staff.test.${Date.now()}@drpauclinic.ph`;
    const createStaffRes = await requestJson(
      'POST',
      '/api/admin/staff',
      {
        fullName: 'Test Staff IAM',
        email: testStaffEmail,
        password: 'Password@12345',
        role: 'Receptionist'
      },
      adminAuth.cookie
    );
    assertCheck(createStaffRes.status === 201, 'Created new staff user for IAM toggle test');
    const testStaffUserId = createStaffRes.body.data?.staffMember?.userId;

    // Toggle status to inactive (PATCH /api/staff/:id/toggle-status)
    const toggleRes = await requestJson(
      'PATCH',
      `/api/staff/${testStaffUserId}/toggle-status`,
      {},
      adminAuth.cookie
    );
    assertCheck(
      toggleRes.status === 200 && toggleRes.body.data?.isActive === false,
      'PATCH /api/staff/:id/toggle-status toggles isActive to false (Deactivated)'
    );

    // Attempt to log in with the deactivated account -> MUST return 403 Forbidden
    const deactivatedLogin = await requestJson(
      'POST',
      '/api/auth/login',
      {
        email: testStaffEmail,
        password: 'Password@12345'
      }
    );
    assertCheck(
      deactivatedLogin.status === 403 && deactivatedLogin.body.message.includes('deactivated'),
      'Deactivated staff login rejected with HTTP 403 Forbidden'
    );

    // Reactivate account
    const reactivateRes = await requestJson(
      'PATCH',
      `/api/staff/${testStaffUserId}/toggle-status`,
      {},
      adminAuth.cookie
    );
    assertCheck(
      reactivateRes.status === 200 && reactivateRes.body.data?.isActive === true,
      'PATCH /api/staff/:id/toggle-status reactivates account (isActive: true)'
    );

    // Now login should succeed to step 1
    const reactivatedLogin = await requestJson(
      'POST',
      '/api/auth/login',
      {
        email: testStaffEmail,
        password: 'Password@12345'
      }
    );
    assertCheck(
      reactivatedLogin.status === 200,
      'Reactivated staff can proceed to 2FA login (HTTP 200)'
    );

    // Clean up test staff
    await requestJson('DELETE', `/api/admin/staff/${testStaffUserId}`, null, adminAuth.cookie);

  } catch (err) {
    console.error('Test script encountered an error:', err);
    failCount += 1;
  }

  console.log('\n================================================================================');
  console.log(` DEFENSE PATCH VERIFICATION SUMMARY: ${passCount} PASSED | ${failCount} FAILED`);
  console.log('================================================================================\n');

  process.exit(failCount > 0 ? 1 : 0);
})();
