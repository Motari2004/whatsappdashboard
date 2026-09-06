const { Pool } = require('pg');
const fetch = require('node-fetch');

let pool = null;
let instanceId = null;
let apiToken = null;

// ============ DATABASE ============
async function getDb() {
    if (pool) return pool;
    
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL not set');
    }

    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
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
            instance_id VARCHAR(50),
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS contacts (
            id VARCHAR(255) PRIMARY KEY,
            name VARCHAR(255),
            number VARCHAR(50),
            last_message TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    return pool;
}

// ============ GREEN API ============
function getGreenApiConfig() {
    instanceId = process.env.GREEN_API_INSTANCE_ID;
    apiToken = process.env.GREEN_API_TOKEN;
    
    if (!instanceId || !apiToken) {
        throw new Error('GREEN_API_INSTANCE_ID and GREEN_API_TOKEN must be set');
    }
    
    return {
        baseUrl: `https://api.green-api.com/waInstance${instanceId}`,
        token: apiToken
    };
}

// Send message via Green API
async function sendGreenApiMessage(to, message) {
    try {
        const { baseUrl, token } = getGreenApiConfig();
        const url = `${baseUrl}/sendMessage/${token}`;
        
        // Format phone number (remove + if present, add @c.us)
        let chatId = to.replace('+', '');
        if (!chatId.includes('@c.us')) {
            chatId = `${chatId}@c.us`;
        }
        
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chatId: chatId,
                message: message
            })
        });
        
        const data = await response.json();
        console.log('📤 Green API send response:', data);
        return data;
    } catch (error) {
        console.error('Green API send error:', error);
        throw error;
    }
}

// Get QR code from Green API
async function getGreenApiQR() {
    try {
        const { baseUrl, token } = getGreenApiConfig();
        const url = `${baseUrl}/getQR/${token}`;
        
        const response = await fetch(url);
        const data = await response.json();
        console.log('📱 QR response:', data);
        return data;
    } catch (error) {
        console.error('QR fetch error:', error);
        return null;
    }
}

// Get instance status
async function getGreenApiStatus() {
    try {
        const { baseUrl, token } = getGreenApiConfig();
        const url = `${baseUrl}/getStateInstance/${token}`;
        
        const response = await fetch(url);
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Status check error:', error);
        return null;
    }
}

// ============ WEBHOOK HANDLER ============
async function handleWebhook(req, res) {
    const notification = req.body;
    console.log('📨 Webhook received:', notification.typeWebhook);
    
    try {
        const db = await getDb();
        
        // Handle incoming messages
        if (notification.typeWebhook === 'incomingMessageReceived') {
            console.log(`📩 New message from ${notification.senderData?.sender}`);
            
            const messageData = {
                id: notification.idMessage,
                from: notification.senderData?.sender || 'unknown',
                body: notification.messageData?.textMessageData?.textMessage || '[Media/File]',
                timestamp: Math.floor(notification.timestamp / 1000) || Math.floor(Date.now() / 1000),
                from_me: false
            };
            
            await db.query(
                `INSERT INTO messages (id, from_id, body, timestamp, from_me)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (id) DO NOTHING`,
                [messageData.id, messageData.from, messageData.body, messageData.timestamp, false]
            );
            
            // Update or create contact
            const sender = notification.senderData?.sender || 'unknown';
            const senderName = notification.senderData?.senderName || sender;
            await db.query(
                `INSERT INTO contacts (id, name, number, last_message, updated_at)
                 VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                 ON CONFLICT (id) DO UPDATE SET 
                    name = EXCLUDED.name,
                    last_message = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP`,
                [sender, senderName, sender.replace('@c.us', '')]
            );
        }
        
        // Handle outgoing message status
        if (notification.typeWebhook === 'outgoingMessageStatus') {
            console.log(`📤 Message ${notification.idMessage} status: ${notification.status}`);
        }
        
        // Handle other webhook types
        if (notification.typeWebhook === 'stateInstanceChanged') {
            console.log(`📡 Instance state changed: ${notification.stateInstance}`);
            await db.query(
                `INSERT INTO status (id, status, updated_at)
                 VALUES ('whatsapp_status', $1, CURRENT_TIMESTAMP)
                 ON CONFLICT (id) DO UPDATE SET 
                    status = EXCLUDED.status,
                    updated_at = CURRENT_TIMESTAMP`,
                [notification.stateInstance]
            );
        }
        
        res.status(200).send('OK');
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: error.message });
    }
}

// ============ EXPRESS HANDLER ============
module.exports = async (req, res) => {
    // Enable CORS
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

        // ============ POST /api/webhook ============
        if (path === 'webhook' && req.method === 'POST') {
            return handleWebhook(req, res);
        }

        // ============ GET /api/status ============
        if (path === 'status' && req.method === 'GET') {
            // Get status from database
            const result = await db.query(
                `SELECT * FROM status WHERE id = 'whatsapp_status'`
            );
            const status = result.rows[0] || { status: 'unknown', qr_code: null };
            
            // Check Green API status
            let greenStatus = null;
            try {
                greenStatus = await getGreenApiStatus();
                console.log('Green API Status:', greenStatus);
            } catch (e) {
                console.error('Error getting Green API status:', e);
            }
            
            // If we have a QR code in DB, return it
            let qrCode = status.qr_code || null;
            
            // If no QR in DB, try to fetch from Green API
            if (!qrCode && status.status === 'qr_required') {
                try {
                    const qrData = await getGreenApiQR();
                    if (qrData && qrData.qr) {
                        qrCode = qrData.qr;
                        // Store in DB
                        await db.query(
                            `UPDATE status SET qr_code = $1 WHERE id = 'whatsapp_status'`,
                            [qrCode]
                        );
                    }
                } catch (e) {
                    console.error('Error fetching QR:', e);
                }
            }
            
            const isConnected = greenStatus?.stateInstance === 'online' || 
                               status.status === 'connected' ||
                               status.status === 'online';
            
            return res.json({
                connected: isConnected,
                status: status.status || 'unknown',
                greenStatus: greenStatus?.stateInstance || 'unknown',
                qrCode: qrCode,
                instanceId: instanceId || 'not-set',
                timestamp: new Date().toISOString()
            });
        }

        // ============ GET /api/init ============
        if (path === 'init' && req.method === 'GET') {
            try {
                // Check if Green API is configured
                if (!instanceId || !apiToken) {
                    getGreenApiConfig();
                }
                
                // Get instance state
                const status = await getGreenApiStatus();
                console.log('Instance status:', status);
                
                // If not connected, get QR
                if (status?.stateInstance !== 'online') {
                    const qrData = await getGreenApiQR();
                    if (qrData && qrData.qr) {
                        await db.query(
                            `INSERT INTO status (id, status, qr_code, instance_id, updated_at)
                             VALUES ('whatsapp_status', 'qr_required', $1, $2, CURRENT_TIMESTAMP)
                             ON CONFLICT (id) DO UPDATE SET 
                                status = 'qr_required',
                                qr_code = EXCLUDED.qr_code,
                                instance_id = EXCLUDED.instance_id,
                                updated_at = CURRENT_TIMESTAMP`,
                            [qrData.qr, instanceId]
                        );
                        return res.json({
                            success: true,
                            status: 'qr_required',
                            qrCode: qrData.qr,
                            message: 'QR code generated. Scan with WhatsApp.'
                        });
                    }
                }
                
                return res.json({
                    success: true,
                    status: status?.stateInstance || 'unknown',
                    message: `Instance is ${status?.stateInstance || 'unknown'}`
                });
            } catch (error) {
                console.error('Init error:', error);
                return res.status(500).json({ 
                    success: false, 
                    error: error.message 
                });
            }
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

        // ============ GET /api/contacts ============
        if (path === 'contacts' && req.method === 'GET') {
            const result = await db.query(
                `SELECT * FROM contacts ORDER BY last_message DESC LIMIT 50`
            );
            return res.json({
                success: true,
                contacts: result.rows
            });
        }

        // ============ POST /api/send ============
        if (path === 'send' && req.method === 'POST') {
            const { to, message } = req.body;
            
            if (!to || !message) {
                return res.status(400).json({ error: 'Missing to or message' });
            }

            try {
                const result = await sendGreenApiMessage(to, message);
                
                if (result.idMessage) {
                    // Store sent message
                    await db.query(
                        `INSERT INTO messages (id, from_id, body, timestamp, from_me, processed)
                         VALUES ($1, $2, $3, $4, $5, $6)`,
                        [result.idMessage, 'me', message, Math.floor(Date.now()/1000), true, true]
                    );
                    
                    return res.json({ 
                        success: true, 
                        messageId: result.idMessage 
                    });
                } else {
                    return res.status(500).json({ 
                        success: false, 
                        error: result.message || 'Failed to send' 
                    });
                }
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
            
            // Check Green API status
            try {
                const status = await getGreenApiStatus();
                const statusText = status?.stateInstance || 'unknown';
                
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
                    connected: statusText === 'online',
                    status: statusText,
                    timestamp: new Date().toISOString(),
                    unprocessed: parseInt(count.rows[0]?.count || 0)
                });
            } catch (error) {
                console.error('Poll error:', error);
                return res.status(500).json({ error: error.message });
            }
        }

        // ============ GET /api/test ============
        if (path === 'test' && req.method === 'GET') {
            return res.json({
                success: true,
                message: 'Green API Dashboard is working!',
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