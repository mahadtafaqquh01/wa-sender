const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const CLIENT_ID = process.env.WA_CLIENT_ID || "YOUR_CLIENT_ID";
let clientStatus = 'initializing';
let clientStatusMessage = 'Sedang memulai WhatsApp client...';
let lastQRUrl = '';
let client = null; // Pastikan initialized

// Fungsi untuk rename & delete directory dengan retry
const renameAndDeleteDirectory = async (directoryPath, retries = 10, delay = 2000) => {
    const tempDirPath = directoryPath + '_temp';
    
    for (let i = 0; i < retries; i++) {
        try {
            if (fs.existsSync(directoryPath)) {
                await fs.rename(directoryPath, tempDirPath);
            }
            if (fs.existsSync(tempDirPath)) {
                await fs.remove(tempDirPath);
            }
            return;
        } catch (err) {
            if (err.code === 'EBUSY' && i < retries - 1) {
                console.warn(`🔄 File is busy, retrying (${i + 1}/${retries})...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                console.error(`❌ Failed to delete directory after ${i + 1} attempts:`, err);
                throw err;
            }
        }
    }
};

// Fungsi untuk broadcast status ke semua socket
const broadcastStatus = (status, message, extra = {}) => {
    clientStatus = status;
    clientStatusMessage = message;
    console.log(`📢 Broadcasting status: [${status}] - ${message}`);
    io.emit('status', { status, message, ...extra });
    
    if (status === 'ready') {
        io.emit('ready', message);
    } else if (status === 'qr') {
        io.emit('qr', lastQRUrl);
    } else if (status === 'error') {
        io.emit('client_error', { message, ...extra });
    } else if (status === 'disconnected') {
        io.emit('disconnected', message);
    } else {
        io.emit('loading', message);
    }
};

// Fungsi membuat client WhatsApp
const createClient = () => {
    console.log('🔄 Creating new WhatsApp client...');
    broadcastStatus('initializing', 'Sedang menyiapkan browser dan WhatsApp client...');
    
    const puppeteerArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-extensions'
    ];

    const puppeteerConfig = {
        headless: true,
        args: puppeteerArgs
    };

    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        puppeteerConfig.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    const newClient = new Client({
        authStrategy: new LocalAuth({
            clientId: CLIENT_ID,
            dataPath: "./.wwebjs_auth"
        }),
        puppeteer: puppeteerConfig,
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
        },
        qrMaxRetries: 5,
        restartOnAuthFail: true
    });

    // Event: QR Code
    newClient.on('qr', (qr) => {
        console.log('📱 QR Code received, generating data URL...');
        qrcode.toDataURL(qr, (err, url) => {
            if (err) {
                console.error('❌ Failed to generate QR code:', err);
                broadcastStatus('error', 'Gagal memproses QR code: ' + err.message);
                return;
            }
            lastQRUrl = url;
            console.log('✅ QR Code generated, broadcasting...');
            broadcastStatus('qr', 'Silakan scan QR code');
        });
    });

    // Event: Loading
    newClient.on('loading_screen', (percent, message) => {
        console.log(`⏳ Loading: ${percent}% - ${message}`);
        broadcastStatus('loading', `Loading WhatsApp: ${percent}% - ${message || ''}`);
    });

    // Event: Authenticated
    newClient.on('authenticated', () => {
        console.log('✅ Client authenticated!');
        broadcastStatus('loading', 'Autentikasi berhasil! Sedang memuat data WhatsApp...');
    });

    // Event: Auth Failure
    newClient.on('auth_failure', (msg) => {
        console.error('❌ Authentication failure:', msg);
        broadcastStatus('error', 'Autentikasi gagal. Silakan muat ulang dan scan QR kembali.');
    });

    // Event: Ready
    newClient.on('ready', () => {
        console.log('✅✅✅ CLIENT IS READY! ✅✅✅');
        broadcastStatus('ready', 'WhatsApp terhubung dan siap digunakan!');
        lastQRUrl = '';
        
        setTimeout(async () => {
            try {
                const info = await newClient.info;
                console.log('📱 WhatsApp Info:', info);
            } catch (err) {
                console.error('⚠️ Could not get client info:', err);
            }
        }, 1000);
    });

    // Event: Disconnected
    newClient.on('disconnected', async (reason) => {
        console.log('🔌 Client disconnected:', reason);
        const isLogout = reason === 'LOGOUT' || String(reason).toUpperCase().includes('LOGOUT');
        const disconnectMsg = isLogout ? 'Client was logged out' : `Client terputus (${reason || 'koneksi terputus'})`;
        broadcastStatus('disconnected', disconnectMsg);

        try {
            await newClient.destroy();

            if (isLogout) {
                const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-${CLIENT_ID}`);
                if (fs.existsSync(sessionPath)) {
                    console.log('🗑️ Cleaning up session folder after logout...');
                    await renameAndDeleteDirectory(sessionPath);
                }

            }
        } catch (error) {
            console.error('❌ Error during cleanup:', error);
        }

        // Reinitialize setelah delay - createClient() otomatis panggil initialize()
        setTimeout(() => {
            console.log('🔄 Reinitializing client...');
            client = createClient();
        }, 8000);
    });

    // Event: Change State
    newClient.on('change_state', (state) => {
        console.log('📊 WhatsApp state changed to:', state);
        if (state === 'CONNECTED' || state === 'BREAKPOINT') {
            if (clientStatus !== 'ready') {
                console.log('⚠️ State is CONNECTED but ready event did not fire. Forcing status update...');
                broadcastStatus('ready', 'WhatsApp terhubung dan siap digunakan!');
            }
        }
    });

    // Event: Change Battery
    newClient.on('change_battery', (batteryInfo) => {
        const { battery, plugged } = batteryInfo;
        console.log(`🔋 Battery: ${battery}% | Charging: ${plugged}`);
    });

    // Event: Message
    newClient.on('message', (message) => {
        console.log('💬 Message received:', message.body);
    });

    console.log('📱 Initializing client...');
    newClient.initialize().catch((err) => {
        console.error('❌ Gagal menginisialisasi WhatsApp Client:', err);
        const errMsg = err && err.message ? err.message : String(err);
        let helpText = 'Gagal menjalankan browser Puppeteer.';
        if (errMsg.includes('error while loading shared libraries') || errMsg.includes('Could not find Chromium') || errMsg.includes('Failed to launch')) {
            helpText = 'Chromium gagal berjalan di server. Pastikan dependensi Linux (libnss3, libasound2, dsb) telah terpasang di VPS Hostinger Anda.';
        }
        broadcastStatus('error', `${helpText} (${errMsg})`, { detail: errMsg });
    });
    
    return newClient;
};

// Inisialisasi client pertama kali
client = createClient();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API Endpoint - PERBAIKAN VALIDASI
const api = async (req, res) => {
    console.log('📩 API Request received:', req.method, req.query, req.body);
    
    // Terima berbagai format parameter
    let nohp = req.query.nohp || req.query.number || req.body.nohp || req.body.number;
    const pesan = req.query.pesan || req.query.message || req.body.pesan || req.body.message;

    try {
        // Validasi input - PERBAIKAN DI SINI
        if (!nohp) {
            return res.status(400).json({ 
                status: "error", 
                pesan: "Parameter 'nohp' atau 'number' wajib diisi" 
            });
        }
        
        if (!pesan) {
            return res.status(400).json({ 
                status: "error", 
                pesan: "Parameter 'pesan' atau 'message' wajib diisi" 
            });
        }

        // Konversi ke string dan trim
        nohp = String(nohp).trim();
        const messageText = String(pesan).trim();

        // Format nomor WhatsApp
        let formattedNumber = nohp;
        if (nohp.startsWith('0')) {
            formattedNumber = '62' + nohp.slice(1);
        } else if (nohp.startsWith('+')) {
            formattedNumber = nohp.slice(1);
        }
        
        // Pastikan ada @c.us
        if (!formattedNumber.includes('@c.us')) {
            formattedNumber = formattedNumber + '@c.us';
        }

        console.log('📱 Formatted number:', formattedNumber);

        // Cek status client - PERBAIKAN LOGIC
        if (!client) {
            console.error('❌ Client is null!');
            return res.status(503).json({ 
                status: "error", 
                pesan: "WhatsApp client tidak terinisialisasi" 
            });
        }

        // Cek apakah client ready dengan multiple methods
        const isReady = clientStatus === 'ready' && client.info;
        
        if (!isReady) {
            console.error('❌ Client not ready. Status:', clientStatus, 'Info:', client.info);
            return res.status(503).json({ 
                status: "error", 
                pesan: "WhatsApp client belum siap. Silakan scan QR code terlebih dahulu.",
                debug: {
                    clientStatus,
                    hasInfo: !!client.info,
                    isConnected: clientStatus === 'ready'
                }
            });
        }

        // Cek apakah nomor terdaftar di WhatsApp
        console.log('🔍 Checking if number is registered...');
        const user = await client.isRegisteredUser(formattedNumber);

        if (user) {
            console.log('✅ Number registered, sending message...');
            await client.sendMessage(formattedNumber, messageText);
            console.log('✅ Message sent successfully!');
            res.json({ 
                status: "berhasil terkirim", 
                pesan: messageText,
                to: formattedNumber 
            });
        } else {
            console.log('⚠️ Number not registered on WhatsApp');
            res.json({ 
                status: "gagal terkirim", 
                pesan: 'nomor wa tidak terdaftar' 
            });
        }
    } catch (error) {
        console.error('❌ API Error:', error);
        res.status(500).json({ 
            status: 'error', 
            pesan: 'server error',
            detail: process.env.NODE_ENV === 'development' ? error.message : undefined,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};

// Route API
app.post('/api', api);
app.get('/api', api);

// Route halaman utama
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Helper untuk kirim status saat ini ke socket tertentu
const sendCurrentStatus = (target) => {
    target.emit('status', { 
        status: clientStatus, 
        message: clientStatusMessage,
        hasQR: !!lastQRUrl
    });

    if (clientStatus === 'ready') {
        target.emit('ready', clientStatusMessage);
    } else if (clientStatus === 'qr' && lastQRUrl) {
        target.emit('qr', lastQRUrl);
    } else if (clientStatus === 'error') {
        target.emit('client_error', { message: clientStatusMessage });
    } else if (clientStatus === 'disconnected') {
        target.emit('disconnected', clientStatusMessage);
    } else {
        target.emit('loading', clientStatusMessage);
    }
};

// Socket.IO Connection Handler
io.on('connection', (socket) => {
    console.log('🔗 Socket connected:', socket.id);

    // Kirim status saat koneksi baru
    sendCurrentStatus(socket);

    // Handler untuk request status dari frontend
    socket.on('checkStatus', () => {
        console.log('📋 checkStatus requested by:', socket.id);
        sendCurrentStatus(socket);
    });

    socket.on('disconnect', () => {
        console.log('🔌 Socket disconnected:', socket.id);
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        whatsapp: {
            status: clientStatus,
            message: clientStatusMessage,
            hasClient: !!client,
            hasInfo: client ? !!client.info : false,
            timestamp: new Date().toISOString()
        }
    });
});

// Error handling global
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
});

// Start Server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
    console.log(`🌐 Open http://localhost:${PORT} to scan QR code`);
    console.log(`🔍 Health check: http://localhost:${PORT}/health`);
});
