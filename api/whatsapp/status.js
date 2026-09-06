const { connectToDatabase } = require('../_lib/database.js');

module.exports = async (req, res) => {
    try {
        const pool = await connectToDatabase();
        
        // Get status from database
        const result = await pool.query(
            `SELECT * FROM status WHERE id = 'whatsapp_status'`
        );
        
        const status = result.rows[0] || { status: 'unknown' };
        
        // Also check Baileys health directly
        let connected = false;
        let user = null;
        
        try {
            const baileysUrl = process.env.BAILEYS_URL;
            if (baileysUrl) {
                const healthResponse = await fetch(`${baileysUrl}/api/health`);
                const healthData = await healthResponse.json();
                connected = healthData.connected || false;
                user = healthData.user || null;
            }
        } catch (error) {
            console.error('Error checking Baileys health:', error.message);
        }
        
        res.json({
            connected: connected,
            status: status.status || 'unknown',
            user: user || status.user_id || null,
            lastConnected: status.last_connected || null,
            lastDisconnect: status.last_disconnect || null,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Error checking status:', error);
        res.status(500).json({ 
            connected: false, 
            status: 'error',
            error: error.message 
        });
    }
};