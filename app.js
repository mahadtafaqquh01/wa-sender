const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
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
let conflictRetryCount = 0;

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
            browser: Browsers ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '22.04.4'],
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
                if (clientStatus !== 'qr' && clientStatus !== 'ready') {
                    broadcastStatus('loading', 'Sedang menghubungkan ke server WhatsApp...');
                }
            } else if (connection === 'open') {
                console.log('✅✅✅ CLIENT IS READY! (Baileys) ✅✅✅');
                lastQRUrl = '';
                conflictRetryCount = 0; // Reset counter saat koneksi berhasil
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
                    console.warn(`⚠️ Konflik sesi (Code 440). Percobaan retry: ${conflictRetryCount}/1`);
                    if (conflictRetryCount < 1) {
                        conflictRetryCount++;
                        console.log('⏳ Menunggu 10 detik untuk memastikan koneksi lama di server WhatsApp dilepas...');
                        broadcastStatus('loading', 'Menunggu pelepasan koneksi lama dari server WhatsApp (10 detik)...');
                        if (reconnectTimeout) clearTimeout(reconnectTimeout);
                        reconnectTimeout = setTimeout(() => {
                            reconnectTimeout = null;
                            connectToWhatsApp();
                        }, 10000);
                        return;
                    } else {
                        console.error('❌ Terdeteksi lebih dari 1 server/proses aktif secara bersamaan.');
                        broadcastStatus('error', 'Koneksi terputus karena sesi WhatsApp sedang aktif di proses/server lain (Conflict). Pastikan hanya ada 1 proses node yang berjalan.');
                        return;
                    }
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

// Helper: Cek apakah socket WhatsApp siap mengirim pesan
const isClientReady = () => {
    if (!sock) return false;
    if (clientStatus === 'ready' && sock.user) return true;
    if (sock.user && sock.ws && (sock.ws.isOpen || sock.ws.readyState === 1)) {
        return true;
    }
    return false;
};

// Helper: Tunggu hingga client ready jika saat ini masih loading/connecting (maks timeoutMs)
const waitForReady = (timeoutMs = 10000) => {
    if (isClientReady()) return Promise.resolve(true);

    return new Promise((resolve) => {
        const checkInterval = 250;
        let elapsed = 0;

        const timer = setInterval(() => {
            elapsed += checkInterval;
            if (isClientReady()) {
                clearInterval(timer);
                resolve(true);
            } else if (elapsed >= timeoutMs || clientStatus === 'qr' || clientStatus === 'error') {
                clearInterval(timer);
                resolve(false);
            }
        }, checkInterval);
    });
};

// Queue antrean pesan untuk pengiriman serial/paralel yang aman
let sendQueue = Promise.resolve();
const queueSendMessage = (fn) => {
    const result = sendQueue.then(async () => {
        const res = await fn();
        // Beri jeda kecil (150ms) antar pesan agar WhatsApp server tidak menganggap spam/rate limit
        await new Promise(r => setTimeout(r, 150));
        return res;
    });
    sendQueue = result.catch(() => {});
    return result;
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
                pesan: "WhatsApp client belum diinisialisasi"
            });
        }

        // Jika client sedang loading/connecting, beri toleransi waktu tunggu hingga ready (maks 10 detik)
        if (!isClientReady() && (clientStatus === 'loading' || clientStatus === 'initializing')) {
            console.log('⏳ Client sedang loading/connecting, menunggu hingga ready (maks 10 detik)...');
            await waitForReady(10000);
        }

        if (!isClientReady()) {
            let userMessage = "WhatsApp client belum siap.";
            if (clientStatus === 'qr') {
                userMessage = "WhatsApp client belum terhubung. Silakan scan QR code terlebih dahulu di dashboard web.";
            } else if (clientStatus === 'loading' || clientStatus === 'initializing') {
                userMessage = "WhatsApp client sedang menghubungkan ke server WhatsApp. Silakan coba beberapa saat lagi.";
            } else if (clientStatus === 'disconnected') {
                userMessage = "WhatsApp client terputus dari server WhatsApp. Sedang mencoba menghubungkan ulang...";
            } else if (clientStatus === 'error') {
                userMessage = clientStatusMessage || "Terjadi kesalahan pada koneksi WhatsApp client.";
            }

            console.error(`❌ Client not ready. Status: [${clientStatus}], Sock: ${!!sock}, User: ${sock?.user?.id || 'none'}`);
            return res.status(503).json({
                status: "error",
                pesan: userMessage,
                debug: {
                    clientStatus,
                    hasSock: !!sock,
                    hasUser: Boolean(sock?.user),
                    isConnected: isClientReady(),
                    message: clientStatusMessage
                }
            });
        }

        const cleanNumber = formattedJid.split('@')[0];

        // Eksekusi pengiriman pesan melalui queue teratur
        const result = await queueSendMessage(async () => {
            console.log(`🔍 Checking if ${cleanNumber} is registered on WhatsApp...`);
            let targetJid = formattedJid;
            let exists = true;

            try {
                const results = await sock.onWhatsApp(cleanNumber);
                if (results && results.length > 0) {
                    exists = results[0].exists;
                    if (results[0].jid) {
                        targetJid = results[0].jid;
                    }
                }
            } catch (checkErr) {
                console.warn('⚠️ Gagal cek onWhatsApp, mencoba kirim langsung:', checkErr.message);
            }

            if (exists) {
                console.log(`✅ Sending message to ${targetJid}...`);
                await sock.sendMessage(targetJid, { text: messageText });
                console.log('✅ Message sent successfully!');
                return {
                    success: true,
                    status: "berhasil terkirim",
                    pesan: messageText,
                    to: targetJid
                };
            } else {
                console.log('⚠️ Number not registered on WhatsApp');
                return {
                    success: false,
                    status: "gagal terkirim",
                    pesan: 'nomor wa tidak terdaftar'
                };
            }
        });

        if (result.success) {
            return res.json({
                status: result.status,
                pesan: result.pesan,
                to: result.to
            });
        } else {
            return res.json({
                status: result.status,
                pesan: result.pesan
            });
        }

    } catch (error) {
        console.error('❌ API Error:', error);
        return res.status(500).json({
            status: 'error',
            pesan: 'server error',
            detail: error.message
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
    const isReady = isClientReady();
    res.json({
        status: isReady ? 'ok' : 'degraded',
        engine: 'baileys',
        whatsapp: {
            status: clientStatus,
            message: clientStatusMessage,
            hasClient: !!sock,
            isReady,
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
