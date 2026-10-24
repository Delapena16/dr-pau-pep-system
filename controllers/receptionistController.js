const mongoose = require('mongoose');
const Patient = require('../models/Patient');
const Inventory = require('../models/Inventory');
const AuditLog = require('../models/AuditLog');
const { logActivity, AUDIT_EVENTS } = require('../utils/logger');

const DOSE_MILESTONE_ORDER = ['Day 0', 'Day 3', 'Day 7', 'Day 14', 'Day 28'];

// ito yung anu, pang compute ng Day 0, 3, 7, 14, 28 simula nung araw na pumunta yung walk in gamit standard JS Date methods
const calculatePepSchedule = (day0WalkInDate, administerDay0Now = false) => {
  let baseDate;
  if (day0WalkInDate) {
    if (typeof day0WalkInDate === 'string' && day0WalkInDate.includes('T')) {
      baseDate = new Date(day0WalkInDate);
    } else if (typeof day0WalkInDate === 'string' && day0WalkInDate.includes('-')) {
      const parts = day0WalkInDate.split('-').map(Number);
      baseDate = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
    } else {
      baseDate = new Date(day0WalkInDate);
    }
  } else {
    baseDate = new Date();
  }

  if (isNaN(baseDate.getTime())) {
    baseDate = new Date();
  }

  const regimenOffsets = [0, 3, 7, 14, 28];

  return regimenOffsets.map((offsetDays) => {
    // Standard JS Date math: accurately add exactly 0, 3, 7, 14, and 28 days to baseDate
    const scheduledDate = new Date(baseDate.getTime());
    scheduledDate.setDate(baseDate.getDate() + offsetDays);
    const isDay0Fulfilled = offsetDays === 0 && administerDay0Now;

    return {
      doseDay: `Day ${offsetDays}`,
      dayOffset: offsetDays,
      scheduledDate: scheduledDate,
      status: isDay0Fulfilled ? 'Fulfilled' : 'Pending',
      doseAdministered: isDay0Fulfilled,
      vaccineTypeUsed: 'anti-rabies',
      dateProcessed: isDay0Fulfilled ? new Date() : null
    };
  });
};

// ito yung sa inventory, babawas ng 1 vial pag nag turok na, yung malapit ng mag expire uunahin (FEFO)
const deductInventoryVial = async (vaccineType) => {
  const vialStock = await Inventory.findOne({
    vaccineType: vaccineType,
    currentStock: { $gt: 0 }
  }).sort({ expirationDate: 1 });

  if (!vialStock) {
    return null;
  }

  vialStock.currentStock -= 1;
  await vialStock.save();

  return {
    remainingStock: vialStock.currentStock,
    batchNumber: vialStock.batchNumber,
    lowStockThreshold: vialStock.lowStockThreshold || 10,
    isLowStock: vialStock.currentStock <= (vialStock.lowStockThreshold || 10)
  };
};

// ito yung pang register ng walk in sa front desk, save ng info tapos lagay sa pila ni doc
const registerWalkInPatient = async (req, res) => {
  try {
    const {
      fullName,
      age,
      sex,
      contactNumber,
      purok,
      barangay,
      consentGiven,
      day0WalkInDate,
      animalType,
      biteSite,
      biteStatus
    } = req.body;

    if (consentGiven !== true && consentGiven !== 'true') {
      return res.status(400).json({
        success: false,
        message: 'Patient consent must be confirmed before check-in.'
      });
    }

    if (!fullName || typeof fullName !== 'string' || !/^[a-zA-ZÀ-ÿ\s.\-]+$/.test(fullName.trim())) {
      return res.status(400).json({
        success: false,
        message: 'Letters, spaces, dots, and hyphens only.'
      });
    }

    const numericAge = Number(age);
    if (Number.isNaN(numericAge) || numericAge < 0 || numericAge > 120) {
      return res.status(400).json({
        success: false,
        message: 'Patient age must be a valid number between 0 and 120.'
      });
    }

    const normalizedPhone = String(contactNumber || '').replace(/\D/g, '');
    if (!/^09\d{9}$/.test(normalizedPhone)) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid 11-digit mobile number starting with 09 (e.g., 09171234567).'
      });
    }

    const resolvedAddress = (purok || barangay || 'Purok 1, Kapitan Pepe').trim();
    const resolvedBiteStatus = (biteStatus || 'Bite - Unprovoked').trim();
    const walkInDateObj = day0WalkInDate ? new Date(day0WalkInDate) : new Date();

    let resolvedAnimal = (animalType || 'Dog').trim();
    if (resolvedAnimal === 'Domestic Dog') resolvedAnimal = 'Dog';
    if (resolvedAnimal === 'Domestic Cat') resolvedAnimal = 'Cat';
    const validAnimalEnums = ['Dog', 'Cat', 'Stray Dog', 'Stray Cat', 'Bat', 'Other'];
    if (!validAnimalEnums.includes(resolvedAnimal)) {
      resolvedAnimal = 'Other';
    }

    const scheduledDates = calculatePepSchedule(walkInDateObj, false);
    const actorUser = req.user || req.authenticatedUser || { role: 'Receptionist', userId: null };

    const count = await Patient.countDocuments();
    let patientId = `PEP-2026-${String(count + 1).padStart(3, '0')}`;
    const exists = await Patient.findOne({ patientId });
    if (exists) {
      patientId = `PEP-2026-${String(count + 101).padStart(3, '0')}`;
    }

    const patientRecord = await Patient.create({
      patientId,
      fullName: fullName.trim(),
      age: numericAge,
      sex,
      contactNumber: normalizedPhone,
      purok: resolvedAddress,
      barangay: resolvedAddress,
      consentGiven: true,
      day0WalkInDate: walkInDateObj,
      animalType: resolvedAnimal,
      biteSite: biteSite.trim(),
      biteStatus: resolvedBiteStatus,
      woundCategory: 'Pending',
      clinicalStatus: 'Waiting for Doctor',
      checkedInForTriage: true,
      allergyNotes: 'Pending Physician Assessment',
      clinicalNotes: '',
      pepSchedule: scheduledDates
    });

    await AuditLog.create({
      actorId: mongoose.Types.ObjectId.isValid(actorUser.userId) ? actorUser.userId : null,
      actorRole: actorUser.role,
      actionType: 'WALKIN_SENT_TO_DOCTOR_QUEUE',
      targetCollection: 'Patient',
      description: `Checked in walk-in ${patientRecord.fullName} (${patientId}) from ${resolvedAddress} and sent to Doctor's Queue.`,
      ipAddress: req.ip || '127.0.0.1'
    });

    // Universal audit trail: patient registration
    await logActivity(
      actorUser.role,
      AUDIT_EVENTS.PATIENT_REGISTERED,
      `Registered walk-in patient ${patientRecord.fullName} (${patientId}) from ${resolvedAddress}.`,
      {
        actorId: actorUser.userId,
        ipAddress: req.ip || '127.0.0.1',
        targetCollection: 'Patient',
        metadata: { patientId, animalType: resolvedAnimal, biteSite: biteSite.trim() }
      }
    );

    return res.status(200).json({
      success: true,
      message: `Added ${patientRecord.fullName} to Doctor's Queue`,
      data: {
        patientRecord
      }
    });
  } catch (error) {
    console.error('Register walk-in patient error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to check in walk-in patient.'
    });
  }
};

// ito yung pang check in ng bumalik na pasyente para sa Day 3, 7, 14 o 28
const checkInReturningPatient = async (req, res) => {
  try {
    const { patientId } = req.params;
    const actorUser = req.user || req.authenticatedUser || { role: 'Receptionist', userId: null };

    const patientRecord = await Patient.findOne({
      $or: [
        { patientId: patientId },
        ...(mongoose.Types.ObjectId.isValid(patientId) ? [{ _id: patientId }] : [])
      ]
    });

    if (!patientRecord) {
      return res.status(404).json({
        success: false,
        message: 'Patient record not found.'
      });
    }

    patientRecord.checkedInForTriage = true;
    patientRecord.clinicalStatus = 'Due Today';
    await patientRecord.save();

    await AuditLog.create({
      actorId: mongoose.Types.ObjectId.isValid(actorUser.userId) ? actorUser.userId : null,
      actorRole: actorUser.role,
      actionType: 'FOLLOWUP_PATIENT_CHECKED_IN',
      targetCollection: 'Patient',
      description: `Checked in returning patient ${patientRecord.fullName} (${patientRecord.patientId}) for booster dose.`,
      ipAddress: req.ip || '127.0.0.1'
    });

    return res.status(200).json({
      success: true,
      message: `Patient ${patientRecord.fullName} checked in and sent to Doctor's Queue`,
      data: {
        patientRecord
      }
    });
  } catch (error) {
    console.error('Check-in returning patient error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to check in returning patient.'
    });
  }
};

// ito yung pang log ng turok o pang mark na hindi sumipot, doc lang pwede dito
const processScheduledDose = async (req, res) => {
  try {
    const { patientId } = req.params;
    const { doseDay, doseAdministered, vaccineType = 'anti-rabies' } = req.body;

    const isShotGiven = doseAdministered === true || doseAdministered === 'true';
    const actorUser = req.user || req.authenticatedUser || { role: 'Physician', userId: null };

    const patientRecord = await Patient.findOne({
      $or: [
        { patientId: patientId },
        ...(mongoose.Types.ObjectId.isValid(patientId) ? [{ _id: patientId }] : [])
      ]
    });

    if (!patientRecord) {
      return res.status(404).json({
        success: false,
        message: 'Patient record not found.'
      });
    }

    const targetDose = patientRecord.pepSchedule.find((d) => d.doseDay === doseDay);
    if (!targetDose) {
      return res.status(404).json({
        success: false,
        message: `Scheduled ${doseDay} dose not found for this patient.`
      });
    }

    if (targetDose.status === 'Fulfilled') {
      return res.status(400).json({
        success: false,
        message: `Cannot log dose: ${doseDay} has already been completed and cannot be deducted twice.`
      });
    }

    // Enforce sequential dosing: reject if doctor attempts to log a dose out of order
    const targetIdx = DOSE_MILESTONE_ORDER.indexOf(doseDay);
    if (targetIdx > 0) {
      for (let i = 0; i < targetIdx; i++) {
        const priorDoseName = DOSE_MILESTONE_ORDER[i];
        const priorDose = (patientRecord.pepSchedule || []).find((d) => d.doseDay === priorDoseName);
        if (priorDose && priorDose.status === 'Pending') {
          return res.status(400).json({
            success: false,
            message: `Sequential Dosing Violation: Cannot log ${doseDay} because ${priorDoseName} is still pending. Doses must be logged in sequential order.`
          });
        }
      }
    }

    let vialsDeducted = 0;
    let deductionDetails = null;

    if (isShotGiven) {
      deductionDetails = await deductInventoryVial(vaccineType);

      if (deductionDetails === null) {
        return res.status(400).json({
          success: false,
          message: 'Cannot log dose: Selected vaccine batch is out of stock. Please notify Admin.'
        });
      }

      targetDose.status = 'Fulfilled';
      targetDose.doseAdministered = true;
      targetDose.vaccineTypeUsed = vaccineType;
      targetDose.dateProcessed = new Date();
      const allDone = (patientRecord.pepSchedule || []).every((d) => d.status === 'Fulfilled');
      patientRecord.clinicalStatus = allDone ? 'Completed' : 'Under Treatment';
      patientRecord.checkedInForTriage = false;
      vialsDeducted = 1;
    } else {
      targetDose.status = 'Defaulter';
      targetDose.doseAdministered = false;
      targetDose.dateProcessed = new Date();
      patientRecord.clinicalStatus = 'Missed Dose';
      vialsDeducted = 0;
    }

    await patientRecord.save();
    await AuditLog.create({
      actorId: mongoose.Types.ObjectId.isValid(actorUser.userId) ? actorUser.userId : null,
      actorRole: actorUser.role,
      actionType: isShotGiven ? 'DOSE_FULFILLED_VIAL_DEDUCTED' : 'DOSE_FLAGGED_DEFAULTER',
      targetCollection: 'Patient',
      description: `${patientRecord.patientId} (${doseDay}) marked ${targetDose.status}. Vials deducted: ${vialsDeducted} (${vaccineType}).`,
      ipAddress: req.ip || '127.0.0.1'
    });

    // Universal audit trail: dose administration
    if (isShotGiven) {
      await logActivity(
        actorUser.role,
        AUDIT_EVENTS.DOSE_ADMINISTERED,
        `Administered ${doseDay} ${vaccineType} dose to ${patientRecord.patientId} (${patientRecord.fullName}). 1 vial deducted from Lot ${deductionDetails ? deductionDetails.batchNumber : 'n/a'}.`,
        {
          actorId: actorUser.userId,
          ipAddress: req.ip || '127.0.0.1',
          targetCollection: 'Patient',
          metadata: {
            patientId: patientRecord.patientId,
            doseDay,
            vaccineType,
            batchNumber: deductionDetails ? deductionDetails.batchNumber : null
          }
        }
      );
    }

    return res.status(200).json({
      success: true,
      message: isShotGiven
        ? `${doseDay} dose logged. 1 ${vaccineType} vial deducted from Lot ${deductionDetails.batchNumber}.`
        : `${doseDay} marked as missed visit (0 vials deducted).`,
      data: {
        patientRecord,
        processedDose: targetDose,
        vialsDeducted,
        batchNumber: deductionDetails ? deductionDetails.batchNumber : null,
        remainingStock: deductionDetails ? deductionDetails.remainingStock : null,
        isLowStock: deductionDetails ? deductionDetails.isLowStock : false
      }
    });
  } catch (error) {
    console.error('Process scheduled dose error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to process scheduled dose.'
    });
  }
};

// Dynamic Mongoose query for all patient records and daily triage queue
const getPatientsAndDailyQueue = async (req, res) => {
  try {
    const queryText = (req.query.query || '').trim();
    let filter = {};

    if (queryText.length > 0) {
      const safeText = queryText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(safeText, 'i');
      filter = {
        $or: [
          { patientId: regex },
          { fullName: regex },
          { purok: regex },
          { barangay: regex },
          { contactNumber: regex }
        ]
      };
    }

    const patients = await Patient.find(filter).sort({ createdAt: -1, patientId: 1 });

    return res.status(200).json({
      success: true,
      message: 'Patient queue retrieved.',
      data: {
        count: patients.length,
        patients
      }
    });
  } catch (error) {
    console.error('Get patients queue error:', error.message);
    // Fallback: return empty array if MongoDB is unreachable
    return res.status(200).json({
      success: true,
      message: 'Patient queue retrieved (offline mode).',
      data: {
        count: 0,
        patients: []
      }
    });
  }
};

// Direct dynamic patient fetch helper
async function getPatients(req, res) {
  try {
    const patients = await Patient.find({}).sort({ createdAt: -1 });
    return res.status(200).json(patients);
  } catch (error) {
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

module.exports = {
  calculatePepSchedule,
  calculatePepScheduleDates: calculatePepSchedule,
  deductInventoryVial,
  registerWalkInPatient,
  checkInReturningPatient,
  processScheduledDose,
  getPatientsAndDailyQueue,
  getPatients,
  DOSE_MILESTONE_ORDER
};
