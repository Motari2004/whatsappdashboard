const { connectToDatabase } = require('../_lib/database.js');

module.exports = async (req, res) => {
    try {
        // Get status from Baileys service
        const response = await fetch(`${process.env.BAILEYS_URL}/api/health`);
        const data = await response.json();
        
        // Update status in database
        const pool = await connectToDatabase();
        
        if (data.connected) {
            await pool.query(
                `INSERT INTO status (id, status, last_connected, user_id, updated_at)
                 VALUES ('whatsapp_status', 'connected', CURRENT_TIMESTAMP, $1, CURRENT_TIMESTAMP)
                 ON CONFLICT (id) DO UPDATE SET
                    status = 'connected',
                    last_connected = CURRENT_TIMESTAMP,
                    user_id = EXCLUDED.user_id,
                    updated_at = CURRENT_TIMESTAMP`,
                [data.user || null]
            );
        } else {
            await pool.query(
                `INSERT INTO status (id, status, last_disconnect, updated_at)
                 VALUES ('whatsapp_status', 'disconnected', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                 ON CONFLICT (id) DO UPDATE SET
                    status = 'disconnected',
                    last_disconnect = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP`
            );
        }
        
        res.json(data);
    } catch (error) {
        console.error('Error checking status:', error);
        
        // Mark as disconnected in database
        try {
            const pool = await connectToDatabase();
            await pool.query(
                `INSERT INTO status (id, status, last_disconnect, updated_at)
                 VALUES ('whatsapp_status', 'error', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                 ON CONFLICT (id) DO UPDATE SET
                    status = 'error',
                    last_disconnect = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP`
            );
        } catch (dbError) {
            console.error('Database error:', dbError);
        }
        
        res.json({ 
            connected: false, 
            status: 'error',
            error: error.message 
        });
    }
};