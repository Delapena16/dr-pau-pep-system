/**
 * ============================================================================
 * FILE: controllers/adminController.js
 * ARCHITECTURAL LAYER: Controller Layer (SuperAdmin Operations & Inventory)
 * ============================================================================
 * PURPOSE WITHIN MVC ARCHITECTURE:
 * Contains the business logic exclusively accessible to the `SuperAdmin` role:
 *   1. Staff Account Provisioning (`createStaffUserAccount`, `getAllStaffUsers`)
 *   2. Vaccine & RIG Cold-Chain Inventory Management (`addOrRestockVaccineBatch`,
 *      `getInventoryStatusAndAlerts`)
 *   3. Executive Clinic & Security Audit Summary (`getSystemAuditLogsAndAnalyticsSummary`)
 *
 * ACADEMIC DEFENSE TALKING POINTS:
 * 1. Separation of Duties:
 *    A SuperAdmin manages staff permissions and vaccine stock, whereas clinical
 *    diagnosis is restricted to Physicians.
 * 2. FEFO Inventory Visibility:
 *    The inventory endpoint automatically sorts vaccine batches by earliest
 *    expiration date (`expirationDate: 1`) and calculates low-stock alerts so
 *    the clinic never runs out of Anti-Rabies Vaccine (ARV) or Category III RIG.
 * ============================================================================
 */

const User = require('../models/User');
const Patient = require('../models/Patient');
const Inventory = require('../models/Inventory');
const AuditLog = require('../models/AuditLog');

/**
 * CREATE NEW STAFF USER ACCOUNT (SuperAdmin Only)
 * Route: POST /api/admin/users
 */
const createStaffUserAccount = async (req, res) => {
  try {
    const { fullName, email, password, role } = req.body;

    // Check if an account with this email already exists
    const existingAccount = await User.findOne({
      email: email.toLowerCase().trim(),
    });

    if (existingAccount) {
      return res.status(409).json({
        success: false,
        message: `A staff account with email '${email}' is already registered.`,
        data: null,
      });
    }

    // Create user; the User model pre-save hook hashes `passwordHash` with 12 bcrypt salt rounds
    const newStaffMember = await User.create({
      fullName: fullName.trim(),
      email: email.toLowerCase().trim(),
      passwordHash: password,
      role,
      isActive: true,
    });

    // Record administrative action in the immutable audit log
    await AuditLog.create({
      actorId: req.authenticatedUser.userId,
      actorRole: req.authenticatedUser.role,
      actionType: 'STAFF_ACCOUNT_CREATED',
      targetCollection: 'User',
      targetDocumentId: newStaffMember._id,
      description: `SuperAdmin created new ${role} account for ${newStaffMember.fullName} (${newStaffMember.email}).`,
      ipAddress: req.ip || '127.0.0.1',
      metadata: {
        createdRole: role,
        createdEmail: newStaffMember.email,
      },
    });

    return res.status(201).json({
      success: true,
      message: `Staff account for ${newStaffMember.fullName} (${role}) created with 12-round bcrypt password protection.`,
      data: {
        staffMember: {
          userId: newStaffMember._id,
          fullName: newStaffMember.fullName,
          email: newStaffMember.email,
          role: newStaffMember.role,
          isActive: newStaffMember.isActive,
          createdAt: newStaffMember.createdAt,
        },
      },
    });
  } catch (serverError) {
    console.error('[Create Staff Account Error]:', serverError);
    return res.status(500).json({
      success: false,
      message: 'Failed to create staff account.',
      data: null,
    });
  }
};

/**
 * LIST ALL CLINIC STAFF ACCOUNTS (Data-Minimized Projection)
 * Route: GET /api/admin/users
 */
const getAllStaffUsers = async (req, res) => {
  try {
    const staffAccounts = await User.find()
      .select('_id fullName email role isActive lastLoginAt createdAt')
      .sort({ role: 1, fullName: 1 });

    return res.status(200).json({
      success: true,
      message: `Retrieved ${staffAccounts.length} clinic staff account(s).`,
      data: {
        totalStaffCount: staffAccounts.length,
        staffAccounts,
      },
    });
  } catch (serverError) {
    console.error('[Get Staff Users Error]:', serverError);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve clinic staff accounts.',
      data: null,
    });
  }
};

/**
 * ADD OR RESTOCK VACCINE / RIG BATCH IN COLD-CHAIN INVENTORY
 * Route: POST /api/admin/inventory
 */
const addOrRestockVaccineBatch = async (req, res) => {
  try {
    const {
      itemName,
      itemCategory,
      batchNumber,
      manufacturer,
      vialQuantity,
      dosesPerVial = 5,
      reorderThresholdDoses = 25,
      expirationDate,
    } = req.body;

    const normalizedBatchNumber = batchNumber.toUpperCase().trim();
    const totalCalculatedDoses = Number(vialQuantity) * Number(dosesPerVial);

    // Check if batch number already exists; if so, increment stock, otherwise create new batch
    let inventoryBatch = await Inventory.findOne({
      batchNumber: normalizedBatchNumber,
    });

    if (inventoryBatch) {
      inventoryBatch.vialQuantity += Number(vialQuantity);
      inventoryBatch.remainingDoses += totalCalculatedDoses;
      inventoryBatch.lastUpdatedBy = req.authenticatedUser.userId;
      await inventoryBatch.save();
    } else {
      inventoryBatch = await Inventory.create({
        itemName: itemName.trim(),
        itemCategory,
        batchNumber: normalizedBatchNumber,
        manufacturer: manufacturer || 'Sanofi Pasteur / Bharat Biotech',
        vialQuantity: Number(vialQuantity),
        dosesPerVial: Number(dosesPerVial),
        remainingDoses: totalCalculatedDoses,
        reorderThresholdDoses: Number(reorderThresholdDoses),
        expirationDate: new Date(expirationDate),
        lastUpdatedBy: req.authenticatedUser.userId,
      });
    }

    await AuditLog.create({
      actorId: req.authenticatedUser.userId,
      actorRole: req.authenticatedUser.role,
      actionType: 'INVENTORY_BATCH_RESTOCKED',
      targetCollection: 'Inventory',
      targetDocumentId: inventoryBatch._id,
      description: `Added/restocked ${vialQuantity} vials (${totalCalculatedDoses} doses) of ${itemName} [Batch: ${normalizedBatchNumber}].`,
      ipAddress: req.ip || '127.0.0.1',
      metadata: {
        itemName,
        itemCategory,
        batchNumber: normalizedBatchNumber,
        dosesAdded: totalCalculatedDoses,
        remainingDoses: inventoryBatch.remainingDoses,
      },
    });

    return res.status(201).json({
      success: true,
      message: `Inventory batch ${normalizedBatchNumber} (${itemName}) saved with ${inventoryBatch.remainingDoses} available doses.`,
      data: {
        inventoryBatch,
      },
    });
  } catch (serverError) {
    console.error('[Add Inventory Batch Error]:', serverError);
    return res.status(500).json({
      success: false,
      message: 'Failed to add or restock vaccine batch.',
      data: null,
    });
  }
};

/**
 * GET INVENTORY STATUS SORTED BY FEFO (First Expired, First Out) & LOW-STOCK ALERTS
 * Route: GET /api/admin/inventory
 */
const getInventoryStatusAndAlerts = async (req, res) => {
  try {
    // Sort by expirationDate ascending so earliest-expiring vials appear at the top (FEFO)
    const inventoryBatches = await Inventory.find().sort({ expirationDate: 1 });

    const lowStockBatches = inventoryBatches.filter(
      (batch) => batch.remainingDoses <= batch.reorderThresholdDoses
    );

    const expiredBatches = inventoryBatches.filter(
      (batch) => new Date() > new Date(batch.expirationDate)
    );

    return res.status(200).json({
      success: true,
      message: 'Cold-chain vaccine inventory retrieved in FEFO (First Expired, First Out) order.',
      data: {
        totalBatches: inventoryBatches.length,
        lowStockAlertCount: lowStockBatches.length,
        expiredAlertCount: expiredBatches.length,
        inventoryBatches,
      },
    });
  } catch (serverError) {
    console.error('[Get Inventory Error]:', serverError);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch vaccine inventory.',
      data: null,
    });
  }
};

/**
 * GET EXECUTIVE CLINIC ANALYTICS & SECURITY AUDIT LOGS
 * Route: GET /api/admin/analytics-summary
 */
const getSystemAuditLogsAndAnalyticsSummary = async (req, res) => {
  try {
    const [
      totalPatientsCount,
      categoryThreePatientsCount,
      lowStockBatchesCount,
      recentAuditLogs,
    ] = await Promise.all([
      Patient.countDocuments(),
      Patient.countDocuments({ 'exposureHistory.whoCategory': 'Category III' }),
      Inventory.countDocuments({
        $expr: { $lte: ['$remainingDoses', '$reorderThresholdDoses'] },
      }),
      AuditLog.find()
        .sort({ timestamp: -1 })
        .limit(25)
        .populate('actorId', 'fullName email role'),
    ]);

    // Aggregate walk-in counts by Barangay for epidemiological heat mapping
    const walkInsByBarangay = await Patient.aggregate([
      {
        $group: {
          _id: '$barangay',
          patientCount: { $sum: 1 },
        },
      },
      { $sort: { patientCount: -1 } },
      { $limit: 10 },
    ]);

    return res.status(200).json({
      success: true,
      message: 'Executive PEP analytics and security audit trail retrieved.',
      data: {
        metrics: {
          totalRegisteredPatients: totalPatientsCount,
          categoryThreeHighRiskCases: categoryThreePatientsCount,
          lowStockInventoryAlerts: lowStockBatchesCount,
        },
        walkInsByBarangay,
        recentAuditLogs,
      },
    });
  } catch (serverError) {
    console.error('[Get Analytics Summary Error]:', serverError);
    return res.status(500).json({
      success: false,
      message: 'Failed to aggregate executive analytics summary.',
      data: null,
    });
  }
};

module.exports = {
  createStaffUserAccount,
  getAllStaffUsers,
  addOrRestockVaccineBatch,
  getInventoryStatusAndAlerts,
  getSystemAuditLogsAndAnalyticsSummary,
};
