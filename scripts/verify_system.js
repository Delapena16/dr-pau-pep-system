require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const mongoose = require('mongoose');

const connectToDatabase = require('../config/db');
const Patient = require('../models/Patient');
const Inventory = require('../models/Inventory');
const InventoryForecast = require('../models/InventoryForecast');

const BASE_URL = `http://localhost:${process.env.PORT || 5000}`;
const MFA_LOG_PATH = path.join(__dirname, '..', 'logs', 'mfa_dispatch.log');

let passedAssertions = 0;
let failedAssertions = 0;

function assertCheck(condition, description, detail = '') {
  if (condition) {
    passedAssertions += 1;
    console.log(`  [PASS] ${description}`);
  } else {
    failedAssertions += 1;
    console.error(`  [FAIL] ${description}${detail ? ` — ${detail}` : ''}`);
  }
}

function httpRequest(method, urlPath, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlPath, BASE_URL);
    const headers = {
      'Content-Type': 'application/json'
    };
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
          resolve({ status: res.statusCode, data: json, headers: res.headers });
        });
      }
    );

    req.on('error', (err) => reject(err));
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function ensureServerRunning() {
  try {
    const health = await httpRequest('GET', '/api/health');
    if (health.status === 200) {
      return null;
    }
  } catch (err) {
    // start server below
  }

  const serverProc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'ignore'
  });

  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const health = await httpRequest('GET', '/api/health');
      if (health.status === 200) {
        return serverProc;
      }
    } catch (e) {
      // wait for server
    }
  }
  throw new Error('Server failed to start on port 5000.');
}

function extractLatestOtpForEmail(email) {
  const lines = fs.readFileSync(MFA_LOG_PATH, 'utf-8').trim().split(/\r?\n/);
  const escapedEmail = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`6-Digit OTP for ${escapedEmail} \\([^)]+\\): (\\d{6})`);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = lines[i].match(regex);
    if (match) {
      return match[1];
    }
  }
  throw new Error(`Could not find 6-digit OTP for ${email}`);
}

async function authenticateStaffRole(email, password, expectedRole) {
  const step1 = await httpRequest('POST', '/api/auth/login', { email, password });
  const step1Payload = step1.data && step1.data.data ? step1.data.data : {};
  assertCheck(
    step1.status === 200 && step1Payload.mfaRequired === true,
    `Auth Step 1 for ${expectedRole} (${email})`
  );

  const otpCode = extractLatestOtpForEmail(email);
  const step2 = await httpRequest('POST', '/api/auth/verify-mfa', { email, otpCode });
  const step2Payload = step2.data && step2.data.data ? step2.data.data : {};
  assertCheck(
    step2.status === 200 &&
      Boolean(step2Payload.token) &&
      step2Payload.user &&
      step2Payload.user.role === expectedRole,
    `Auth Step 2 (6-Digit OTP) for ${expectedRole}`
  );

  return step2Payload.token;
}

async function runVerificationSuite() {
  let spawnedServer = null;

  try {
    spawnedServer = await ensureServerRunning();
    await connectToDatabase();

    const patients = await Patient.find({}).lean();
    assertCheck(patients.length >= 10, `MongoDB has >= 10 patients (${patients.length})`);

    const inventoryBatches = await Inventory.find({}).lean();
    const distinctTypes = new Set(inventoryBatches.map((b) => b.vaccineType));
    assertCheck(
      distinctTypes.has('anti-rabies') &&
        distinctTypes.has('anti-tetanus') &&
        distinctTypes.has('ERIG'),
      'Inventory has all 3 vaccine types'
    );

    const forecastDocs = await InventoryForecast.find({}).lean();
    assertCheck(
      forecastDocs.length >= 1 &&
        Array.isArray(forecastDocs[0].vialForecasts) &&
        forecastDocs[0].vialForecasts.length === 3,
      'MongoDB inventory_forecasts collection is populated'
    );

    const receptionistToken = await authenticateStaffRole(
      'receptionist@drpauclinic.ph',
      'Reception@12345',
      'Receptionist'
    );
    const physicianToken = await authenticateStaffRole(
      'physician@drpauclinic.ph',
      'Physician@12345',
      'Physician'
    );
    const adminToken = await authenticateStaffRole(
      'admin@drpauclinic.ph',
      'Admin@12345',
      'SuperAdmin'
    );

    const walkInRes = await httpRequest(
      'POST',
      '/api/receptionist/patients',
      {
        fullName: 'Teodoro Villanueva Jr.',
        age: 31,
        sex: 'Male',
        contactNumber: '09178824410',
        purok: 'Purok 3, Kapitan Pepe',
        barangay: 'Brgy. Kapitan Pepe',
        animalType: 'Dog',
        biteSite: 'Right forearm',
        day0WalkInDate: '2026-10-17',
        consentGiven: true
      },
      receptionistToken
    );
    assertCheck(walkInRes.status === 200, 'Receptionist walk-in registration succeeds');

    const createdPatient =
      walkInRes.data && walkInRes.data.data ? walkInRes.data.data.patientRecord : null;
    const testPatientId = createdPatient ? createdPatient._id : null;

    const recTriageRes = await httpRequest(
      'POST',
      `/api/physician/patients/${testPatientId}/assess`,
      { woundCategory: 'Category II', administerDose: true },
      receptionistToken
    );
    assertCheck(recTriageRes.status === 403, 'Receptionist blocked from Physician triage (403)');

    const phyTriageRes = await httpRequest(
      'POST',
      `/api/physician/patients/${testPatientId}/assess`,
      {
        woundCategory: 'Category II',
        allergyNotes: 'Negative equine skin test',
        clinicalNotes: 'Cleaned wound and gave Day 0 dose.',
        administerDose: true,
        doseDay: 'Day 0',
        vaccineType: 'anti-rabies'
      },
      physicianToken
    );
    assertCheck(phyTriageRes.status === 200, 'Physician triage & dose administration succeeds');

    const phyRestockRes = await httpRequest(
      'POST',
      '/api/admin/inventory',
      {
        vaccineType: 'anti-rabies',
        brandName: 'Verorab',
        batchNumber: 'VRB-2026-A104',
        vialsAdded: 1,
        expirationDate: '2027-06-30'
      },
      physicianToken
    );
    assertCheck(phyRestockRes.status === 403, 'Physician blocked from Inventory restock (403)');

    const deductedBatch =
      phyTriageRes.data && phyTriageRes.data.data && phyTriageRes.data.data.batchNumber
        ? phyTriageRes.data.data.batchNumber
        : 'VRB-2026-A104';

    const adminRestockRes = await httpRequest(
      'POST',
      '/api/admin/inventory',
      {
        vaccineType: 'anti-rabies',
        brandName: 'Verorab (Purified Vero Cell Rabies Vaccine)',
        batchNumber: deductedBatch,
        vialsAdded: 1,
        expirationDate: '2027-06-30'
      },
      adminToken
    );
    assertCheck(
      adminRestockRes.status === 200 || adminRestockRes.status === 201,
      'SuperAdmin restock succeeds'
    );

    if (testPatientId) {
      await Patient.findByIdAndDelete(testPatientId);
    }

    console.log(`\nVerification Summary: ${passedAssertions} passed, ${failedAssertions} failed`);
    if (failedAssertions > 0) {
      process.exitCode = 1;
    }
  } finally {
    await mongoose.disconnect();
    if (spawnedServer) {
      spawnedServer.kill();
    }
  }
}

runVerificationSuite();
