const { connectToDatabase } = require('../_lib/database.js');

module.exports = async (req, res) => {
    try {
        const { to, message } = req.body;
        
        if (!to || !message) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing required fields: to, message' 
            });
        }

        // Forward to Baileys service
        const baileysUrl = process.env.BAILEYS_URL;
        if (!baileysUrl) {
            throw new Error('BAILEYS_URL environment variable is not set');
        }

        const response = await fetch(`${baileysUrl}/api/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to, message })
        });
        
        const data = await response.json();
        
        if (data.success) {
            // Store sent message in database
            const pool = await connectToDatabase();
            await pool.query(
                `INSERT INTO messages (
                    id, from_id, to_id, from_me, body, timestamp, processed
                ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                    data.messageId || `sent_${Date.now()}`,
                    'me',
                    to,
                    true,
                    message,
                    Math.floor(Date.now() / 1000),
                    true
                ]
            );
        }
        
        res.json(data);
        
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
};