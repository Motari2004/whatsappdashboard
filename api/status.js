const { connectToDatabase } = require('../_lib/database.js');
const { isConnected } = require('./baileys.js');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const pool = await connectToDatabase();
        
        // Get status from database
        const result = await pool.query(
            `SELECT * FROM status WHERE id = 'whatsapp_status'`
        );
        
        const status = result.rows[0] || { status: 'unknown' };
        const connected = isConnected();
        
        res.json({
            connected: connected,
            status: status.status || 'unknown',
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