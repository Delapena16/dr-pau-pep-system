/**
 * ============================================================================
 * FILE: controllers/receptionistController.js
 * ARCHITECTURAL LAYER: Controller Layer (Front-Desk Patient Intake & Queue)
 * ============================================================================
 * PURPOSE WITHIN MVC ARCHITECTURE:
 * Handles front-desk clinic operations assigned to the `Receptionist` role:
 *   1. `registerWalkInPatient`: Registers a new walk-in animal bite patient with
 *      a unique clinic code (`PEP-2026-XXXX`) and initial exposure complaint.
 *   2. `searchPatientRecords`: Fast indexed lookup by patient name, patientCode,
 *      phone number, or barangay.
 *   3. `getDailyAppointmentQueue`: Retrieves patients scheduled for a follow-up
 *      PEP shot (`Day 3`, `Day 7`, `Day 14`, or `Day 28`) today or overdue.
 *
 * ACADEMIC DEFENSE TALKING POINTS:
 * 1. Role Separation (Front Desk vs. Triage):
 *    The Receptionist collects demographic details and initial exposure facts
 *    (`animalType`, `biteSite`, `exposureDate`), setting `pepStatus` to
 *    `'Pending Triage'`. Only a licensed `Physician` can assign WHO Category
 *    I/II/III and prescribe vaccines or RIG.
 * 2. Indexed Search Performance:
 *    Because `fullName`, `patientCode`, `contactNumber`, and `barangay` are
 *    indexed in `Patient.js`, searching thousands of records takes milliseconds.
 * ============================================================================
 */

const Patient = require('../models/Patient');
const AuditLog = require('../models/AuditLog');

/**
 * Helper: Generates a human-readable, collision-resistant Patient Code.
 * Example output: "PEP-2026-4829"
 */
const generateUniquePatientCode = async () => {
  const currentYear = new Date().getFullYear();
  const totalPatientsCount = await Patient.countDocuments();
  const sequentialNumber = String(totalPatientsCount + 1001).padStart(4, '0');
  const randomSuffix = Math.floor(10 + Math.random() * 90);
  return `PEP-${currentYear}-${sequentialNumber}${randomSuffix}`;
};

/**
 * REGISTER WALK-IN ANIMAL BITE PATIENT
 * Route: POST /api/receptionist/patients
 */
const registerWalkInPatient = async (req, res) => {
  try {
    const {
      fullName,
      age,
      sex,
      contactNumber,
      barangay,
      city,
      exposureDate,
      animalType,
      animalOwnershipStatus,
      biteSite,
      exposureType,
      woundWashingDone,
    } = req.body;

    const generatedPatientCode = await generateUniquePatientCode();

    const newPatientRecord = await Patient.create({
      patientCode: generatedPatientCode,
      fullName: fullName.trim(),
      age: Number(age),
      sex,
      contactNumber: contactNumber.trim(),
      barangay: barangay.trim(),
      city: city ? city.trim() : 'Quezon City',
      registeredBy: req.authenticatedUser.userId,
      exposureHistory: [
        {
          walkInDate: new Date(),
          exposureDate: new Date(exposureDate),
          animalType,
          animalOwnershipStatus: animalOwnershipStatus || 'Stray / Wild',
          biteSite: biteSite.trim(),
          exposureType: exposureType || 'Bite',
          whoCategory: 'Pending Assessment',
          woundWashingDone: Boolean(woundWashingDone),
          pepStatus: 'Pending Triage',
          pepSchedule: [],
        },
      ],
    });

    // Write structured log for audit compliance and PySpark walk-in trend analysis
    await AuditLog.create({
      actorId: req.authenticatedUser.userId,
      actorRole: req.authenticatedUser.role,
      actionType: 'PATIENT_WALKIN_REGISTERED',
      targetCollection: 'Patient',
      targetDocumentId: newPatientRecord._id,
      description: `Receptionist registered walk-in patient ${newPatientRecord.fullName} (${generatedPatientCode}) from Brgy. ${newPatientRecord.barangay}.`,
      ipAddress: req.ip || '127.0.0.1',
      metadata: {
        patientCode: generatedPatientCode,
        barangay: newPatientRecord.barangay,
        animalType,
        biteSite,
      },
    });

    return res.status(201).json({
      success: true,
      message: `Walk-in patient ${newPatientRecord.fullName} registered with code ${generatedPatientCode} and queued for Physician triage.`,
      data: {
        patient: newPatientRecord,
      },
    });
  } catch (serverError) {
    console.error('[Register Walk-In Patient Error]:', serverError);
    return res.status(500).json({
      success: false,
      message: 'Failed to register walk-in patient record.',
      data: null,
    });
  }
};

/**
 * SEARCH PATIENT RECORDS BY NAME, CODE, CONTACT NUMBER, OR BARANGAY
 * Route: GET /api/receptionist/patients/search?query=...
 */
const searchPatientRecords = async (req, res) => {
  try {
    const searchKeyword = (req.query.query || '').trim();

    let mongoFilter = {};
    if (searchKeyword.length > 0) {
      // Escape special regex characters to prevent Regular Expression Denial of Service (ReDoS)
      const escapedKeyword = searchKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const caseInsensitiveRegex = new RegExp(escapedKeyword, 'i');

      mongoFilter = {
        $or: [
          { patientCode: caseInsensitiveRegex },
          { fullName: caseInsensitiveRegex },
          { contactNumber: caseInsensitiveRegex },
          { barangay: caseInsensitiveRegex },
        ],
      };
    }

    const matchingPatients = await Patient.find(mongoFilter)
      .sort({ createdAt: -1 })
      .limit(50);

    return res.status(200).json({
      success: true,
      message: `Found ${matchingPatients.length} patient record(s).`,
      data: {
        count: matchingPatients.length,
        patients: matchingPatients,
      },
    });
  } catch (serverError) {
    console.error('[Search Patient Records Error]:', serverError);
    return res.status(500).json({
      success: false,
      message: 'Failed to search patient records.',
      data: null,
    });
  }
};

/**
 * GET TODAY'S SCHEDULED PEP APPOINTMENT QUEUE & PENDING TRIAGE LIST
 * Route: GET /api/receptionist/appointments/today
 */
const getDailyAppointmentQueue = async (req, res) => {
  try {
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);

    // Find patients who are either waiting for initial triage OR have a scheduled dose due on/before today
    const queuedPatients = await Patient.find({
      $or: [
        { 'exposureHistory.pepStatus': 'Pending Triage' },
        {
          exposureHistory: {
            $elemMatch: {
              pepStatus: 'Ongoing PEP',
              pepSchedule: {
                $elemMatch: {
                  status: 'Scheduled',
                  scheduledDate: { $lte: endOfToday },
                },
              },
            },
          },
        },
      ],
    }).sort({ updatedAt: -1 });

    return res.status(200).json({
      success: true,
      message: `Retrieved ${queuedPatients.length} patient(s) in today's clinical and vaccination queue.`,
      data: {
        queueCount: queuedPatients.length,
        queuedPatients,
      },
    });
  } catch (serverError) {
    console.error('[Get Daily Queue Error]:', serverError);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve daily appointment queue.',
      data: null,
    });
  }
};

module.exports = {
  registerWalkInPatient,
  searchPatientRecords,
  getDailyAppointmentQueue,
};
