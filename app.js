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

let clientStatus = 'not ready';
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
const broadcastStatus = (status, message) => {
    clientStatus = status;
    console.log(`📢 Broadcasting status: ${status} - ${message}`);
    io.emit('status', { status, message });
    
    if (status === 'ready') {
        io.emit('ready', message);
    } else if (status === 'qr') {
        io.emit('qr', lastQRUrl);
    } else {
        io.emit('disconnected', message);
    }
};



// Fungsi membuat client WhatsApp
const createClient = () => {
    console.log('🔄 Creating new WhatsApp client...');
    
    const newClient = new Client({
        authStrategy: new LocalAuth({
            clientId: "YOUR_CLIENT_ID", // Ganti dengan ID unik Anda
            dataPath: "./.wwebjs_auth"
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
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
        broadcastStatus('loading', `Loading: ${percent}%`);
    });

    // Event: Authenticated
    newClient.on('authenticated', () => {
        console.log('✅ Client authenticated!');
    });

    // Event: Auth Failure
    newClient.on('auth_failure', (msg) => {
        console.error('❌ Authentication failure:', msg);
        broadcastStatus('not ready', 'Authentication failed. Please scan QR again.');
    });

    // Event: Ready - GUNAKAN 'on' BUKAN 'once'
    newClient.on('ready', () => {
        console.log('✅✅✅ CLIENT IS READY! ✅✅✅');
        broadcastStatus('ready', 'WhatsApp terhubung dan siap digunakan!');
        lastQRUrl = '';
        
        // Verifikasi bahwa client benar-benar ready
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
        broadcastStatus('not ready', 'Client was logged out');

        try {
            await newClient.destroy();
            const sessionPath = path.join(__dirname, '.wwebjs_auth', 'session-YOUR_CLIENT_ID');
            
            if (fs.existsSync(sessionPath)) {
                console.log('🗑️ Cleaning up session...');
                await renameAndDeleteDirectory(sessionPath);
            }
        } catch (error) {
            console.error('❌ Error during cleanup:', error);
        }

        // Reinitialize setelah delay
        setTimeout(() => {
            console.log('🔄 Reinitializing client...');
            client = createClient();
            client.initialize();
        }, 10000);
    });

    // Event: Change State - TAMBAHKAN INI
    newClient.on('change_state', (state) => {
        console.log('📊 WhatsApp state changed to:', state);
        if (state === 'CONNECTED' || state === 'BREAKPOINT') {
            // Double check - jika ready event tidak firing
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
    newClient.initialize();
    
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

// Socket.IO Connection Handler
io.on('connection', (socket) => {
    console.log('🔗 Socket connected:', socket.id);

    // Kirim status saat koneksi baru
    if (clientStatus === 'ready') {
        socket.emit('ready', 'Client is ready!');
        socket.emit('status', { status: 'ready', message: 'WhatsApp terhubung!' });
    } else if (clientStatus === 'qr') {
        socket.emit('qr', lastQRUrl);
        socket.emit('status', { status: 'qr', message: 'Silakan scan QR code' });
    } else {
        socket.emit('disconnected', 'Client was logged out');
        socket.emit('status', { status: 'not ready', message: 'Client was logged out' });
    }

    // Handler untuk request status dari frontend
    socket.on('checkStatus', () => {
        console.log('📋 checkStatus requested by:', socket.id);
        if (clientStatus === 'ready') {
            socket.emit('ready', 'Client is ready!');
            socket.emit('status', { status: 'ready', message: 'WhatsApp terhubung!' });
        } else if (clientStatus === 'qr') {
            socket.emit('qr', lastQRUrl);
            socket.emit('status', { status: 'qr', message: 'Silakan scan QR code' });
        } else {
            socket.emit('disconnected', 'Client was logged out');
            socket.emit('status', { status: 'not ready', message: 'Client was logged out' });
        }
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