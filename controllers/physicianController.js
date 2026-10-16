/**
 * ============================================================================
 * FILE: controllers/physicianController.js
 * ARCHITECTURAL LAYER: Controller Layer (Clinical Triage, PEP Schedule & FEFO)
 * ============================================================================
 * PURPOSE WITHIN MVC ARCHITECTURE:
 * Implements the core medical decision-making logic restricted to `Physician`:
 *   1. `calculatePepScheduleDates`: Computes the 5-dose WHO/DOH Post-Exposure
 *      Prophylaxis schedule (Day 0, Day 3, Day 7, Day 14, Day 28).
 *   2. `evaluateExposureAndGeneratePepSchedule`: Classifies animal bite wounds
 *      into WHO Category I, II, or III, flags mandatory Rabies Immunoglobulin
 *      (RIG) for Category III bites, and embeds the generated PEP schedule.
 *   3. `recordVaccineDoseAdministration`: Administers a scheduled PEP dose and
 *      automatically deducts 1 dose from the earliest-expiring valid batch in
 *      `Inventory` (FEFO - First Expired, First Out).
 *   4. `getHighRiskAndDefaulterPatients`: Lists Category III patients and
 *      patients who missed a scheduled vaccination date (Defaulters).
 *
 * ACADEMIC DEFENSE TALKING POINTS:
 * 1. Why `calculatePepScheduleDates` is critical:
 *    Rabies PEP efficacy depends on strict adherence to the Day 0, 3, 7, 14,
 *    and 28 immunological timeline. Automating date calculation eliminates human
 *    calendar counting errors at the clinic desk.
 * 2. Atomic FEFO Inventory Deduction:
 *    When a Physician administers a shot, the controller queries `Inventory`
 *    sorted by `expirationDate: 1` where `remainingDoses > 0` and `expirationDate > now`,
 *    preventing the accidental use of expired vaccines and minimizing wastage.
 * ============================================================================
 */

const Patient = require('../models/Patient');
const Inventory = require('../models/Inventory');
const AuditLog = require('../models/AuditLog');

// Standard WHO/DOH Rabies PEP Regimen Day Offsets from Day 0
const STANDARD_PEP_DAY_OFFSETS = [0, 3, 7, 14, 28];

/**
 * HUMANIZED HELPER FUNCTION: calculatePepScheduleDates
 * Calculates the exact calendar dates for Day 0, Day 3, Day 7, Day 14, and Day 28
 * starting from the initial vaccination date (`dayZeroDate`).
 *
 * @param {Date|string} dayZeroDate - The starting date of the first PEP vaccine dose
 * @returns {Array<Object>} Array of 5 embedded PEP dose objects ready for Mongoose
 */
const calculatePepScheduleDates = (dayZeroDate = new Date()) => {
  const baseDate = new Date(dayZeroDate);

  return STANDARD_PEP_DAY_OFFSETS.map((dayOffset) => {
    const calculatedDoseDate = new Date(baseDate);
    calculatedDoseDate.setDate(baseDate.getDate() + dayOffset);

    return {
      doseLabel: `Day ${dayOffset}`,
      dayOffset,
      scheduledDate: calculatedDoseDate,
      dateAdministered: null,
      status: 'Scheduled',
      vaccineBrand: null,
      vaccineBatchNumber: null,
      administeredBy: null,
    };
  });
};

/**
 * EVALUATE BITE EXPOSURE (WHO CATEGORY I-III) & GENERATE PEP SCHEDULE
 * Route: POST /api/physician/patients/:patientId/triage
 */
const evaluateExposureAndGeneratePepSchedule = async (req, res) => {
  try {
    const { patientId } = req.params;
    const {
      exposureCaseId,
      whoCategory,
      clinicalNotes,
      dayZeroStartDate,
      rigAdministered = false,
      rigBatchNumber = null,
    } = req.body;

    const patientRecord = await Patient.findById(patientId);

    if (!patientRecord || patientRecord.exposureHistory.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Patient record or exposure history not found.',
        data: null,
      });
    }

    // Select specific exposure subdocument or default to the latest exposure case
    const targetExposureCase = exposureCaseId
      ? patientRecord.exposureHistory.id(exposureCaseId)
      : patientRecord.exposureHistory[patientRecord.exposureHistory.length - 1];

    if (!targetExposureCase) {
      return res.status(404).json({
        success: false,
        message: 'Specified animal bite exposure case was not found on this patient.',
        data: null,
      });
    }

    targetExposureCase.whoCategory = whoCategory;
    targetExposureCase.attendingPhysician = req.authenticatedUser.userId;
    targetExposureCase.clinicalNotes = clinicalNotes || '';

    // WHO Category I (touching/feeding animals, licks on intact skin) requires
    // thorough washing and counseling only—no vaccine regimen needed.
    if (whoCategory === 'Category I') {
      targetExposureCase.rigRequired = false;
      targetExposureCase.pepStatus = 'Completed';
      targetExposureCase.pepSchedule = [];
    } else {
      // WHO Category II & Category III require the 5-dose PEP vaccination schedule.
      // Category III (transdermal bites, scratches with blood, or saliva on mucous
      // membranes) additionally requires Rabies Immunoglobulin (RIG).
      targetExposureCase.rigRequired = whoCategory === 'Category III';
      targetExposureCase.rigAdministered = Boolean(rigAdministered);
      targetExposureCase.rigBatchNumber = rigBatchNumber;
      targetExposureCase.pepStatus = 'Ongoing PEP';
      targetExposureCase.pepSchedule = calculatePepScheduleDates(
        dayZeroStartDate || new Date()
      );
    }

    await patientRecord.save();

    // Record structured clinical triage in AuditLog for PySpark Category III anomaly detection
    await AuditLog.create({
      actorId: req.authenticatedUser.userId,
      actorRole: req.authenticatedUser.role,
      actionType: 'CLINICAL_TRIAGE_COMPLETED',
      targetCollection: 'Patient',
      targetDocumentId: patientRecord._id,
      description: `Physician classified ${patientRecord.fullName} (${patientRecord.patientCode}) as ${whoCategory}.`,
      ipAddress: req.ip || '127.0.0.1',
      metadata: {
        patientCode: patientRecord.patientCode,
        barangay: patientRecord.barangay,
        animalType: targetExposureCase.animalType,
        whoCategory,
        rigRequired: targetExposureCase.rigRequired,
      },
    });

    return res.status(200).json({
      success: true,
      message: `Triage saved: ${patientRecord.fullName} classified under ${whoCategory}. ${
        whoCategory === 'Category I'
          ? 'No PEP vaccination required.'
          : '5-dose PEP schedule (Day 0, 3, 7, 14, 28) generated.'
      }`,
      data: {
        patient: patientRecord,
        evaluatedExposure: targetExposureCase,
      },
    });
  } catch (serverError) {
    console.error('[Physician Triage Error]:', serverError);
    return res.status(500).json({
      success: false,
      message: 'Failed to evaluate exposure and generate PEP schedule.',
      data: null,
    });
  }
};

/**
 * RECORD VACCINE DOSE ADMINISTRATION WITH AUTOMATIC FEFO INVENTORY DEDUCTION
 * Route: POST /api/physician/patients/:patientId/administer-dose
 */
const recordVaccineDoseAdministration = async (req, res) => {
  try {
    const { patientId } = req.params;
    const { exposureCaseId, doseLabel, preferredBatchNumber } = req.body;

    const patientRecord = await Patient.findById(patientId);
    if (!patientRecord || patientRecord.exposureHistory.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Patient record not found.',
        data: null,
      });
    }

    const targetExposureCase = exposureCaseId
      ? patientRecord.exposureHistory.id(exposureCaseId)
      : patientRecord.exposureHistory[patientRecord.exposureHistory.length - 1];

    if (!targetExposureCase) {
      return res.status(404).json({
        success: false,
        message: 'Exposure case not found for this patient.',
        data: null,
      });
    }

    // Locate the requested dose (e.g., "Day 0", "Day 3", "Day 7", "Day 14", or "Day 28")
    const targetDoseEntry = targetExposureCase.pepSchedule.find(
      (dose) => dose.doseLabel === doseLabel
    );

    if (!targetDoseEntry) {
      return res.status(404).json({
        success: false,
        message: `Dose '${doseLabel}' not found in the patient's PEP schedule. Complete triage first.`,
        data: null,
      });
    }

    if (targetDoseEntry.status === 'Completed') {
      return res.status(400).json({
        success: false,
        message: `${doseLabel} has already been administered on ${new Date(
          targetDoseEntry.dateAdministered
        ).toLocaleDateString()}.`,
        data: null,
      });
    }

    // ------------------------------------------------------------------------
    // FEFO (First Expired, First Out) AUTOMATIC VACCINE BATCH SELECTION
    // ------------------------------------------------------------------------
    const inventoryQuery = {
      itemCategory: 'Anti-Rabies Vaccine (ARV)',
      remainingDoses: { $gt: 0 },
      expirationDate: { $gt: new Date() }, // Never select an expired batch
    };

    if (preferredBatchNumber) {
      inventoryQuery.batchNumber = preferredBatchNumber.toUpperCase().trim();
    }

    const selectedVaccineBatch = await Inventory.findOne(inventoryQuery).sort({
      expirationDate: 1, // Earliest expiration date first (FEFO)
    });

    if (!selectedVaccineBatch) {
      return res.status(400).json({
        success: false,
        message:
          'Insufficient non-expired Anti-Rabies Vaccine (ARV) stock in cold-chain inventory. Please notify SuperAdmin to restock.',
        data: null,
      });
    }

    // Deduct 1 dose from the selected batch
    selectedVaccineBatch.remainingDoses -= 1;
    selectedVaccineBatch.lastUpdatedBy = req.authenticatedUser.userId;
    await selectedVaccineBatch.save();

    // Mark the patient's PEP dose as Completed
    targetDoseEntry.status = 'Completed';
    targetDoseEntry.dateAdministered = new Date();
    targetDoseEntry.vaccineBrand = selectedVaccineBatch.itemName;
    targetDoseEntry.vaccineBatchNumber = selectedVaccineBatch.batchNumber;
    targetDoseEntry.administeredBy = req.authenticatedUser.userId;

    // Check if all scheduled doses in the regimen are now completed
    const allDosesCompleted = targetExposureCase.pepSchedule.every(
      (dose) => dose.status === 'Completed'
    );
    if (allDosesCompleted) {
      targetExposureCase.pepStatus = 'Completed';
    }

    await patientRecord.save();

    // Log transaction for PySpark vaccine burn-rate & inventory forecasting
    await AuditLog.create({
      actorId: req.authenticatedUser.userId,
      actorRole: req.authenticatedUser.role,
      actionType: 'VACCINE_DOSE_ADMINISTERED',
      targetCollection: 'Patient',
      targetDocumentId: patientRecord._id,
      description: `Administered ${doseLabel} (${selectedVaccineBatch.itemName} - Batch ${selectedVaccineBatch.batchNumber}) to ${patientRecord.fullName}.`,
      ipAddress: req.ip || '127.0.0.1',
      metadata: {
        patientCode: patientRecord.patientCode,
        barangay: patientRecord.barangay,
        doseLabel,
        vaccineBrand: selectedVaccineBatch.itemName,
        batchNumber: selectedVaccineBatch.batchNumber,
        dosesDeducted: 1,
        remainingBatchDoses: selectedVaccineBatch.remainingDoses,
      },
    });

    return res.status(200).json({
      success: true,
      message: `${doseLabel} administered to ${patientRecord.fullName} using FEFO batch ${selectedVaccineBatch.batchNumber} (${selectedVaccineBatch.itemName}). Remaining doses in batch: ${selectedVaccineBatch.remainingDoses}.`,
      data: {
        administeredDose: targetDoseEntry,
        deductedInventoryBatch: {
          itemName: selectedVaccineBatch.itemName,
          batchNumber: selectedVaccineBatch.batchNumber,
          remainingDoses: selectedVaccineBatch.remainingDoses,
          isLowStock: selectedVaccineBatch.isLowStock,
        },
        patient: patientRecord,
      },
    });
  } catch (serverError) {
    console.error('[Administer Vaccine Dose Error]:', serverError);
    return res.status(500).json({
      success: false,
      message: 'Failed to record vaccine dose administration.',
      data: null,
    });
  }
};

/**
 * GET HIGH-RISK CATEGORY III PATIENTS & OVERDUE PEP DEFAULTERS
 * Route: GET /api/physician/alerts/defaulters-and-cat3
 */
const getHighRiskAndDefaulterPatients = async (req, res) => {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    // 1. Patients with overdue scheduled doses (scheduledDate < today and status === 'Scheduled')
    const defaulterPatients = await Patient.find({
      exposureHistory: {
        $elemMatch: {
          pepStatus: 'Ongoing PEP',
          pepSchedule: {
            $elemMatch: {
              status: 'Scheduled',
              scheduledDate: { $lt: startOfToday },
            },
          },
        },
      },
    }).sort({ updatedAt: -1 });

    // 2. High-risk WHO Category III cases requiring close clinical monitoring
    const categoryThreePatients = await Patient.find({
      'exposureHistory.whoCategory': 'Category III',
    })
      .sort({ updatedAt: -1 })
      .limit(30);

    return res.status(200).json({
      success: true,
      message: `Identified ${defaulterPatients.length} overdue PEP defaulter(s) and ${categoryThreePatients.length} Category III high-risk patient(s).`,
      data: {
        defaulterCount: defaulterPatients.length,
        categoryThreeCount: categoryThreePatients.length,
        defaulterPatients,
        categoryThreePatients,
      },
    });
  } catch (serverError) {
    console.error('[Get Defaulters and Category III Error]:', serverError);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve high-risk Category III and defaulter alerts.',
      data: null,
    });
  }
};

module.exports = {
  calculatePepScheduleDates,
  evaluateExposureAndGeneratePepSchedule,
  recordVaccineDoseAdministration,
  getHighRiskAndDefaulterPatients,
};
