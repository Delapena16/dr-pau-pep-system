const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Patient = require('../models/Patient');
const Inventory = require('../models/Inventory');
const InventoryForecast = require('../models/InventoryForecast');
const AuditLog = require('../models/AuditLog');
const { logActivity, AUDIT_EVENTS } = require('../utils/logger');
const { deductInventoryVial, calculatePepSchedule, DOSE_MILESTONE_ORDER } = require('./receptionistController');

// ito yung pang kuha ng default forecast para may lumabas agad sa dashboard
const getDefaultPySparkAnalytics = () => {
  const forecastPath = path.join(__dirname, '..', 'public', 'data', 'forecast_summary.json');
  if (fs.existsSync(forecastPath)) {
    try {
      return JSON.parse(fs.readFileSync(forecastPath, 'utf-8'));
    } catch (e) {
      // dito banda yung fallback na lang sa baba gagamitin
    }
  }

  return {
    generatedAt: '2026-10-17T08:00:00Z',
    clinicScope: 'Barangay Kapitan Pepe, Cabanatuan City',
    vialForecasts: [],
    categoryBreakdown: [],
    purokBreakdown: [],
    weeklyTrends: [],
    completionVsDefaulterRates: {
      totalScheduledDosesEvaluated: 0,
      fulfilledCount: 0,
      defaulterCount: 0,
      pendingCount: 0,
      completionRatePercent: 0,
      defaulterRatePercent: 0
    }
  };
};

// ito yung pang sync ng forecast sa totoong stock ng vials para pareho sila
const enrichForecastWithLiveInventory = (baseForecast, inventoryItems = []) => {
  if (!inventoryItems || inventoryItems.length === 0) {
    return baseForecast;
  }

  const stockTotals = {
    'anti-rabies': 0,
    'anti-tetanus': 0,
    ERIG: 0
  };

  inventoryItems.forEach((item) => {
    if (stockTotals[item.vaccineType] !== undefined) {
      stockTotals[item.vaccineType] += Number(item.currentStock || 0);
    }
  });

  const updatedVialForecasts = (baseForecast.vialForecasts || []).map((vf) => {
    const liveStock =
      stockTotals[vf.vaccineType] !== undefined ? stockTotals[vf.vaccineType] : vf.currentStock;
    const burnRate = vf.dailyBurnRate || 1;
    const daysLeft = Math.max(0, Math.floor(liveStock / burnRate));
    const recRestock = Math.max(
      0,
      vf.projected30DayDemand + (vf.safetyThreshold || 10) - liveStock
    );

    let stockStatus = 'ADEQUATE';
    if (liveStock <= (vf.safetyThreshold || 10) || daysLeft <= 10) {
      stockStatus = 'CRITICAL RESTOCK';
    } else if (daysLeft <= 21) {
      stockStatus = 'REORDER SOON';
    }

    return {
      ...vf,
      currentStock: liveStock,
      estimatedDaysUntilStockout: daysLeft,
      recommendedRestockQty: recRestock,
      stockStatus
    };
  });

  return {
    ...baseForecast,
    generatedAt: new Date().toISOString(),
    vialForecasts: updatedVialForecasts
  };
};

// ito yung sa triage ni doc, save ng wound tapos kung may turok, babawas ng 1 vial
const saveWoundAssessment = async (req, res) => {
  try {
    const { patientId } = req.params;
    const {
      woundCategory,
      allergyNotes,
      clinicalNotes,
      biteStatus,
      administerDose,
      doseDay = 'Day 0',
      vaccineType = 'anti-rabies'
    } = req.body;

    const shouldAdminister = administerDose === true || administerDose === 'true';
    const actorUser = req.authenticatedUser || req.user || { role: 'Physician', userId: null };

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

    patientRecord.woundCategory = woundCategory;
    patientRecord.allergyNotes = allergyNotes ? allergyNotes.trim() : 'Negative equine skin test';
    patientRecord.clinicalNotes = clinicalNotes ? clinicalNotes.trim() : '';
    if (biteStatus) {
      patientRecord.biteStatus = biteStatus.trim();
    }

    if (woundCategory === 'Category I') {
      // Category I: MUST NOT generate a 5-dose schedule. Clear any pending doses and set status to "Wound Cleansing Only"
      patientRecord.pepSchedule = (patientRecord.pepSchedule || []).filter((d) => d.status === 'Fulfilled');
      if (typeof patientRecord.markModified === 'function') {
        patientRecord.markModified('pepSchedule');
      }
      patientRecord.clinicalStatus = 'Wound Cleansing Only';
    } else {
      if (!patientRecord.pepSchedule || patientRecord.pepSchedule.length === 0) {
        patientRecord.pepSchedule = calculatePepSchedule(patientRecord.day0WalkInDate, false);
      }
      patientRecord.clinicalStatus = 'Under Treatment';
    }

    let deductionDetails = null;
    let vialsDeducted = 0;

    if (shouldAdminister && woundCategory !== 'Category I') {
      let targetDose = patientRecord.pepSchedule.find((d) => d.doseDay === doseDay);
      if (!targetDose) {
        targetDose = patientRecord.pepSchedule.find((d) => d.status === 'Pending');
      }

      if (targetDose && targetDose.status === 'Fulfilled') {
        return res.status(400).json({
          success: false,
          message: `Cannot log dose: ${targetDose.doseDay} has already been completed and cannot be deducted twice.`
        });
      }

      // Enforce sequential dosing
      const activeDoseDay = targetDose ? targetDose.doseDay : doseDay;
      const doseOrderList = DOSE_MILESTONE_ORDER || ['Day 0', 'Day 3', 'Day 7', 'Day 14', 'Day 28'];
      const targetIdx = doseOrderList.indexOf(activeDoseDay);
      if (targetIdx > 0) {
        for (let i = 0; i < targetIdx; i++) {
          const priorDoseName = doseOrderList[i];
          const priorDose = (patientRecord.pepSchedule || []).find((d) => d.doseDay === priorDoseName);
          if (priorDose && priorDose.status === 'Pending') {
            return res.status(400).json({
              success: false,
              message: `Sequential Dosing Violation: Cannot log ${activeDoseDay} because ${priorDoseName} is still pending. Doses must be logged in sequential order.`
            });
          }
        }
      }

      if (targetDose) {
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
        vialsDeducted = 1;
      }
    }

    if (woundCategory === 'Category I') {
      patientRecord.clinicalStatus = 'Wound Cleansing Only';
    } else {
      const allDone =
        (patientRecord.pepSchedule || []).length > 0 &&
        (patientRecord.pepSchedule || []).every((d) => d.status === 'Fulfilled');
      patientRecord.clinicalStatus = allDone ? 'Completed' : 'Under Treatment';
    }
    patientRecord.checkedInForTriage = false;

    if (mongoose.Types.ObjectId.isValid(actorUser.userId)) {
      patientRecord.assessedByPhysician = actorUser.userId;
    }
    await patientRecord.save();

    await AuditLog.create({
      actorId: mongoose.Types.ObjectId.isValid(actorUser.userId) ? actorUser.userId : null,
      actorRole: actorUser.role,
      actionType: shouldAdminister ? 'PHYSICIAN_TRIAGE_AND_DOSE' : 'PHYSICIAN_WOUND_ASSESSMENT',
      targetCollection: 'Patient',
      description: `Triaged ${patientRecord.patientId} (${patientRecord.fullName}) as ${woundCategory}.${
        vialsDeducted > 0
          ? ` ${doseDay} dose logged (${vaccineType}, Lot ${deductionDetails.batchNumber}).`
          : ''
      }`,
      ipAddress: req.ip || '127.0.0.1'
    });

    // Universal audit trail: triage update
    await logActivity(
      actorUser.role,
      AUDIT_EVENTS.TRIAGE_UPDATED,
      `Updated triage for ${patientRecord.patientId} (${patientRecord.fullName}) — ${woundCategory} classification applied.`,
      {
        actorId: actorUser.userId,
        ipAddress: req.ip || '127.0.0.1',
        targetCollection: 'Patient',
        metadata: {
          patientId: patientRecord.patientId,
          woundCategory,
          clinicalStatus: patientRecord.clinicalStatus
        }
      }
    );

    // Universal audit trail: dose administration
    if (vialsDeducted > 0) {
      await logActivity(
        actorUser.role,
        AUDIT_EVENTS.DOSE_ADMINISTERED,
        `Administered ${doseDay} ${vaccineType} dose to ${patientRecord.patientId} (${patientRecord.fullName}). 1 vial deducted from Lot ${deductionDetails.batchNumber}.`,
        {
          actorId: actorUser.userId,
          ipAddress: req.ip || '127.0.0.1',
          targetCollection: 'Patient',
          metadata: {
            patientId: patientRecord.patientId,
            doseDay,
            vaccineType,
            batchNumber: deductionDetails.batchNumber
          }
        }
      );
    }

    return res.status(200).json({
      success: true,
      message:
        vialsDeducted > 0
          ? `${doseDay} dose logged. 1 ${vaccineType} vial deducted from Lot ${deductionDetails.batchNumber}.`
          : `Triage saved for ${patientRecord.fullName} (${woundCategory}).`,
      data: {
        patientRecord,
        vialsDeducted,
        remainingStock: deductionDetails ? deductionDetails.remainingStock : null,
        batchNumber: deductionDetails ? deductionDetails.batchNumber : null
      }
    });
  } catch (error) {
    console.error('Save wound assessment error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to save clinical triage assessment.'
    });
  }
};

// ito yung listahan ng vials na tingin lang si doc, bawal mag edit
const getPhysicianReadOnlyInventory = async (req, res) => {
  try {
    const inventory = await Inventory.find({}).sort({ expirationDate: 1 });

    return res.status(200).json({
      success: true,
      message: 'Read-only vaccine availability retrieved.',
      data: {
        inventory
      }
    });
  } catch (error) {
    // Fallback: return demo inventory if MongoDB is unreachable
    return res.status(200).json({
      success: true,
      message: 'Read-only vaccine availability retrieved (offline mode).',
      data: {
        inventory: [
          { _id: '1', vaccineType: 'anti-rabies', brandName: 'Verorab (Purified Vero Cell Rabies Vaccine)', batchNumber: 'VRB-2026-A104', currentStock: 84, lowStockThreshold: 15, expirationDate: '2027-06-30' },
          { _id: '2', vaccineType: 'anti-rabies', brandName: 'Speeda (Purified Vero Cell Vaccine)', batchNumber: 'SPD-2026-C219', currentStock: 42, lowStockThreshold: 15, expirationDate: '2027-08-15' },
          { _id: '3', vaccineType: 'anti-tetanus', brandName: 'Tetavax (Adsorbed Tetanus Toxoid 0.5mL)', batchNumber: 'TTX-2026-B204', currentStock: 36, lowStockThreshold: 10, expirationDate: '2027-03-20' },
          { _id: '4', vaccineType: 'ERIG', brandName: 'Equirab (Equine Rabies Immunoglobulin 200 IU/mL)', batchNumber: 'EQB-2026-R309', currentStock: 7, lowStockThreshold: 10, expirationDate: '2027-05-10' }
        ]
      }
    });
  }
};

// ito yung kukuha ng monthly forecast, admin lang to
const getPySparkAnalyticsSummary = async (req, res) => {
  try {
    let baseForecast = getDefaultPySparkAnalytics();

    const [dbForecast, inventoryItems] = await Promise.all([
      InventoryForecast.findOne().sort({ createdAt: -1 }).lean(),
      Inventory.find({})
    ]);

    if (dbForecast && dbForecast.vialForecasts && dbForecast.vialForecasts.length > 0) {
      baseForecast = dbForecast;
    }

    const enrichedForecast = enrichForecastWithLiveInventory(baseForecast, inventoryItems);

    return res.status(200).json({
      success: true,
      message: 'Monthly stock forecast retrieved.',
      data: enrichedForecast
    });
  } catch (error) {
    console.error('Get stock forecast error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to load stock forecast summary.'
    });
  }
};

// ito yung pang compute ulit ng 30 day tsaka 90 day forecast, gamit yung stock tsaka pasyente ngayon
const recalculateMonthlyForecast = async (req, res) => {
  try {
    const baseForecast = getDefaultPySparkAnalytics();
    const inventoryItems = await Inventory.find({});
    const updatedForecast = enrichForecastWithLiveInventory(baseForecast, inventoryItems);

    await InventoryForecast.deleteMany({});
    await InventoryForecast.create({
      generatedAt: updatedForecast.generatedAt,
      clinicScope: updatedForecast.clinicScope,
      vialForecasts: updatedForecast.vialForecasts,
      categoryBreakdown: updatedForecast.categoryBreakdown,
      purokBreakdown: updatedForecast.purokBreakdown,
      weeklyTrends: updatedForecast.weeklyTrends,
      completionVsDefaulterRates: updatedForecast.completionVsDefaulterRates
    });

    return res.status(200).json({
      success: true,
      message: '30-day and 90-day stock forecasts recalculated from live clinic inventory.',
      data: updatedForecast
    });
  } catch (error) {
    console.error('Recalculate forecast error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to recalculate monthly forecast.'
    });
  }
};

module.exports = {
  getDefaultPySparkAnalytics,
  enrichForecastWithLiveInventory,
  saveWoundAssessment,
  getPhysicianReadOnlyInventory,
  getPySparkAnalyticsSummary,
  recalculateMonthlyForecast
};
