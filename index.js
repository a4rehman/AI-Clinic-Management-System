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

const ARABIC_SYSTEM_PROMPT = `
أنت مساعد آلي محترف لعيادة طبية. مهمتك الوحيدة هي إدارة مواعيد المرضى.
يجب أن تتواصل باللغة العربية الفصحى أو اللهجة البيضاء المحترمة فقط.
المهام المطلوبة منك:
1. الترحيب بالمرضى.
2. حجز موعد جديد: اطلب الاسم والتاريخ المفضل.
3. تعديل أو إلغاء موعد: اطلب تفاصيل الموعد الحالي.
4. التأكيد: أكد الموعد النهائي بإرسال رسالة تأكيد واضحة.

ملاحظات هامة:
- لا تقدم أي نصائح طبية أو تشخيصات.
- إذا سأل المريض عن شيء خارج المواعيد، اعتذر بأدب وجهه للاتصال بالعيادة مباشرة.
- يجب أن تكون ردودك قصيرة، واضحة، ومهنية للغاية باللغة العربية فقط.
`;

const client = new Client({
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
});

let latestQR = null;
let isClientReady = false;

client.on('qr', (qr) => {
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
            // Remove any +, spaces, dashes from the number
            const cleanNumber = phoneNumber.replace(/[\s\-\+]/g, '');
            console.log(`[Pairing Code] Requesting for number: ${cleanNumber}`);
            const code = await client.requestPairingCode(cleanNumber);
            console.log(`[Pairing Code] Code generated: ${code}`);
            socket.emit('pairing_code', code);
        } catch (error) {
            console.error('[Pairing Code Error]', error.message);
            socket.emit('pairing_error', error.message);
        }
    });
});

const startTime = Math.floor(Date.now() / 1000);

client.on('message', async (msg) => {
    // 1. Ignore if it's a group message
    if (msg.from.includes('@g.us')) return;

    // 2. Ignore messages that were received before the bot started
    if (msg.timestamp < startTime) {
        console.log(`[Ignoring Old Message] From: ${msg.from}`);
        return;
    }

    console.log(`[New Message] From: ${msg.from}, Body: ${msg.body}`);

    try {
        console.log('Sending request to OpenAI...');
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: ARABIC_SYSTEM_PROMPT },
                { role: "user", content: msg.body }
            ]
        });

        const reply = response.choices[0].message.content;
        await msg.reply(reply);
        console.log(`[AI Reply] To: ${msg.from}, Content: ${reply}`);

        // Log to dashboard activity
        io.emit('activity', { from: msg.from, body: msg.body, reply: reply });

    } catch (error) {
        console.error('AI Error:', error.message);
        if (error.message.includes('api_key')) {
            console.error('CRITICAL: Your OpenAI API key is invalid or has expired.');
        }
    }
});

// Basic Dashboard Route with Arabic Login
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
                    ${req.query.error ? '<p style="color:red">الرمز غير صحيح!</p>' : ''}
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

client.initialize();
server.listen(3000, () => {
    console.log('Clinic System Running on port 3000');
});
