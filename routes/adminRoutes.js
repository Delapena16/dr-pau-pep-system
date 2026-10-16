/**
 * ============================================================================
 * FILE: routes/adminRoutes.js
 * ARCHITECTURAL LAYER: Route Layer (SuperAdmin Protected Endpoints)
 * ============================================================================
 * PURPOSE WITHIN MVC ARCHITECTURE:
 * Defines all `/api/admin/*` endpoints for managing clinic staff accounts,
 * cold-chain vaccine inventory, and security audit logs.
 *
 * SECURITY COMPLIANCE (Modules 05, 06 & 13):
 * Every route in this file is protected by two sequential security gates:
 *   1. `verifyAuthenticationToken`: Verifies the HttpOnly JWT cookie.
 *   2. `authorizeRoles('SuperAdmin')`: Blocks Receptionists and Physicians
 *      from accessing administrative endpoints (Principle of Least Privilege).
 * ============================================================================
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const {
  createStaffUserAccount,
  getAllStaffUsers,
  addOrRestockVaccineBatch,
  getInventoryStatusAndAlerts,
  getSystemAuditLogsAndAnalyticsSummary,
} = require('../controllers/adminController');
const { verifyAuthenticationToken } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/roleMiddleware');

const router = express.Router();

/**
 * Validation Error Handler
 */
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: errors.array()[0].msg,
      data: { validationErrors: errors.array() },
    });
  }
  next();
};

// Apply JWT verification and SuperAdmin RBAC gate to ALL routes in this router
router.use(verifyAuthenticationToken);
router.use(authorizeRoles('SuperAdmin'));

/**
 * @route   POST /api/admin/users
 * @desc    Create a new clinic staff account (SuperAdmin, Receptionist, or Physician)
 * @access  Private (SuperAdmin Only)
 */
router.post(
  '/users',
  [
    body('fullName')
      .trim()
      .notEmpty()
      .withMessage('Staff full name is required.')
      .isLength({ max: 100 }),
    body('email')
      .isEmail()
      .withMessage('Valid official email address is required.')
      .normalizeEmail(),
    body('password')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters long for security compliance.'),
    body('role')
      .isIn(['SuperAdmin', 'Receptionist', 'Physician'])
      .withMessage('Role must be strictly SuperAdmin, Receptionist, or Physician.'),
    handleValidationErrors,
  ],
  createStaffUserAccount
);

/**
 * @route   GET /api/admin/users
 * @desc    List all clinic staff accounts (without password hashes or OTP secrets)
 * @access  Private (SuperAdmin Only)
 */
router.get('/users', getAllStaffUsers);

/**
 * @route   POST /api/admin/inventory
 * @desc    Add or restock a vaccine / RIG batch in the cold-chain inventory
 * @access  Private (SuperAdmin Only)
 */
router.post(
  '/inventory',
  [
    body('itemName')
      .trim()
      .notEmpty()
      .withMessage('Vaccine or biologic item name is required.'),
    body('itemCategory')
      .isIn([
        'Anti-Rabies Vaccine (ARV)',
        'Rabies Immunoglobulin (RIG)',
        'Tetanus Toxoid',
        'Medical Consumable',
      ])
      .withMessage('Valid inventory category is required.'),
    body('batchNumber')
      .trim()
      .notEmpty()
      .withMessage('Manufacturer batch/lot number is required.'),
    body('vialQuantity')
      .isInt({ min: 1 })
      .withMessage('Vial quantity must be a positive integer.'),
    body('dosesPerVial')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Doses per vial must be at least 1.'),
    body('expirationDate')
      .isISO8601()
      .withMessage('Valid ISO expiration date (YYYY-MM-DD) is required.'),
    handleValidationErrors,
  ],
  addOrRestockVaccineBatch
);

/**
 * @route   GET /api/admin/inventory
 * @desc    Retrieve cold-chain inventory sorted by FEFO (First Expired, First Out)
 * @access  Private (SuperAdmin Only)
 */
router.get('/inventory', getInventoryStatusAndAlerts);

/**
 * @route   GET /api/admin/analytics-summary
 * @desc    Retrieve clinic KPI summary, barangay walk-ins, and security audit trail
 * @access  Private (SuperAdmin Only)
 */
router.get('/analytics-summary', getSystemAuditLogsAndAnalyticsSummary);

module.exports = router;
