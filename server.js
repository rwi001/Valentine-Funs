const express = require('express');
const mongoose = require('mongoose');
const Razorpay = require('razorpay');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('.'));

// --- CONFIGURATION & FALLBACKS ---
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://<username>:<password>@cluster0.mongodb.net/valentineDB?retryWrites=true&w=majority";
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'YOUR_RAZORPAY_KEY_ID';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'YOUR_RAZORPAY_KEY_SECRET';

let useLocalStorage = false;
let razorpay = null;

// --- DATABASE CONNECTION ---
// CHECK FOR PLACEHOLDER OR INVALID URI TO PREVENT CRASH
if (!MONGO_URI || MONGO_URI.includes("cluster0.mongodb.net") || MONGO_URI.includes("<username>")) {
    console.log("⚠️  MongoDB Credentials Missing/Default. Switching to LOCAL (In-Memory) Mode.");
    useLocalStorage = true;
} else {
    // Only attempt connection if URI looks real
    mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
        .then(() => console.log('✅ MongoDB Connected'))
        .catch(err => {
            console.log("❌ MongoDB Connection Failed. Switching to LOCAL Mode.");
            // console.error(err.message); // Hide scary error
            useLocalStorage = true;
        });
}

// --- RAZORPAY SETUP ---
if (RAZORPAY_KEY_ID === 'YOUR_RAZORPAY_KEY_ID') {
    console.warn("⚠️  Razorpay Keys Missing. Payment verification will be MOCKED.");
} else {
    razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
}

// --- DATA MODELS (Dual Support) ---
// In-Memory Storage
const localUsers = [];
const localPayments = [];

// Mongoose Schemas (Only used if MongoDB connects)
const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    otp: { type: String },
    otpExpires: { type: Date },
    isVerified: { type: Boolean, default: false },
    paymentStatus: { type: String, default: 'pending' }
});
const PaymentSchema = new mongoose.Schema({
    orderId: String, paymentId: String, amount: Number, status: String, email: String, date: { type: Date, default: Date.now }
});

let User, Payment;
try {
    User = mongoose.model('User', UserSchema);
    Payment = mongoose.model('Payment', PaymentSchema);
} catch(e) {} // Ignore if already compiled

// --- HELPERS ---
async function findUser(email) {
    if (useLocalStorage) return localUsers.find(u => u.email === email);
    return await User.findOne({ email });
}

async function saveUser(userData) {
    if (useLocalStorage) {
        let existing = localUsers.find(u => u.email === userData.email);
        if (existing) Object.assign(existing, userData);
        else localUsers.push(userData);
        return userData;
    }
    // Mongoose
    let user = await User.findOne({ email: userData.email });
    if (!user) user = new User(userData);
    else Object.assign(user, userData);
    return await user.save();
}

async function savePayment(paymentData) {
    if (useLocalStorage) {
        localPayments.push(paymentData);
        return paymentData;
    }
    const payment = new Payment(paymentData);
    return await payment.save();
}

// --- API ROUTES ---

// 1. Send OTP
const nodemailer = require('nodemailer');

app.post('/api/send-otp', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email required' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 10 * 60 * 1000);

    try {
        await saveUser({ email, otp, otpExpires: expires });
        
        // --- REAL EMAIL SENDING ---
        if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            const transporter = nodemailer.createTransport({
                service: 'gmail', // Or 'hotmail', 'yahoo', etc.
                auth: {
                    user: process.env.EMAIL_USER,
                    pass: process.env.EMAIL_PASS
                }
            });

            const mailOptions = {
                from: `"Valentine App 💖" <${process.env.EMAIL_USER}>`,
                to: email,
                subject: 'Your Valentine Login Code 💌',
                html: `
                    <div style="font-family: Arial, sans-serif; color: #333; padding: 20px;">
                        <h2 style="color: #ff4d6d;">Here is your login code!</h2>
                        <p style="font-size: 16px;">Use this code to unlock your surprise:</p>
                        <h1 style="background: #ffe6eb; color: #d63384; padding: 10px; display: inline-block; letter-spacing: 5px; border-radius: 5px;">${otp}</h1>
                        <p>This code expires in 10 minutes.</p>
                        <p style="color: #888; font-size: 12px;">If you didn't request this, please ignore it.</p>
                    </div>
                `
            };

            await transporter.sendMail(mailOptions);
            console.log(`[📧 EMAIL SENT] To: ${email}`);
            res.json({ success: true, message: `OTP Sent to ${email}!` });
        } else {
            // Fallback to Console
            console.log(`\n\n[📨 OTP LOG] To: ${email} | Code: ${otp}\n(Add EMAIL_USER & EMAIL_PASS to .env for real emails)\n`);
            res.json({ success: true, message: 'OTP Logged to Console (Check Terminal)' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error / Email Failed' });
    }
});

// 2. Verify OTP
app.post('/api/verify-otp', async (req, res) => {
    const { email, otp } = req.body;
    try {
        let user = await findUser(email);
        if (!user) return res.status(400).json({ success: false, message: 'User not found' });

        // Local storage dates might be strings, handle conversion if needed
        const expiry = new Date(user.otpExpires);
        
        if (user.otp === otp && expiry > new Date()) {
            await saveUser({ email, isVerified: true, otp: null, otpExpires: null });
            res.json({ success: true, message: 'Login Success!', token: 'mock-jwt-token' });
        } else {
            res.status(400).json({ success: false, message: 'Invalid/Expired OTP' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// 3. Create Razorpay Order
app.post('/api/create-order', async (req, res) => {
    const { amount } = req.body;
    
    if (razorpay) {
        try {
            const order = await razorpay.orders.create({
                amount: amount * 100, currency: 'INR', receipt: 'receipt_' + Date.now()
            });
            res.json({ success: true, order });
        } catch (error) {
            res.status(500).json({ success: false, message: 'Razorpay Error' });
        }
    } else {
        // Mock Order
        res.json({ 
            success: true, 
            order: { 
                id: "order_mock_" + Date.now(), 
                amount: amount * 100, 
                currency: "INR" 
            },
            isMock: true // Signal frontend to skip Razorpay SDK if possible
        });
    }
});

// 4. Verify Payment
const crypto = require('crypto');
app.post('/api/verify-payment', async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, email } = req.body;

    let isValid = false;

    if (razorpay) {
        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', RAZORPAY_KEY_SECRET)
            .update(body.toString())
            .digest('hex');
        isValid = expectedSignature === razorpay_signature;
    } else {
        console.log("⚠️ Converting Mock Payment to Success...");
        isValid = true;
    }

    if (isValid) {
        await savePayment({
            orderId: razorpay_order_id, paymentId: razorpay_payment_id,
            amount: 499, status: 'success', email
        });
        await saveUser({ email, paymentStatus: 'success' });
        res.json({ success: true, message: 'Payment Verified' });
    } else {
        res.status(400).json({ success: false, message: 'Invalid Signature' });
    }
});

app.listen(PORT, () => {
    console.log(`\n✅ Server running on http://localhost:${PORT}`);
    if(useLocalStorage) console.log("📦 Mode: LOCAL STORAGE (Data will be lost on restart)");
});
