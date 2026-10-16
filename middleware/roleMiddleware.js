/**
 * ============================================================================
 * FILE: middleware/roleMiddleware.js
 * ARCHITECTURAL LAYER: Security Middleware Layer (Role-Based Access Control Gate)
 * ============================================================================
 * PURPOSE WITHIN MVC ARCHITECTURE:
 * Enforces the Principle of Least Privilege across the three clinic roles:
 *   - 'SuperAdmin'   : System configuration, staff management, inventory, audit logs
 *   - 'Receptionist' : Patient walk-in intake, demographic search, daily queues
 *   - 'Physician'    : Clinical WHO Category I-III triage, PEP schedule, dose shots
 *
 * SECURITY COMPLIANCE (Modules 05, 06 & 13):
 * If an authenticated staff member attempts to access an endpoint outside their
 * assigned role (e.g., a Receptionist trying to prescribe a Category III RIG dose
 * or create a SuperAdmin account), this middleware blocks the request with a
 * `403 Forbidden` status AND writes an immutable security alert to `AuditLog`.
 * ============================================================================
 */

const AuditLog = require('../models/AuditLog');

/**
 * Higher-Order Middleware: Authorize Specific Clinic Roles
 * Usage in routes: `authorizeRoles('Physician', 'SuperAdmin')`
 *
 * @param  {...string} allowedRoles - List of roles permitted to access the route
 * @returns {Function} Express middleware function
 */
const authorizeRoles = (...allowedRoles) => {
  return async (req, res, next) => {
    // Ensure `verifyAuthenticationToken` ran before this middleware
    if (!req.authenticatedUser || !req.authenticatedUser.role) {
      return res.status(401).json({
        success: false,
        message: 'User identity not verified. Authentication must precede role authorization.',
        data: null,
      });
    }

    const currentStaffRole = req.authenticatedUser.role;

    // Check if the authenticated user's role is in the whitelist for this endpoint
    if (!allowedRoles.includes(currentStaffRole)) {
      // Log the unauthorized privilege escalation attempt for SuperAdmin review
      try {
        await AuditLog.create({
          actorId: req.authenticatedUser.userId,
          actorRole: currentStaffRole,
          actionType: 'RBAC_ACCESS_DENIED',
          targetCollection: 'AuthSession',
          description: `Role '${currentStaffRole}' attempted unauthorized access to ${req.method} ${req.originalUrl}`,
          ipAddress: req.ip || '127.0.0.1',
          metadata: {
            requiredRoles: allowedRoles,
            attemptedEndpoint: req.originalUrl,
            httpMethod: req.method,
          },
        });
      } catch (auditError) {
        console.error('[RBAC Audit Error] Could not record access denial:', auditError.message);
      }

      return res.status(403).json({
        success: false,
        message: `Access Denied (RBAC): Your role (${currentStaffRole}) is not authorized to perform this action. Allowed roles: [${allowedRoles.join(', ')}].`,
        data: null,
      });
    }

    // Role is authorized; proceed to the Controller
    next();
  };
};

module.exports = {
  authorizeRoles,
};
