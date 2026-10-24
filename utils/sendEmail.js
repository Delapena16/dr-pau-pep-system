
const nodemailer = require('nodemailer');

const sendOTP = async (email, otp) => {
  const gmailUser = process.env.GMAIL_USER;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;

  if (!gmailUser || !gmailAppPassword) {
    throw new Error(
      'Missing GMAIL_USER or GMAIL_APP_PASSWORD in .env'
    );
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: gmailUser,
      pass: gmailAppPassword.replace(/\s/g, '')
    }
  });

  await transporter.verify();

  const info = await transporter.sendMail({
    from: `"Dr. Pau ABTC" <${gmailUser}>`,
    to: email,
    subject: 'Your OTP Verification Code',
    text: `Your OTP verification code is ${otp}. It expires in 5 minutes. Do not share this code with anyone.`,
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>OTP Verification</h2>
        <p>Your verification code is:</p>
        <h1 style="letter-spacing: 6px;">${otp}</h1>
        <p>This code expires in 5 minutes.</p>
        <p>Do not share this code with anyone.</p>
      </div>
    `
  });

  console.log('OTP email sent:', info.messageId);

  return true;
};

module.exports = sendOTP;
