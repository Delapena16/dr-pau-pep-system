const dns = require('dns');
// Set DNS servers BEFORE requiring mongoose to ensure SRV resolution works
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (dnsErr) {
  // dito banda ignore lang pag di pinayagan ng windows
}
const mongoose = require('mongoose');

mongoose.connection.on('error', (err) => {
  console.warn('MongoDB connection runtime warning:', err.message);
});

const connectToDatabase = async () => {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/dr_pau_pep_db';
    mongoose.set('strictQuery', true);

    // Add a timeout to prevent hanging
    const connectPromise = mongoose.connect(mongoUri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 10000,
      autoIndex: true
    });

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Connection timeout after 8 seconds')), 8000);
    });

    await Promise.race([connectPromise, timeoutPromise]);

    console.log('Connected to Dr. Pau MongoDB database');
  } catch (error) {
    console.warn('MongoDB connection warning: ' + error.message);
    console.warn('Running with in-memory clinic store until MongoDB is reachable.');
  }
};

process.on('SIGINT', async () => {
  await mongoose.connection.close();
  console.log('MongoDB connection closed');
  process.exit(0);
});

module.exports = connectToDatabase;
