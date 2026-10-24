require('dotenv').config();
const bcrypt = require('bcryptjs');
const connectToDatabase = require('../config/db');
const User = require('../models/User');

// Canonical demo credentials (must match public/js/app.js DEMO_CREDENTIALS_MAP).
const DEMO_ACCOUNTS = {
  'admin@drpauclinic.ph': 'Admin@12345',
  'physician@drpauclinic.ph': 'Physician@12345',
  'receptionist@drpauclinic.ph': 'Reception@12345'
};

(async () => {
  try {
    await connectToDatabase();

    for (const [email, password] of Object.entries(DEMO_ACCOUNTS)) {
      const user = await User.findOne({ email }).select('+passwordHash');
      if (!user) {
        console.log(`Skipped (not seeded): ${email}`);
        continue;
      }

      const isActive = user.isActive !== false;
      const hashIsUsable = await bcrypt.compare(password, user.passwordHash);

      if (hashIsUsable && isActive) {
        console.log(`OK (password verified, active): ${email}`);
        continue;
      }

      if (!hashIsUsable) {
        // The User model hashes passwordHash exactly once in its pre-save hook,
        // so assigning the plain password here stores a usable bcrypt hash.
        user.passwordHash = password;
      }
      user.isActive = true;
      await user.save();

      console.log(
        `Repaired demo account: ${email} ` +
          `(${hashIsUsable ? 'reactivated' : 'password reset'})`
      );
    }

    console.log('Default accounts ensured active and usable for login + export re-auth.');
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    process.exit(0);
  }
})();
