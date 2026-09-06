const { Pool } = require('pg');
const QRCode = require('qrcode');

let pool = null;
let sock = null;
let isConnected = false;
let currentQR = null;
let reconnectTimer = null;
let messageQueue = [];

// Database connection
async function getDb() {
    if (pool) return pool;
    
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL not set');
    }

    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    });

    await pool.query(`
        CREATE TABLE IF NOT EXISTS messages (
            id VARCHAR(255) PRIMARY KEY,
            from_id VARCHAR(255),
            body TEXT,
            timestamp BIGINT,
            from_me BOOLEAN DEFAULT false,
            processed BOOLEAN DEFAULT false,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS status (
            id VARCHAR(50) PRIMARY KEY,
            status VARCHAR(50),
            qr_code TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS auth_state (
            id VARCHAR(50) PRIMARY KEY,
            creds JSONB,
            keys JSONB,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    return pool;
}

// Custom auth state using database
async function useDbAuthState() {
    const db = await getDb();
    
    let result = await db.query(
        `SELECT creds, keys FROM auth_state WHERE id = 'whatsapp_auth'`
    );
    
    let creds = {};
    let keys = {};
    
    if (result.rows.length > 0) {
        creds = result.rows[0].creds || {};
        keys = result.rows[0].keys || {};
        console.log('✅ Loaded auth from database');
    } else {
        console.log('📝 No existing auth found, will create new');
    }
    
    const saveCreds = async () => {
        try {
            const currentCreds = sock?.authState?.creds || {};
            const currentKeys = sock?.authState?.keys || {};
            
            await db.query(
                `INSERT INTO auth_state (id, creds, keys, updated_at)
                 VALUES ('whatsapp_auth', $1, $2, CURRENT_TIMESTAMP)
                 ON CONFLICT (id) DO UPDATE SET 
                    creds = EXCLUDED.creds,
                    keys = EXCLUDED.keys,
                    updated_at = CURRENT_TIMESTAMP`,
                [currentCreds, currentKeys]
            );
            console.log('💾 Auth saved to database');
        } catch (error) {
            console.error('Failed to save auth:', error);
        }
    };
    
    return {
        state: {
            creds: creds,
            keys: keys
        },
        saveCreds
    };
}

// Load Baileys correctly
let makeWASocket = null;
let DisconnectReason = null;
let useMultiFileAuthState = null;
let Browsers = null;
let baileysLoaded = false;

async function loadBaileys() {
    if (baileysLoaded) return;
    
    try {
        const baileys = await import('@whiskeysockets/baileys');
        // Fix: Get the default export correctly
        makeWASocket = baileys.default || baileys.makeWASocket;
        DisconnectReason = baileys.DisconnectReason;
        useMultiFileAuthState = baileys.useMultiFileAuthState;
        Browsers = baileys.Browsers;
        baileysLoaded = true;
        console.log('✅ Baileys loaded successfully');
        console.log('🔍 makeWASocket type:', typeof makeWASocket);
    } catch (error) {
        console.error('❌ Failed to load Baileys:', error);
        throw error;
    }
}

// WhatsApp connection
async function connectWhatsApp() {
    try {
        await loadBaileys();
        
        if (!makeWASocket) {
            throw new Error('makeWASocket is not loaded');
        }
        
        console.log('🔄 Connecting to WhatsApp...');
        
        const { state, saveCreds } = await useDbAuthState();
        
        sock = makeWASocket({
            auth: state,
            connectTimeoutMs: 30000,
            keepAliveIntervalMs: 30000,
            defaultQueryTimeoutMs: 120000,
            printQRInTerminal: true,
            browser: ['Chrome', 'Desktop', '1.0.0']
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                currentQR = qr;
                console.log('📱 QR Code generated');
                
                try {
                    const qrDataURL = await QRCode.toDataURL(qr);
                    const db = await getDb();
                    await db.query(
                        `INSERT INTO status (id, status, qr_code, updated_at)
                         VALUES ('whatsapp_status', 'qr_required', $1, CURRENT_TIMESTAMP)
                         ON CONFLICT (id) DO UPDATE SET 
                            status = 'qr_required', 
                            qr_code = EXCLUDED.qr_code,
                            updated_at = CURRENT_TIMESTAMP`,
                        [qrDataURL]
                    );
                    console.log('✅ QR Code stored in database');
                } catch (err) {
                    console.error('QR generation error:', err);
                }
            }
            
            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason?.loggedOut;
                isConnected = false;
                currentQR = null;
                
                const db = await getDb();
                await db.query(
                    `INSERT INTO status (id, status, updated_at)
                     VALUES ('whatsapp_status', 'disconnected', CURRENT_TIMESTAMP)
                     ON CONFLICT (id) DO UPDATE SET 
                        status = 'disconnected',
                        qr_code = NULL,
                        updated_at = CURRENT_TIMESTAMP`
                );

                if (shouldReconnect) {
                    console.log('🔄 Reconnecting...');
                    if (reconnectTimer) clearTimeout(reconnectTimer);
                    reconnectTimer = setTimeout(() => connectWhatsApp(), 5000);
                }
            } else if (connection === 'open') {
                isConnected = true;
                currentQR = null;
                console.log('✅ WhatsApp Connected!');
                
                const db = await getDb();
                await db.query(
                    `INSERT INTO status (id, status, updated_at)
                     VALUES ('whatsapp_status', 'connected', CURRENT_TIMESTAMP)
                     ON CONFLICT (id) DO UPDATE SET 
                        status = 'connected',
                        qr_code = NULL,
                        updated_at = CURRENT_TIMESTAMP`
                );

                if (messageQueue.length > 0) {
                    console.log(`📤 Sending ${messageQueue.length} queued messages...`);
                    for (const msg of messageQueue) {
                        try {
                            await sock.sendMessage(msg.to, { text: msg.message });
                            console.log(`✅ Sent queued message to ${msg.to}`);
                        } catch (err) {
                            console.error('Failed to send queued message:', err);
                        }
                    }
                    messageQueue = [];
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            try {
                const db = await getDb();
                
                for (const msg of messages) {
                    if (msg.key.fromMe) continue;
                    
                    const messageData = {
                        id: msg.key.id,
                        from: msg.key.remoteJid,
                        body: msg.message?.conversation || 
                              msg.message?.extendedTextMessage?.text || 
                              '[Media/File]',
                        timestamp: msg.messageTimestamp || Math.floor(Date.now() / 1000)
                    };

                    await db.query(
                        `INSERT INTO messages (id, from_id, body, timestamp, from_me)
                         VALUES ($1, $2, $3, $4, $5)
                         ON CONFLICT (id) DO NOTHING`,
                        [messageData.id, messageData.from, messageData.body, messageData.timestamp, false]
                    );
                    
                    console.log(`📩 New message from ${messageData.from}`);
                }
            } catch (error) {
                console.error('Error storing message:', error);
            }
        });

        return sock;

    } catch (error) {
        console.error('WhatsApp connection error:', error);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => connectWhatsApp(), 10000);
        throw error;
    }
}

// Start connection
(async () => {
    try {
        await connectWhatsApp();
    } catch (error) {
        console.error('Failed to initialize:', error);
    }
})();

// ============ EXPRESS HANDLER ============
module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname.replace(/^\/api\//, '');

    console.log(`📨 ${req.method} /api/${path}`);

    try {
        const db = await getDb();

        // ============ GET /api/status ============
        if (path === 'status' && req.method === 'GET') {
            const result = await db.query(
                `SELECT * FROM status WHERE id = 'whatsapp_status'`
            );
            const status = result.rows[0] || { status: 'unknown', qr_code: null };
            
            return res.json({
                connected: isConnected,
                status: status.status || 'unknown',
                qrCode: status.qr_code || null,
                timestamp: new Date().toISOString()
            });
        }

        // ============ GET /api/messages ============
        if (path === 'messages' && req.method === 'GET') {
            const limit = parseInt(url.searchParams.get('limit')) || 50;
            
            const result = await db.query(
                `SELECT * FROM messages ORDER BY timestamp DESC LIMIT $1`,
                [limit]
            );
            
            const unread = await db.query(
                `SELECT COUNT(*) as count FROM messages WHERE processed = false`
            );
            
            if (result.rows.length > 0) {
                const ids = result.rows.map(m => m.id);
                await db.query(
                    `UPDATE messages SET processed = true WHERE id = ANY($1)`,
                    [ids]
                );
            }
            
            return res.json({
                success: true,
                messages: result.rows,
                unread: parseInt(unread.rows[0]?.count || 0)
            });
        }

        // ============ POST /api/send ============
        if (path === 'send' && req.method === 'POST') {
            const { to, message } = req.body;
            
            if (!to || !message) {
                return res.status(400).json({ error: 'Missing to or message' });
            }

            if (!isConnected || !sock) {
                messageQueue.push({ to, message });
                console.log(`📝 Queued message to ${to} (not connected)`);
                return res.json({ 
                    success: true, 
                    queued: true,
                    message: 'Message queued (waiting for connection)'
                });
            }

            try {
                const msg = await sock.sendMessage(to, { text: message });
                
                await db.query(
                    `INSERT INTO messages (id, from_id, body, timestamp, from_me, processed)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [msg.key.id, 'me', message, Math.floor(Date.now()/1000), true, true]
                );
                
                return res.json({ 
                    success: true, 
                    messageId: msg.key.id 
                });
            } catch (error) {
                console.error('Send error:', error);
                return res.status(500).json({ 
                    success: false, 
                    error: error.message 
                });
            }
        }

        // ============ GET /api/poll ============
        if (path === 'poll' && req.method === 'GET') {
            const authHeader = req.headers.authorization;
            const cronSecret = process.env.CRON_SECRET || 'your-secret';
            
            if (authHeader !== `Bearer ${cronSecret}` && process.env.VERCEL_ENV === 'production') {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            
            const statusText = isConnected ? 'connected' : 'disconnected';
            await db.query(
                `INSERT INTO status (id, status, updated_at)
                 VALUES ('whatsapp_status', $1, CURRENT_TIMESTAMP)
                 ON CONFLICT (id) DO UPDATE SET 
                    status = EXCLUDED.status, 
                    updated_at = CURRENT_TIMESTAMP`,
                [statusText]
            );
            
            const count = await db.query(
                `SELECT COUNT(*) as count FROM messages WHERE processed = false`
            );
            
            return res.json({
                success: true,
                connected: isConnected,
                timestamp: new Date().toISOString(),
                unprocessed: parseInt(count.rows[0]?.count || 0)
            });
        }

        // ============ GET /api/test ============
        if (path === 'test' && req.method === 'GET') {
            return res.json({
                success: true,
                message: 'API is working!',
                connected: isConnected,
                timestamp: new Date().toISOString(),
                env: process.env.VERCEL_ENV || 'development'
            });
        }

        return res.status(404).json({ 
            error: 'Not found', 
            path: `/api/${path}` 
        });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ 
            error: error.message,
            stack: process.env.VERCEL_ENV === 'development' ? error.stack : undefined
        });
    }
};