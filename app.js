const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
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

let clientStatus = 'initializing';
let clientStatusMessage = 'Sedang memulai WhatsApp client...';
let lastQRUrl = '';
let sock = null;
let isConnecting = false;

const AUTH_FOLDER = path.join(__dirname, 'baileys_auth');

// Broadcast status ke semua socket terhubung
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

// Fungsi membuat dan menghubungkan client Baileys
async function connectToWhatsApp() {
    if (isConnecting) return;
    isConnecting = true;

    try {
        console.log('🔄 Initializing Baileys WhatsApp client...');
        broadcastStatus('initializing', 'Menyiapkan sesi WhatsApp...');

        // Pastikan folder auth siap
        await fs.ensureDir(AUTH_FOLDER);
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

        let version = [2, 3000, 1015901307];
        try {
            const fetched = await fetchLatestBaileysVersion();
            version = fetched.version;
            console.log(`📱 Baileys version: v${version.join('.')}, isLatest: ${fetched.isLatest}`);
        } catch (e) {
            console.warn('⚠️ Could not fetch latest WA version, using fallback:', e.message);
        }

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: state,
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000
        });

        // Simpan credentials saat terupdate
        sock.ev.on('creds.update', saveCreds);

        // Pantau perubahan koneksi
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('📱 QR code diterima dari Baileys, mengonversi ke gambar...');
                try {
                    lastQRUrl = await qrcode.toDataURL(qr);
                    console.log('✅ QR Code berhasil dibuat, broadcasting...');
                    broadcastStatus('qr', 'Silakan scan QR code dengan WhatsApp');
                } catch (err) {
                    console.error('❌ Gagal menghasilkan QR data URL:', err);
                    broadcastStatus('error', 'Gagal membuat gambar QR: ' + err.message);
                }
            }

            if (connection === 'connecting') {
                console.log('⏳ Sedang menghubungkan ke server WhatsApp...');
                broadcastStatus('loading', 'Sedang menghubungkan ke server WhatsApp...');
            }

            if (connection === 'open') {
                console.log('✅✅✅ WHATSAPP IS CONNECTED & READY! ✅✅✅');
                lastQRUrl = '';
                isConnecting = false;
                const phone = sock.user?.id ? sock.user.id.split(':')[0] : 'WhatsApp User';
                const name = sock.user?.name || phone;
                broadcastStatus('ready', `WhatsApp terhubung sebagai ${name} (${phone})! Siap digunakan.`);
            }

            if (connection === 'close') {
                isConnecting = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const errorDetail = lastDisconnect?.error?.message || lastDisconnect?.error || 'Koneksi terputus';
                console.log(`🔌 Koneksi WhatsApp tertutup. StatusCode: ${statusCode}, Detail: ${errorDetail}`);

                if (statusCode === DisconnectReason.loggedOut) {
                    console.log('🚪 WhatsApp di-logout dari perangkat. Membersihkan sesi...');
                    broadcastStatus('disconnected', 'Client was logged out. Memuat ulang QR code...');
                    try {
                        await fs.remove(AUTH_FOLDER);
                    } catch (e) {
                        console.error('Gagal menghapus folder sesi:', e);
                    }
                    setTimeout(() => {
                        connectToWhatsApp();
                    }, 3000);
                } else {
                    console.log('🔄 Reconnecting WhatsApp dalam 4 detik...');
                    broadcastStatus('loading', 'Koneksi terputus sesaat. Menghubungkan ulang...');
                    setTimeout(() => {
                        connectToWhatsApp();
                    }, 4000);
                }
            }
        });

        // Event pesan masuk (opsional log)
        sock.ev.on('messages.upsert', async (m) => {
            const msg = m.messages && m.messages[0];
            if (msg && !msg.key.fromMe && m.type === 'notify') {
                const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
                console.log('💬 Pesan masuk dari:', msg.key.remoteJid, '-', text);
            }
        });

    } catch (err) {
        isConnecting = false;
        console.error('❌ Fatal error initializing Baileys:', err);
        broadcastStatus('error', 'Gagal menginisialisasi WhatsApp client: ' + err.message);
        setTimeout(() => {
            connectToWhatsApp();
        }, 8000);
    }
}

// Mulai koneksi
connectToWhatsApp();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Endpoint API Kirim Pesan
const api = async (req, res) => {
    console.log('📩 API Request received:', req.method, req.query, req.body);

    let nohp = req.query.nohp || req.query.number || req.body.nohp || req.body.number;
    const pesan = req.query.pesan || req.query.message || req.body.pesan || req.body.message;

    try {
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

        // Cek kesiapan client Baileys
        const isReady = clientStatus === 'ready' && sock && sock.user;
        if (!isReady) {
            console.error('❌ Client not ready. Status:', clientStatus);
            return res.status(503).json({ 
                status: "error", 
                pesan: "WhatsApp client belum siap. Silakan scan QR code terlebih dahulu.",
                debug: {
                    clientStatus,
                    hasSock: !!sock,
                    isConnected: clientStatus === 'ready'
                }
            });
        }

        // Bersihkan dan format nomor telepon
        let cleanNumber = String(nohp).replace(/[^0-9]/g, '');
        if (cleanNumber.startsWith('0')) {
            cleanNumber = '62' + cleanNumber.slice(1);
        }

        const jid = cleanNumber + '@s.whatsapp.net';
        const messageText = String(pesan).trim();
        console.log('📱 Mengirim ke JID:', jid);

        // Cek apakah nomor terdaftar di WhatsApp
        console.log('🔍 Checking if number is registered...');
        const [result] = await sock.onWhatsApp(cleanNumber);

        if (result && result.exists) {
            console.log('✅ Number registered, sending message to:', result.jid);
            await sock.sendMessage(result.jid, { text: messageText });
            console.log('✅ Message sent successfully!');
            res.json({ 
                status: "berhasil terkirim", 
                pesan: messageText,
                to: result.jid 
            });
        } else {
            console.log('⚠️ Number not registered on WhatsApp:', cleanNumber);
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
            detail: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// Route API
app.post('/api', api);
app.get('/api', api);

// Route halaman utama (UI)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Helper kirim status saat ini ke socket
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
    sendCurrentStatus(socket);

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
            engine: 'baileys',
            status: clientStatus,
            message: clientStatusMessage,
            user: sock?.user || null,
            timestamp: new Date().toISOString()
        }
    });
});

// Global error handlers
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
