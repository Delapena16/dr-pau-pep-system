/**
 * ============================================================================
 * FILE: middleware/authMiddleware.js
 * ARCHITECTURAL LAYER: Security Middleware Layer (JWT & Cookie Verification Gate)
 * ============================================================================
 * PURPOSE WITHIN MVC ARCHITECTURE:
 * Intercepts incoming requests to protected API routes BEFORE they reach any
 * Controller. It extracts the stateless JSON Web Token (JWT) stored inside the
 * `HttpOnly`, `Secure`, `SameSite=Strict` cookie (`pep_auth_token`), verifies
 * its cryptographic signature, and confirms the staff member's account is still
 * active in MongoDB.
 *
 * SECURITY COMPLIANCE (Modules 05, 06 & 13):
 * 1. Why HttpOnly Cookies instead of localStorage?
 *    Storing JWTs in `localStorage` exposes tokens to Cross-Site Scripting (XSS)
 *    theft. An `HttpOnly` cookie cannot be read by client-side `document.cookie`
 *    JavaScript, neutralizing XSS token exfiltration.
 * 2. Why SameSite=Strict?
 *    Prevents the browser from sending the authentication cookie on cross-site
 *    requests, defending against Cross-Site Request Forgery (CSRF).
 * 3. Live Account Revocation Check:
 *    Even if a JWT hasn't expired yet, we check `user.isActive` in MongoDB so a
 *    SuperAdmin can immediately revoke access for a terminated employee.
 * ============================================================================
 */

const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * Middleware: Verify Stateless JWT Authentication Token
 * Attaches `req.authenticatedUser` if valid; otherwise returns 401 Unauthorized.
 */
const verifyAuthenticationToken = async (req, res, next) => {
  try {
    // 1. Primary extraction: Read JWT from HttpOnly cookie set after Step 2 MFA verification
    let token = req.cookies && req.cookies.pep_auth_token;

    // 2. Fallback extraction: Support Authorization Bearer header for Postman API testing
    //    during academic panel demonstrations.
    if (
      !token &&
      req.headers.authorization &&
      req.headers.authorization.startsWith('Bearer ')
    ) {
      token = req.headers.authorization.split(' ')[1];
    }

    // If no token is present in either cookie or header, block access immediately
    if (!token) {
      return res.status(401).json({
        success: false,
        message:
          'Authentication required. Please complete the 2-step MFA login to access this resource.',
        data: null,
      });
    }

    // 3. Verify JWT cryptographic signature and expiration timestamp
    const jwtSecretKey =
      process.env.JWT_SECRET ||
      'dr_pau_pep_super_secret_jwt_signing_key_2026_capstone_defense';

    const decodedTokenPayload = jwt.verify(token, jwtSecretKey);

    // 4. Confirm the user only holds a full session token (not a partial Step-1 token)
    if (!decodedTokenPayload.mfaVerified) {
      return res.status(401).json({
        success: false,
        message:
          'Multi-Factor Authentication (MFA) is incomplete. Please verify your 6-digit OTP.',
        data: null,
      });
    }

    // 5. Query MongoDB to confirm the user still exists and is active
    const activeStaffMember = await User.findById(decodedTokenPayload.userId).select(
      '_id fullName email role isActive'
    );

    if (!activeStaffMember || !activeStaffMember.isActive) {
      return res.status(401).json({
        success: false,
        message:
          'Your staff account is either deactivated or no longer exists. Contact the SuperAdmin.',
        data: null,
      });
    }

    // 6. Attach clean user identity object to `req` for downstream RBAC and Controllers
    req.authenticatedUser = {
      userId: activeStaffMember._id,
      fullName: activeStaffMember.fullName,
      email: activeStaffMember.email,
      role: activeStaffMember.role,
    };

    next();
  } catch (tokenError) {
    // Differentiate expired tokens from tampered tokens for clear frontend feedback
    const errorMessage =
      tokenError.name === 'TokenExpiredError'
        ? 'Your session has expired. Please log in again.'
        : 'Invalid or tampered authentication token.';

    return res.status(401).json({
      success: false,
      message: errorMessage,
      data: null,
    });
  }
};

module.exports = {
  verifyAuthenticationToken,
};
