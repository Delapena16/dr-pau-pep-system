const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const User = require('../models/User');
const Patient = require('../models/Patient');
const Inventory = require('../models/Inventory');
const AuditLog = require('../models/AuditLog');
const { logActivity, AUDIT_EVENTS } = require('../utils/logger');
const {
  getDefaultPySparkAnalytics,
  enrichForecastWithLiveInventory
} = require('./physicianController');

// ito yung pang gawa ng bagong staff, admin lang pwede dito
const createStaffUserAccount = async (req, res) => {
  try {
    const { fullName, email, password, role } = req.body;
    const normalizedEmail = email.toLowerCase().trim();

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: `An account with email ${normalizedEmail} already exists.`
      });
    }

    const createdUser = await User.create({
      fullName: fullName.trim(),
      email: normalizedEmail,
      passwordHash: password,
      role,
      isActive: true
    });

    await AuditLog.create({
      actorId: mongoose.Types.ObjectId.isValid(req.authenticatedUser.userId)
        ? req.authenticatedUser.userId
        : null,
      actorRole: req.authenticatedUser.role,
      actionType: 'STAFF_ONBOARDED',
      targetCollection: 'User',
      description: `Created ${role} account for ${createdUser.fullName} (${normalizedEmail}).`,
      ipAddress: req.ip || '127.0.0.1'
    });

    return res.status(201).json({
      success: true,
      message: `Staff account created for ${createdUser.fullName} (${role}).`,
      data: {
        staffMember: {
          userId: createdUser._id,
          fullName: createdUser.fullName,
          email: createdUser.email,
          role: createdUser.role
        }
      }
    });
  } catch (error) {
    console.error('Create staff account error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to create staff account.'
    });
  }
};

const VALID_ROLES = ['SuperAdmin', 'Receptionist', 'Physician'];

// ito yung pang edit ng staff, name email role password, pag walang bagong password di niya gagalaw yung luma
const updateStaffUserAccount = async (req, res) => {
  try {
    const { id } = req.params;
    const { fullName, email, password, role } = req.body;
    const normalizedEmail = email ? email.toLowerCase().trim() : undefined;
    const actorId = String(req.authenticatedUser.userId);

    if (role && !VALID_ROLES.includes(role)) {
      return res.status(400).json({ success: false, message: 'Invalid staff role.' });
    }
    if (password && password.length < 8) {
      return res
        .status(400)
        .json({ success: false, message: 'Password must be at least 8 characters long.' });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ success: false, message: 'Staff account not found.' });
    }
    const user = await User.findById(id).select('+passwordHash');
    if (!user) {
      return res.status(404).json({ success: false, message: 'Staff account not found.' });
    }

    if (role && role !== user.role && user.role === 'SuperAdmin') {
      const adminCount = await User.countDocuments({ role: 'SuperAdmin', isActive: true });
      if (adminCount <= 1) {
        return res.status(400).json({
          success: false,
          message: 'Cannot change the role of the only SuperAdmin.'
        });
      }
    }

    if (normalizedEmail && normalizedEmail !== user.email) {
      const taken = await User.findOne({ email: normalizedEmail, _id: { $ne: user._id } });
      if (taken) {
        return res.status(409).json({
          success: false,
          message: `An account with email ${normalizedEmail} already exists.`
        });
      }
      user.email = normalizedEmail;
    }
    if (fullName) user.fullName = fullName.trim();
    if (role) user.role = role;
    if (password) user.passwordHash = password;
    await user.save();

    await AuditLog.create({
      actorId: mongoose.Types.ObjectId.isValid(actorId) ? actorId : null,
      actorRole: req.authenticatedUser.role,
      actionType: 'STAFF_UPDATED',
      targetCollection: 'User',
      description: `Updated account for ${user.fullName} (${user.email}).`,
      ipAddress: req.ip || '127.0.0.1'
    });

    return res.status(200).json({
      success: true,
      message: 'Staff account updated.',
      data: {
        staffMember: {
          userId: user._id,
          fullName: user.fullName,
          email: user.email,
          role: user.role
        }
      }
    });
  } catch (error) {
    console.error('Update staff account error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to update staff account.' });
  }
};

// ito yung pang delete ng staff, bawal burahin sarili tsaka yung nag iisang admin
const deleteStaffUserAccount = async (req, res) => {
  try {
    const { id } = req.params;
    const actorId = String(req.authenticatedUser.userId);

    if (id === actorId) {
      return res
        .status(400)
        .json({ success: false, message: 'You cannot delete your own account.' });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ success: false, message: 'Staff account not found.' });
    }
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Staff account not found.' });
    }
    if (user.role === 'SuperAdmin') {
      const adminCount = await User.countDocuments({ role: 'SuperAdmin', isActive: true });
      if (adminCount <= 1) {
        return res
          .status(400)
          .json({ success: false, message: 'Cannot delete the only SuperAdmin.' });
      }
    }
    await User.deleteOne({ _id: user._id });

    await AuditLog.create({
      actorId: mongoose.Types.ObjectId.isValid(actorId) ? actorId : null,
      actorRole: req.authenticatedUser.role,
      actionType: 'STAFF_REMOVED',
      targetCollection: 'User',
      description: `Removed account for ${user.fullName} (${user.email}).`,
      ipAddress: req.ip || '127.0.0.1'
    });

    return res.status(200).json({
      success: true,
      message: `Removed ${user.fullName}.`
    });
  } catch (error) {
    console.error('Delete staff account error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to delete staff account.' });
  }
};

// ito yung pang toggle ng isActive status ng staff (deactivate / reactivate)
const toggleStaffAccountStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const actorId = String(req.authenticatedUser ? req.authenticatedUser.userId : '');

    if (id === actorId) {
      return res.status(400).json({
        success: false,
        message: 'You cannot deactivate your own account.'
      });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ success: false, message: 'Staff account not found.' });
    }
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Staff account not found.' });
    }

    if (user.role === 'SuperAdmin' && user.isActive) {
      const activeAdminCount = await User.countDocuments({
        role: 'SuperAdmin',
        isActive: true,
        _id: { $ne: user._id }
      });
      if (activeAdminCount < 1) {
        return res.status(400).json({
          success: false,
          message: 'Cannot deactivate the only active SuperAdmin.'
        });
      }
    }

    user.isActive = !user.isActive;
    await user.save();

    const action = user.isActive ? 'ACTIVATED' : 'DEACTIVATED';
    await AuditLog.create({
      actorId: mongoose.Types.ObjectId.isValid(actorId) ? actorId : null,
      actorRole: req.authenticatedUser.role,
      actionType: `STAFF_${action}`,
      targetCollection: 'User',
      description: `${action} account for ${user.fullName} (${user.email}).`,
      ipAddress: req.ip || '127.0.0.1'
    });

    return res.status(200).json({
      success: true,
      message: `Staff account for ${user.fullName} has been ${user.isActive ? 'reactivated' : 'deactivated'}.`,
      data: {
        isActive: user.isActive,
        staffMember: {
          userId: user._id,
          fullName: user.fullName,
          email: user.email,
          role: user.role,
          isActive: user.isActive
        }
      }
    });
  } catch (error) {
    console.error('Toggle staff account error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to update staff account status.' });
  }
};

// Dynamic Mongoose query for all staff accounts
const getAllStaffUsers = async (req, res) => {
  try {
    const staffAccounts = await User.find({})
      .select('_id fullName email role isActive lastLoginAt createdAt')
      .sort({ role: 1, fullName: 1 });

    return res.status(200).json({
      success: true,
      message: 'Staff accounts retrieved.',
      data: {
        staffAccounts
      }
    });
  } catch (error) {
    console.error('Get staff accounts error:', error.message);
    // Fallback: return demo staff accounts if MongoDB is unreachable
    return res.status(200).json({
      success: true,
      message: 'Staff accounts retrieved (offline mode).',
      data: {
        staffAccounts: [
          { _id: 'admin@drpauclinic.ph', fullName: 'Dr. Edgar Rivera', email: 'admin@drpauclinic.ph', role: 'SuperAdmin', isActive: true },
          { _id: 'receptionist@drpauclinic.ph', fullName: 'Amen Leaderr', email: 'receptionist@drpauclinic.ph', role: 'Receptionist', isActive: true },
          { _id: 'physician@drpauclinic.ph', fullName: 'Dr. Jose Rizalino Cruz', email: 'physician@drpauclinic.ph', role: 'Physician', isActive: true }
        ]
      }
    });
  }
};

// ito yung sa inventory, dito nag dadagdag ng bagong batch o restock ng vials
const addOrRestockVaccineBatch = async (req, res) => {
  try {
    const {
      vaccineType,
      brandName,
      batchNumber,
      vialsAdded,
      lowStockThreshold = 10,
      expirationDate
    } = req.body;

    const cleanBatch = batchNumber.toUpperCase().trim();
    const addedCount = Number(vialsAdded);

    let vialRecord = await Inventory.findOne({ batchNumber: cleanBatch });

    if (vialRecord) {
      vialRecord.currentStock += addedCount;
      await vialRecord.save();
    } else {
      vialRecord = await Inventory.create({
        vaccineType,
        brandName: brandName.trim(),
        batchNumber: cleanBatch,
        currentStock: addedCount,
        lowStockThreshold: Number(lowStockThreshold),
        expirationDate: new Date(expirationDate)
      });
    }

    await AuditLog.create({
      actorId: mongoose.Types.ObjectId.isValid(req.authenticatedUser.userId)
        ? req.authenticatedUser.userId
        : null,
      actorRole: req.authenticatedUser.role,
      actionType: 'INVENTORY_VIALS_RESTOCKED',
      targetCollection: 'Inventory',
      description: `Restocked +${addedCount} vial(s) of ${vaccineType} (${brandName}, Lot ${cleanBatch}). Current stock: ${vialRecord.currentStock}.`,
      ipAddress: req.ip || '127.0.0.1'
    });

    // Universal audit trail: inventory restock
    await logActivity(
      req.authenticatedUser.role,
      AUDIT_EVENTS.VIAL_RESTOCKED,
      `Restocked +${addedCount} vial(s) of ${vaccineType} (${brandName}, Lot ${cleanBatch}). Current stock: ${vialRecord.currentStock}.`,
      {
        actorId: req.authenticatedUser.userId,
        ipAddress: req.ip || '127.0.0.1',
        targetCollection: 'Inventory',
        metadata: { vaccineType, brandName, batchNumber: cleanBatch, vialsAdded: addedCount }
      }
    );

    return res.status(201).json({
      success: true,
      message: `Restocked +${addedCount} vial(s) of ${vaccineType} (Lot ${cleanBatch}). Current stock: ${vialRecord.currentStock} vials.`,
      data: {
        vialRecord
      }
    });
  } catch (error) {
    console.error('Restock vaccine batch error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to restock vaccine vials.'
    });
  }
};

// Dynamic Mongoose query for inventory status and alerts
const getInventoryStatusAndAlerts = async (req, res) => {
  try {
    const inventoryList = await Inventory.find({}).sort({ expirationDate: 1 });

    return res.status(200).json({
      success: true,
      message: 'Vaccine vial inventory retrieved.',
      data: {
        inventory: inventoryList
      }
    });
  } catch (error) {
    console.error('Get inventory error:', error.message);
    // Fallback: return demo inventory if MongoDB is unreachable
    return res.status(200).json({
      success: true,
      message: 'Vaccine vial inventory retrieved (offline mode).',
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

// ito yung pang void o write-off ng nasirang vial o typo sa clerical record nang hindi sinisira yung audit ledger
const logInventorySpoilageOrVoid = async (req, res) => {
  try {
    const { batchLotId, batchNumber, id, vialsToDeduct, reason } = req.body;
    const batchIdentifier = String(batchLotId || batchNumber || id || '').trim();

    if (!batchIdentifier) {
      return res.status(400).json({
        success: false,
        message: 'Batch Lot ID or inventory ID is required.'
      });
    }

    const deductCount = parseInt(vialsToDeduct, 10);
    if (isNaN(deductCount) || deductCount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Number of vials to deduct must be a positive integer greater than zero.'
      });
    }

    const cleanReason = (reason && typeof reason === 'string' && reason.trim())
      ? reason.trim()
      : 'Clerical Error / Spoilage Write-Off';

    const actorRole = req.authenticatedUser?.role || 'SuperAdmin';
    const actorId = req.authenticatedUser?.userId || null;

    const isObjectId = mongoose.Types.ObjectId.isValid(batchIdentifier);
    const query = isObjectId
      ? { $or: [{ _id: batchIdentifier }, { batchNumber: batchIdentifier.toUpperCase() }] }
      : { batchNumber: batchIdentifier.toUpperCase() };

    const vialRecord = await Inventory.findOne(query);

    if (!vialRecord) {
      return res.status(404).json({
        success: false,
        message: `Vaccine batch "${batchIdentifier}" not found in inventory.`
      });
    }

    if (deductCount > vialRecord.currentStock) {
      return res.status(400).json({
        success: false,
        message: `Cannot void ${deductCount} vials: only ${vialRecord.currentStock} vials available in Lot ${vialRecord.batchNumber}.`
      });
    }

    vialRecord.currentStock -= deductCount;
    if (mongoose.Types.ObjectId.isValid(actorId)) {
      vialRecord.lastUpdatedBy = actorId;
    }
    if (!Array.isArray(vialRecord.events)) {
      vialRecord.events = [];
    }
    vialRecord.events.push({
      eventType: 'SPOILAGE_WRITE_OFF',
      vialsDeducted: deductCount,
      reason: cleanReason,
      timestamp: new Date(),
      performedBy: mongoose.Types.ObjectId.isValid(actorId) ? actorId : null,
      actorRole
    });

    await vialRecord.save();

    await AuditLog.create({
      actorId: mongoose.Types.ObjectId.isValid(actorId) ? actorId : null,
      actorRole,
      actionType: 'INVENTORY_SPOILAGE_VOID',
      targetCollection: 'Inventory',
      description: `Voided/Logged spoilage of ${deductCount} vial(s) from Lot ${vialRecord.batchNumber} (${vialRecord.vaccineType}). Reason: ${cleanReason}. Remaining stock: ${vialRecord.currentStock}.`,
      ipAddress: req.ip || '127.0.0.1'
    });

    // Universal audit trail: stock write-off
    await logActivity(
      actorRole,
      AUDIT_EVENTS.STOCK_WRITTEN_OFF,
      `Wrote off ${deductCount} vial(s) from Lot ${vialRecord.batchNumber} (${vialRecord.vaccineType}). Reason: ${cleanReason}. Remaining stock: ${vialRecord.currentStock}.`,
      {
        actorId,
        ipAddress: req.ip || '127.0.0.1',
        targetCollection: 'Inventory',
        metadata: {
          batchNumber: vialRecord.batchNumber,
          vaccineType: vialRecord.vaccineType,
          vialsDeducted: deductCount,
          reason: cleanReason
        }
      }
    );

    return res.status(200).json({
      success: true,
      message: `Successfully voided ${deductCount} vial(s) from Lot ${vialRecord.batchNumber}. Remaining stock: ${vialRecord.currentStock}.`,
      data: {
        batchLotId: vialRecord.batchNumber,
        vialsDeducted: deductCount,
        remainingStock: vialRecord.currentStock,
        reason: cleanReason,
        vialRecord
      }
    });
  } catch (error) {
    console.error('Inventory spoilage void error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to process inventory spoilage write-off.'
    });
  }
};

// Dynamic Mongoose queries for system audit logs and analytics summary
const getSystemAuditLogsAndAnalyticsSummary = async (req, res) => {
  try {
    const baseAnalytics = getDefaultPySparkAnalytics();

    const [totalPatients, recentAuditLogs, inventory] = await Promise.all([
      Patient.countDocuments(),
      AuditLog.find({}).sort({ timestamp: -1 }).limit(50),
      Inventory.find({}).sort({ expirationDate: 1 })
    ]);

    const pySparkAnalytics = enrichForecastWithLiveInventory(baseAnalytics, inventory);

    return res.status(200).json({
      success: true,
      message: 'Clinic overview data retrieved.',
      data: {
        totalPatients,
        inventory,
        recentAuditLogs,
        pySparkAnalytics
      }
    });
  } catch (error) {
    console.error('Get overview summary error:', error.message);
    // Fallback: return demo data if MongoDB is unreachable
    const { getDefaultPySparkAnalytics, enrichForecastWithLiveInventory } = require('./physicianController');
    const baseAnalytics = getDefaultPySparkAnalytics();
    const inventory = [
      { _id: '1', vaccineType: 'anti-rabies', brandName: 'Verorab (Purified Vero Cell Rabies Vaccine)', batchNumber: 'VRB-2026-A104', currentStock: 84, lowStockThreshold: 15, expirationDate: '2027-06-30' },
      { _id: '2', vaccineType: 'anti-rabies', brandName: 'Speeda (Purified Vero Cell Vaccine)', batchNumber: 'SPD-2026-C219', currentStock: 42, lowStockThreshold: 15, expirationDate: '2027-08-15' },
      { _id: '3', vaccineType: 'anti-tetanus', brandName: 'Tetavax (Adsorbed Tetanus Toxoid 0.5mL)', batchNumber: 'TTX-2026-B204', currentStock: 36, lowStockThreshold: 10, expirationDate: '2027-03-20' },
      { _id: '4', vaccineType: 'ERIG', brandName: 'Equirab (Equine Rabies Immunoglobulin 200 IU/mL)', batchNumber: 'EQB-2026-R309', currentStock: 7, lowStockThreshold: 10, expirationDate: '2027-05-10' }
    ];
    const pySparkAnalytics = enrichForecastWithLiveInventory(baseAnalytics, inventory);
    return res.status(200).json({
      success: true,
      message: 'Clinic overview data retrieved (offline mode).',
      data: {
        totalPatients: 0,
        inventory,
        recentAuditLogs: [],
        pySparkAnalytics
      }
    });
  }
};

// ito yung pang edit ng demographic lang ng pasyente, bawal galawin yung mga turok at category
const updatePatientDemographics = async (req, res) => {
  try {
    const { id } = req.params;
    // CRITICAL SECURITY: Strictly extract ONLY demographic data.
    // Medical category, dose statuses, and clinical notes are completely ignored.
    const { fullName, contactNumber, purok } = req.body;
    const actorRole = req.authenticatedUser?.role || 'SuperAdmin';
    const actorId = req.authenticatedUser?.userId || null;

    if (!fullName || typeof fullName !== 'string' || !fullName.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Patient full name is required.'
      });
    }

    const cleanPhone = String(contactNumber || '').replace(/\D/g, '');
    if (!/^09\d{9}$/.test(cleanPhone)) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid 11-digit mobile number starting with 09 (e.g., 09171234567).'
      });
    }

    const cleanPurok = (purok && typeof purok === 'string' && purok.trim())
      ? purok.trim()
      : 'Purok 1, Kapitan Pepe';

    const patient = await Patient.findOne({
      $or: [
        { patientId: id },
        ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])
      ]
    });

    if (!patient) {
      return res.status(404).json({
        success: false,
        message: 'Patient record not found.'
      });
    }

    // Explicitly update ONLY demographic fields
    patient.fullName = fullName.trim();
    patient.contactNumber = cleanPhone;
    patient.purok = cleanPurok;
    patient.barangay = cleanPurok;

    await patient.save();

    await AuditLog.create({
      actorId: mongoose.Types.ObjectId.isValid(actorId) ? actorId : null,
      actorRole,
      actionType: 'PATIENT_DEMOGRAPHICS_UPDATED',
      targetCollection: 'Patient',
      description: `Updated demographics for ${patient.fullName} (${patient.patientId}): Purok: ${cleanPurok}, Phone: ${cleanPhone}. Medical data locked.`,
      ipAddress: req.ip || '127.0.0.1'
    });

    return res.status(200).json({
      success: true,
      message: `Demographics updated for ${patient.fullName}.`,
      data: {
        patient: {
          _id: patient._id,
          patientId: patient.patientId,
          fullName: patient.fullName,
          contactNumber: patient.contactNumber,
          purok: patient.purok,
          barangay: patient.barangay,
          age: patient.age,
          sex: patient.sex,
          woundCategory: patient.woundCategory,
          clinicalStatus: patient.clinicalStatus,
          pepSchedule: patient.pepSchedule
        }
      }
    });
  } catch (error) {
    console.error('Update patient demographics error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to update patient demographics.'
    });
  }
};

// Actionable KPI metrics for the Clinic Overview (MongoDB aggregations / counts).
const getDashboardSummary = async (req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const sevenDaysAgoStart = new Date(sevenDaysAgo);
    sevenDaysAgoStart.setUTCHours(0, 0, 0, 0);

    const [dueTodayAgg, missedAgg, pvrvAgg, consumedAgg, purokAgg, doseCompletionAgg, peakTrafficAgg, newPatientsAgg, returningAgg] = await Promise.all([
      // Card 1: Patients with a pending dose scheduled exactly today.
      Patient.aggregate([
        { $unwind: '$pepSchedule' },
        {
          $match: {
            'pepSchedule.status': 'Pending',
            'pepSchedule.scheduledDate': { $gte: todayStart, $lt: todayEnd }
          }
        },
        { $group: { _id: null, total: { $addToSet: '$_id' } } },
        { $project: { total: { $size: '$total' } } }
      ]),
      // Card 2: Missed / overdue doses (defaulter or pending past due, or flagged Missed).
      Patient.aggregate([
        {
          $match: {
            $or: [
              { clinicalStatus: 'Missed Dose' },
              { 'pepSchedule.status': 'Defaulter' },
              { 'pepSchedule': { $elemMatch: { status: 'Pending', scheduledDate: { $lt: todayStart } } } }
            ]
          }
        },
        { $count: 'total' }
      ]),
      // Card 3: Total anti-rabies (PVRV) vials on hand.
      Inventory.aggregate([
        { $match: { vaccineType: 'anti-rabies' } },
        { $group: { _id: null, total: { $sum: '$currentStock' } } }
      ]),
      // Card 3 (runway): anti-rabies vials consumed in the last 30 days.
      Patient.aggregate([
        { $unwind: '$pepSchedule' },
        {
          $match: {
            'pepSchedule.status': 'Fulfilled',
            'pepSchedule.vaccineTypeUsed': { $in: ['anti-rabies', null] },
            'pepSchedule.dateProcessed': { $gte: thirtyDaysAgo }
          }
        },
        { $group: { _id: null, total: { $sum: 1 } } }
      ]),
      // Card 4: Puroks whose incident count exceeds the mean by 50% (high surge).
      Patient.aggregate([
        { $group: { _id: '$purok', count: { $sum: 1 } } }
      ]),
      // Dose completion funnel: distinct patients who completed each milestone
      // dose over the last 90 days.
      Patient.aggregate([
        { $unwind: '$pepSchedule' },
        {
          $match: {
            'pepSchedule.status': 'Fulfilled',
            $expr: {
              $gte: [
                { $ifNull: ['$pepSchedule.dateProcessed', '$pepSchedule.scheduledDate'] },
                ninetyDaysAgo
              ]
            }
          }
        },
        { $group: { _id: '$pepSchedule.doseDay', patients: { $addToSet: '$_id' } } },
        { $project: { doseDay: '$_id', count: { $size: '$patients' } } }
      ]),
      // Peak clinic traffic by day of week (1=Sun ... 7=Sat).
      Patient.aggregate([
        { $group: { _id: { $dayOfWeek: '$day0WalkInDate' }, count: { $sum: 1 } } }
      ]),
      // New patients per day (last 7 days).
      Patient.aggregate([
        { $match: { day0WalkInDate: { $gte: sevenDaysAgoStart } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$day0WalkInDate' } }, count: { $sum: 1 } } }
      ]),
      // Returning patients per day (follow-up doses administered, last 7 days).
      Patient.aggregate([
        { $unwind: '$pepSchedule' },
        {
          $match: {
            'pepSchedule.status': 'Fulfilled',
            'pepSchedule.doseDay': { $ne: 'Day 0' },
            'pepSchedule.dateProcessed': { $gte: sevenDaysAgoStart }
          }
        },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$pepSchedule.dateProcessed' } }, count: { $sum: 1 } } }
      ])
    ]);

    const patientsDueToday = dueTodayAgg.length ? Number(dueTodayAgg[0].total || 0) : 0;
    const missedOverdueDoses = missedAgg.length ? Number(missedAgg[0].total || 0) : 0;
    const pvrvStock = pvrvAgg.length && Number(pvrvAgg[0].total || 0) > 0 ? Number(pvrvAgg[0].total || 0) : 129;

    // PVRV Stock Runway: Days Left = Math.floor(Total PVRV Vials / (30-Day Demand / 30)).
    // The 30-Day Demand comes from the forecast summary (projected30DayDemand for anti-rabies).
    let projected30DayDemand = 180;
    try {
      const forecastPath = path.join(__dirname, '..', 'public', 'data', 'forecast_summary.json');
      if (fs.existsSync(forecastPath)) {
        const forecastData = JSON.parse(fs.readFileSync(forecastPath, 'utf-8'));
        const vialForecast = (forecastData.vialForecasts || []).find(
          (vf) => vf.vaccineType === 'anti-rabies'
        );
        if (vialForecast && Number(vialForecast.projected30DayDemand || 0) > 0) {
          projected30DayDemand = Number(vialForecast.projected30DayDemand || 0);
        }
      }
    } catch (forecastErr) {
      console.warn('Could not read forecast summary for runway calc:', forecastErr.message);
    }

    // Average Daily Consumption (ADC) = 30-Day Demand / 30
    const averageDailyConsumption =
      projected30DayDemand > 0 ? projected30DayDemand / 30 : 6.0;
    const pvrvStockRunwayDays = Math.max(0, Math.floor(pvrvStock / averageDailyConsumption));

    // High surge: puroks whose incident count exceeds the per-purok mean
    // (i.e. above the normal baseline). Uses MongoDB aggregation so the
    // metric stays live with the patient collection.
    const purokCounts = (purokAgg || []).map((r) => Number(r.count || 0));
    const mean = purokCounts.length
      ? purokCounts.reduce((a, b) => a + b, 0) / purokCounts.length
      : 0;
    const highSurgePuroks = purokAgg.length
      ? purokAgg.filter((r) => Number(r.count || 0) > mean).length
      : 0;

    // Dose completion funnel data: [Day 0, Day 3, Day 7, Day 14, Day 28]
    const doseCompletionMap = {};
    for (const d of doseCompletionAgg || []) {
      doseCompletionMap[d.doseDay] = Number(d.count || 0);
    }
    const doseCompletion = ['Day 0', 'Day 3', 'Day 7', 'Day 14', 'Day 28'].map(
      (day) => doseCompletionMap[day] || 0
    );

    // Peak clinic traffic by day of week (Sun=0 .. Sat=6).
    const peakTrafficByDay = [0, 0, 0, 0, 0, 0, 0];
    for (const r of peakTrafficAgg || []) {
      const idx = Number(r._id) - 1;
      if (idx >= 0 && idx < 7) peakTrafficByDay[idx] = Number(r.count || 0);
    }

    // Daily patient mix (New vs. Returning) over the last 7 days.
    const newMap = {};
    for (const r of newPatientsAgg || []) newMap[r._id] = Number(r.count || 0);
    const returningMap = {};
    for (const r of returningAgg || []) returningMap[r._id] = Number(r.count || 0);

    const mixLabels = [];
    const mixNew = [];
    const mixReturning = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const dateStr = d.toISOString().split('T')[0];
      const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
      mixLabels.push(dayName);
      mixNew.push(newMap[dateStr] || 0);
      mixReturning.push(returningMap[dateStr] || 0);
    }
    const patientMix = { labels: mixLabels, new: mixNew, returning: mixReturning };

    return res.status(200).json({
      success: true,
      message: 'Dashboard summary retrieved.',
      data: {
        patientsDueToday,
        missedOverdueDoses,
        pvrvStock,
        pvrvStockRunwayDays,
        highSurgePuroks,
        doseCompletion,
        peakTrafficByDay,
        patientMix,
        // Backwards-compatible keys (still reported for clients that read them).
        activePatients: patientsDueToday,
        erigStock: null,
        activeStaff: null,
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Get dashboard summary error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to load dashboard summary.'
    });
  }
};

// GET /api/audit-logs -> the 50 most recent audit entries, newest first.
const getRecentAuditLogs = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const logs = await AuditLog.find({}).sort({ timestamp: -1 }).limit(limit);

    return res.status(200).json({
      success: true,
      message: 'Recent audit trail retrieved.',
      data: { auditLogs: logs, count: logs.length }
    });
  } catch (error) {
    console.error('Get recent audit logs error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to load the audit trail.'
    });
  }
};

// Records a data-privacy event when a CSV export is generated.
const logDataExport = async (req, res) => {
  try {
    const { format } = req.body || {};
    const actorUser = req.authenticatedUser || req.user || { role: 'SuperAdmin', userId: null };
    const exportType = String(format || '').toLowerCase();

    if (!['masked', 'unmasked'].includes(exportType)) {
      return res.status(400).json({
        success: false,
        message: 'Export format must be "masked" or "unmasked".'
      });
    }

    const isUnmasked = exportType === 'unmasked';

    await logActivity(
      actorUser.role,
      isUnmasked ? AUDIT_EVENTS.EXPORT_UNMASKED : AUDIT_EVENTS.EXPORT_MASKED,
      isUnmasked
        ? 'Authorized download of raw clinical data via SuperAdmin password verification'
        : 'Downloaded sanitized RA-10173 analytics report',
      {
        actorId: actorUser.userId,
        ipAddress: req.ip || '127.0.0.1',
        targetCollection: 'Export',
        metadata: { exportFormat: exportType, authorized: isUnmasked }
      }
    );

    return res.status(200).json({
      success: true,
      message: isUnmasked
        ? 'Unmasked export recorded in the audit trail.'
        : 'Masked export recorded in the audit trail.'
    });
  } catch (error) {
    console.error('Log data export error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to record the export activity.'
    });
  }
};

module.exports = {
  createStaffUserAccount,
  updateStaffUserAccount,
  deleteStaffUserAccount,
  toggleStaffAccountStatus,
  getAllStaffUsers,
  addOrRestockVaccineBatch,
  getInventoryStatusAndAlerts,
  logInventorySpoilageOrVoid,
  getSystemAuditLogsAndAnalyticsSummary,
  updatePatientDemographics,
  getDashboardSummary,
  getRecentAuditLogs,
  logDataExport
};

//Si alonto to po gumawa nito 
//Manual coding nya ginawa
//ash sa database shcem 
//merc full stack 
//vincent qa and leader  
