const { connectToDatabase } = require('../_lib/database.js');
const { getWhatsAppSocket, isConnected } = require('./baileys.js');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const { to, message } = req.body;
        
        if (!to || !message) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing required fields: to, message' 
            });
        }

        // Check if WhatsApp is connected
        if (!isConnected()) {
            // Try to connect
            try {
                await getWhatsAppSocket();
                // Wait a moment for connection
                await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (error) {
                return res.status(503).json({ 
                    success: false, 
                    error: 'WhatsApp is not connected. Please try again.' 
                });
            }
        }

        const sock = require('./baileys.js').getSock();
        if (!sock) {
            return res.status(503).json({ 
                success: false, 
                error: 'WhatsApp is not connected' 
            });
        }

        // Send message
        const msg = await sock.sendMessage(to, { text: message });
        
        // Store sent message in database
        const pool = await connectToDatabase();
        await pool.query(
            `INSERT INTO messages (
                id, from_id, to_id, from_me, body, timestamp, processed
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                msg.key.id || `sent_${Date.now()}`,
                'me',
                to,
                true,
                message,
                Math.floor(Date.now() / 1000),
                true
            ]
        );
        
        res.json({ 
            success: true, 
            messageId: msg.key.id 
        });
        
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
};