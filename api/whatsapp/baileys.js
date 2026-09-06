const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { connectToDatabase } = require('../_lib/database.js');
const fetch = require('node-fetch');

let sock = null;
let isConnected = false;
let reconnectTimer = null;

async function getWhatsAppSocket() {
    if (sock && isConnected) {
        return sock;
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
        
        sock = makeWASocket({
            auth: state,
            connectTimeoutMs: 30000,
            keepAliveIntervalMs: 30000,
            defaultQueryTimeoutMs: 120000,
            printQRInTerminal: true,
            browser: ['Chrome', 'Desktop', '1.0.0']
        });

        // Save credentials when updated
        sock.ev.on('creds.update', saveCreds);

        // Handle connection updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                isConnected = false;
                
                // Update status in database
                try {
                    const pool = await connectToDatabase();
                    await pool.query(
                        `UPDATE status 
                         SET status = 'disconnected', 
                             last_disconnect = CURRENT_TIMESTAMP,
                             updated_at = CURRENT_TIMESTAMP
                         WHERE id = 'whatsapp_status'`
                    );
                } catch (error) {
                    console.error('Error updating status:', error);
                }

                if (shouldReconnect) {
                    console.log('🔄 Reconnecting...');
                    if (reconnectTimer) clearTimeout(reconnectTimer);
                    reconnectTimer = setTimeout(() => {
                        getWhatsAppSocket();
                    }, 5000);
                }
            } else if (connection === 'open') {
                isConnected = true;
                console.log('✅ WhatsApp Connected!');
                
                // Update status in database
                try {
                    const pool = await connectToDatabase();
                    await pool.query(
                        `INSERT INTO status (id, status, last_connected, user_id, updated_at)
                         VALUES ('whatsapp_status', 'connected', CURRENT_TIMESTAMP, $1, CURRENT_TIMESTAMP)
                         ON CONFLICT (id) DO UPDATE SET
                            status = 'connected',
                            last_connected = CURRENT_TIMESTAMP,
                            user_id = EXCLUDED.user_id,
                            updated_at = CURRENT_TIMESTAMP`,
                        [sock.user?.id || null]
                    );
                } catch (error) {
                    console.error('Error updating status:', error);
                }
            }
        });

        // Handle incoming messages - STORE IN DATABASE
        sock.ev.on('messages.upsert', async ({ messages }) => {
            try {
                const pool = await connectToDatabase();
                
                for (const msg of messages) {
                    if (msg.key.fromMe) continue; // Skip own messages
                    
                    const messageData = {
                        id: msg.key.id,
                        from: msg.key.remoteJid,
                        fromMe: msg.key.fromMe || false,
                        body: msg.message?.conversation || 
                              msg.message?.extendedTextMessage?.text || 
                              '[Media/File]',
                        timestamp: msg.messageTimestamp || Math.floor(Date.now() / 1000),
                        type: msg.message?.type || 'text',
                        hasMedia: !!msg.message?.imageMessage || 
                                 !!msg.message?.documentMessage ||
                                 !!msg.message?.videoMessage
                    };

                    await pool.query(
                        `INSERT INTO messages (
                            id, from_id, to_id, from_me, body, timestamp, type, has_media
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        ON CONFLICT (id) DO NOTHING`,
                        [
                            messageData.id,
                            messageData.from,
                            null,
                            false,
                            messageData.body,
                            messageData.timestamp,
                            messageData.type,
                            messageData.hasMedia
                        ]
                    );
                    
                    console.log(`📩 New message from ${messageData.from}`);
                }
            } catch (error) {
                console.error('Error storing message:', error);
            }
        });

        return sock;

    } catch (error) {
        console.error('Baileys connection error:', error);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
            getWhatsAppSocket();
        }, 10000);
        throw error;
    }
}

module.exports = {
    getWhatsAppSocket,
    isConnected: () => isConnected,
    getSock: () => sock
};