require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const OpenAI = require('openai');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const session = require('express-session');

app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'arabic-clinic-secret',
    resave: false,
    saveUninitialized: true
}));

const ACCESS_CODE = process.env.ACCESS_CODE || "123456";

const CLINIC_SYSTEM_PROMPT = `
Role: Professional Medical Clinic Assistant.
Goal: Manage patient appointments and clinic inquiries only.

Language Rules:
1. ALWAYS detect the language of the user and reply in the EXACT same language and script.
2. If the user writes in Arabic, reply in Arabic.
3. If the user writes in English, reply in English.
4. If the user writes in Roman characters (like Roman Urdu/English, e.g., 'mujhe doctor se milna hai'), reply in the same Roman script.

Filtering Rules (CRITICAL):
- If the user's message is a personal greeting, small talk, or completely unrelated to clinic services (e.g., "Hi", "How are you?", "What's up?", "Who built you?"), you MUST reply with ONLY the single word: IGNORE
- If the message is related to medical services, meeting the doctor, booking, rescheduling, or canceling an appointment, provide a professional response.

Clinic Tasks:
1. Welcome patients (only if they ask for clinic services).
2. Book new appointments: Ask for Name and Date/Time.
3. Reschedule or Cancel: Ask for details.
4. Confirm: Provide a clear confirmation message.

Safety: Do not provide any medical advice or diagnoses.
`;

let latestQR = null;
let isClientReady = false;
let qrReceived = false;
let currentClient = null;

function createClient() {
    const clientOptions = {
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ],
            executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable'
        }
    };

    const client = new Client(clientOptions);

    client.on('qr', async (qr) => {
        qrReceived = true;
        qrcode.toDataURL(qr, (err, url) => {
            latestQR = url;
            io.emit('qr', url);
            console.log('Arabic Bot QR Generated');
        });
    });

    client.on('ready', () => {
        isClientReady = true;
        latestQR = null;
        io.emit('ready');
        console.log('Clinic Bot is LIVE!');
    });

    client.on('authenticated', () => {
        console.log('WhatsApp Authenticated!');
    });

    client.on('auth_failure', (msg) => {
        console.error('Authentication failed:', msg);
        io.emit('pairing_error', 'فشل المصادقة - الرجاء المحاولة مرة أخرى');
    });

    client.on('disconnected', (reason) => {
        console.log('Client disconnected:', reason);
        isClientReady = false;
        qrReceived = false;
    });

    return client;
}

currentClient = createClient();

// Socket.IO connection handler for pairing code and state sync
io.on('connection', (socket) => {
    // Send current state to newly connected clients
    if (isClientReady) {
        socket.emit('ready');
    } else if (latestQR) {
        socket.emit('qr', latestQR);
    }

    // Handle pairing code request from dashboard
    socket.on('request_pairing_code', async (phoneNumber) => {
        try {
            const cleanNumber = phoneNumber.replace(/[\s\-\+]/g, '');
            console.log(`[Pairing Code] Requesting for number: ${cleanNumber}`);

            if (!qrReceived) {
                socket.emit('pairing_error', 'الرجاء الانتظار قليلاً حتى يظهر رمز QR أولاً، ثم حاول مرة أخرى');
                return;
            }

            // Ensure the page is actually ready
            try {
                await currentClient.pupPage.waitForSelector('canvas', { timeout: 5000 });
            } catch (e) {
                console.log('Waiting for canvas...');
            }

            let code = null;
            let lastError = null;

            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    console.log(`[Pairing Code] Attempt ${attempt}...`);
                    code = await currentClient.requestPairingCode(cleanNumber);
                    if (code) break;
                } catch (err) {
                    lastError = err;
                    console.error(`[Pairing Code] Attempt ${attempt} failed:`, err);
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
            }

            if (code) {
                console.log(`[Pairing Code] Code generated: ${code}`);
                socket.emit('pairing_code', code);
            } else {
                let errMsg = 'فشل الحصول على الرمز. يرجى المحاولة لاحقاً.';
                if (lastError) {
                    errMsg = typeof lastError === 'string' ? lastError : (lastError.message || JSON.stringify(lastError));
                }
                socket.emit('pairing_error', errMsg);
            }
        } catch (error) {
            console.error('[Pairing Code Error]', error);
            socket.emit('pairing_error', 'حدث خطأ: ' + (error.message || 'يرجى المحاولة مرة أخرى'));
        }
    });
});

const startTime = Math.floor(Date.now() / 1000);

currentClient.on('message', async (msg) => {
    if (msg.from.includes('@g.us')) return;
    if (msg.timestamp < startTime) return;

    console.log(`[New Message] From: ${msg.from}, Body: ${msg.body}`);

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: CLINIC_SYSTEM_PROMPT },
                { role: "user", content: msg.body }
            ]
        });

        const reply = response.choices[0].message.content.trim();

        if (reply.toUpperCase() === 'IGNORE') {
            console.log(`[Filtering] Personal chat from ${msg.from}. Ignored.`);
            return;
        }

        await msg.reply(reply);
        io.emit('activity', { from: msg.from, body: msg.body, reply: reply });

    } catch (error) {
        console.error('AI Error:', error.message);
    }
});

app.get('/', (req, res) => {
    if (req.session.authorized) {
        res.sendFile(__dirname + '/dashboard.html');
    } else {
        res.send(`
            <html dir="rtl" lang="ar">
            <head>
                <meta charset="UTF-8">
                <title>تسجيل الدخول - العيادة</title>
                <style>
                    @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;700&display=swap');
                    body { font-family: 'Cairo', sans-serif; background: #004d40; height: 100vh; display: flex; align-items: center; justify-content: center; margin: 0; color: white; }
                    .login-box { background: white; color: #333; padding: 40px; border-radius: 15px; box-shadow: 0 10px 25px rgba(0,0,0,0.3); text-align: center; width: 350px; }
                    input { width: 100%; padding: 12px; margin: 20px 0; border: 1px solid #ddd; border-radius: 8px; box-sizing: border-box; font-size: 16px; text-align: center; }
                    button { width: 100%; padding: 12px; background: #00796b; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 18px; font-weight: bold; }
                    button:hover { background: #004d40; }
                    h2 { margin-top: 0; color: #004d40; }
                </style>
            </head>
            <body>
                <div class="login-box">
                    <h2>🔒 دخول النظام</h2>
                    <form action="/login" method="POST">
                        <input type="password" name="code" placeholder="أدخل رمز الدخول" required>
                        <button type="submit">دخول</button>
                    </form>
                    \${req.query.error ? '<p style="color:red">الرمز غير صحيح!</p>' : ''}
                </div>
            </body>
            </html>
        `);
    }
});

app.post('/login', (req, res) => {
    if (req.body.code === ACCESS_CODE) {
        req.session.authorized = true;
        res.redirect('/');
    } else {
        res.redirect('/?error=1');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

currentClient.initialize();
server.listen(3000, () => {
    console.log('Clinic System Running on port 3000');
});
