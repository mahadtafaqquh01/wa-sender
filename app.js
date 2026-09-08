const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
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

const SESSION_DIR = path.join(__dirname, 'auth_info_baileys');

let clientStatus = 'initializing';
let clientStatusMessage = 'Sedang memulai WhatsApp client (Baileys)...';
let lastQRUrl = '';
let sock = null;
let isConnecting = false;
let reconnectTimeout = null;

// Fungsi untuk broadcast status ke semua socket client
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

// Inisialisasi koneksi Baileys
const connectToWhatsApp = async () => {
    // Batalkan timeout reconnect yang sedang berjalan jika ada
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }

    // Bersihkan instance socket lama jika ada
    if (sock) {
        try {
            sock.ev.removeAllListeners();
            sock.end();
        } catch (e) {}
        sock = null;
    }

    if (isConnecting) {
        console.log('⚠️ Inisialisasi koneksi sedang berjalan, lewati panggilan duplikat.');
        return;
    }
    isConnecting = true;

    try {
        console.log('🔄 Memulai WhatsApp client (Baileys)...');
        broadcastStatus('initializing', 'Sedang menyiapkan sesi WhatsApp Baileys...');

        await fs.ensureDir(SESSION_DIR);
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

        let version;
        try {
            const versionInfo = await fetchLatestBaileysVersion();
            version = versionInfo.version;
            console.log(`📦 Menggunakan Baileys Web Version: ${version.join('.')}`);
        } catch (err) {
            console.warn('⚠️ Gagal mengambil versi terbaru Baileys, menggunakan versi default.', err.message);
        }

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: state,
            browser: ['WhatsApp Sender', 'Chrome', '1.0.0'],
            syncFullHistory: false,
            generateHighQualityLinkPreview: true
        });

        // Simpan pembaruan kredensial
        sock.ev.on('creds.update', saveCreds);

        // Pantau pembaruan koneksi
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('📱 QR Code diterima dari Baileys, membuat Data URL...');
                try {
                    qrcodeTerminal.generate(qr, { small: true });
                } catch (e) {}

                qrcode.toDataURL(qr, (err, url) => {
                    if (err) {
                        console.error('❌ Gagal membuat QR Data URL:', err);
                        broadcastStatus('error', 'Gagal memproses QR code: ' + err.message);
                        return;
                    }
                    lastQRUrl = url;
                    console.log('✅ QR Code berhasil dibuat, broadcasting ke web...');
                    broadcastStatus('qr', 'Silakan scan QR code dengan WhatsApp Anda');
                });
            }

            if (connection === 'connecting') {
                console.log('⏳ Sedang menghubungkan ke server WhatsApp...');
                if (clientStatus !== 'qr') {
                    broadcastStatus('loading', 'Sedang menghubungkan ke server WhatsApp...');
                }
            } else if (connection === 'open') {
                console.log('✅✅✅ CLIENT IS READY! (Baileys) ✅✅✅');
                lastQRUrl = '';
                if (reconnectTimeout) {
                    clearTimeout(reconnectTimeout);
                    reconnectTimeout = null;
                }
                broadcastStatus('ready', 'WhatsApp terhubung dan siap digunakan!');
                if (sock && sock.user) {
                    console.log('📱 WhatsApp Info:', sock.user);
                }
            } else if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLogout = statusCode === DisconnectReason.loggedOut;
                const isConflict = statusCode === DisconnectReason.connectionReplaced;
                const reason = lastDisconnect?.error?.message || statusCode || 'Koneksi terputus';

                console.log(`🔌 Koneksi terputus. Status Code: ${statusCode}, Alasan: ${reason}`);

                if (isConflict) {
                    console.warn('⚠️ Konflik sesi (Code 440): Sesi ini sedang aktif di proses/server lain.');
                    console.warn('⚠️ Menghentikan reconnect otomatis untuk mencegah loop conflict.');
                    broadcastStatus('error', 'Koneksi terputus karena sesi WhatsApp sedang aktif di proses/server lain (Conflict). Pastikan hanya ada 1 server yang berjalan.');
                    return;
                }

                const disconnectMsg = isLogout
                    ? 'Client was logged out'
                    : `Client terputus (${reason})`;
                broadcastStatus('disconnected', disconnectMsg);

                if (isLogout) {
                    console.log('🗑️ Client logout. Menghapus folder sesi lama...');
                    try {
                        await fs.remove(SESSION_DIR);
                    } catch (err) {
                        console.error('❌ Gagal membersihkan folder sesi:', err);
                    }
                }

                // Reconnect otomatis dengan membatalkan timer sebelumnya
                if (reconnectTimeout) {
                    clearTimeout(reconnectTimeout);
                }

                const reconnectDelay = isLogout ? 3000 : (statusCode === DisconnectReason.restartRequired ? 1000 : 5000);
                console.log(`🔄 Menghubungkan ulang dalam ${reconnectDelay / 1000} detik...`);
                reconnectTimeout = setTimeout(() => {
                    reconnectTimeout = null;
                    connectToWhatsApp();
                }, reconnectDelay);
            }
        });

        // Listener pesan masuk (opsional untuk logging)
        sock.ev.on('messages.upsert', async (m) => {
            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    if (!msg.key.fromMe) {
                        const sender = msg.key.remoteJid;
                        const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '[Media/Lainnya]';
                        console.log(`💬 Pesan diterima dari ${sender}: ${body}`);
                    }
                }
            }
        });

    } catch (err) {
        console.error('❌ Gagal menginisialisasi Baileys:', err);
        broadcastStatus('error', 'Gagal menginisialisasi WhatsApp Baileys: ' + err.message);
    } finally {
        isConnecting = false;
    }
};

// Start inisialisasi Baileys
connectToWhatsApp();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper: Format nomor telepon ke standar internasional WhatsApp JID
const formatToWhatsAppJid = (input) => {
    if (!input) return null;
    let clean = String(input).trim().replace(/[^0-9]/g, '');
    if (clean.startsWith('0')) {
        clean = '62' + clean.slice(1);
    }
    return clean ? `${clean}@s.whatsapp.net` : null;
};

// API Endpoint untuk kirim pesan
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

        const messageText = String(pesan).trim();
        const formattedJid = formatToWhatsAppJid(nohp);

        if (!formattedJid) {
            return res.status(400).json({
                status: "error",
                pesan: "Format nomor tidak valid"
            });
        }

        console.log('📱 Formatted JID:', formattedJid);

        if (!sock) {
            console.error('❌ Socket is null!');
            return res.status(503).json({
                status: "error",
                pesan: "WhatsApp client tidak terinisialisasi"
            });
        }

        const isReady = clientStatus === 'ready';
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

        console.log('🔍 Checking if number is registered on WhatsApp...');
        const cleanNumber = formattedJid.split('@')[0];
        const results = await sock.onWhatsApp(cleanNumber);

        if (results && results.length > 0 && results[0].exists) {
            const targetJid = results[0].jid;
            console.log(`✅ Number registered as ${targetJid}, sending message...`);
            await sock.sendMessage(targetJid, { text: messageText });
            console.log('✅ Message sent successfully!');

            return res.json({
                status: "berhasil terkirim",
                pesan: messageText,
                to: targetJid
            });
        } else {
            console.log('⚠️ Number not registered on WhatsApp');
            return res.json({
                status: "gagal terkirim",
                pesan: 'nomor wa tidak terdaftar'
            });
        }
    } catch (error) {
        console.error('❌ API Error:', error);
        return res.status(500).json({
            status: 'error',
            pesan: 'server error',
            detail: process.env.NODE_ENV === 'development' ? error.message : undefined
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

    // Kirim status saat koneksi baru terjalin
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
        engine: 'baileys',
        whatsapp: {
            status: clientStatus,
            message: clientStatusMessage,
            hasClient: !!sock,
            user: sock && sock.user ? sock.user : null,
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
