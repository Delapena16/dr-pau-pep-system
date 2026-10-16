/**
 * ============================================================================
 * FILE: config/db.js
 * ARCHITECTURAL LAYER: Configuration Layer (Database Connection Manager)
 * ============================================================================
 * PURPOSE WITHIN MVC ARCHITECTURE:
 * This module manages the connection between our Express.js application and
 * MongoDB using Mongoose. It centralizes connection pooling, timeout protection,
 * and automatic index creation so our Models (User, Patient, Inventory, AuditLog)
 * can perform fast, predictable queries.
 *
 * ACADEMIC DEFENSE TALKING POINTS:
 * 1. Connection Pooling (maxPoolSize: 10): Allows multiple clinic staff (Receptionist,
 *    Physician, SuperAdmin) to query patient records simultaneously without
 *    opening a costly new TCP connection on every HTTP request.
 * 2. Strict Field Indexing (autoIndex: true): Ensures all compound and single-field
 *    indexes defined in our schemas are built automatically for O(log n) lookups.
 * 3. Graceful Shutdown: Safely closes database connections if the Node.js server
 *    is stopped, preventing corrupted clinical write operations.
 * ============================================================================
 */

const mongoose = require('mongoose');

/**
 * Establishes an asynchronous connection to the MongoDB database.
 * @returns {Promise<void>}
 */
const connectToDatabase = async () => {
  try {
    const mongoConnectionUri =
      process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/dr_pau_pep_db';

    // StrictQuery prevents Mongoose from allowing filter fields that are not
    // explicitly declared in our Schema—an extra layer of defense against NoSQL injection.
    mongoose.set('strictQuery', true);

    const connectionInstance = await mongoose.connect(mongoConnectionUri, {
      maxPoolSize: 10, // Maintain up to 10 concurrent socket connections
      serverSelectionTimeoutMS: 5000, // Fail fast (5 seconds) if MongoDB is unreachable
      socketTimeoutMS: 45000, // Close inactive sockets after 45 seconds
      autoIndex: true, // Build schema indexes for fast patient & inventory queries
    });

    console.log(
      `[MongoDB Connected] Host: ${connectionInstance.connection.host} | Database: ${connectionInstance.connection.name}`
    );
  } catch (databaseError) {
    console.error(
      `[MongoDB Connection Error] Failed to connect to database: ${databaseError.message}`
    );
    console.warn(
      '[Fallback Notice] Ensure MongoDB service (mongod) is running locally or update MONGO_URI in .env'
    );
  }
};

// Monitor ongoing connection events for operational visibility
mongoose.connection.on('disconnected', () => {
  console.warn('[MongoDB Notice] Database connection was disconnected.');
});

// Gracefully close the MongoDB connection when the Node process terminates (Ctrl+C)
process.on('SIGINT', async () => {
  await mongoose.connection.close();
  console.log('[MongoDB Closed] Database connection closed due to app termination.');
  process.exit(0);
});

module.exports = connectToDatabase;
