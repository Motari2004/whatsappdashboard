const { connectToDatabase } = require('../_lib/database.js');
const { getWhatsAppSocket, isConnected } = require('./baileys.js');

module.exports = async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Security: Verify cron secret
    const authHeader = req.headers.authorization;
    const cronSecret = process.env.CRON_SECRET || 'your-secret-key';
    
    if (process.env.VERCEL_ENV === 'production' && authHeader !== `Bearer ${cronSecret}`) {
        return res.status(401).json({ 
            success: false,
            error: 'Unauthorized'
        });
    }

    const runId = req.query.runId || Date.now().toString();
    
    try {
        console.log(`🔄 Cron job started: ${runId}`);
        
        // 1. Ensure WhatsApp is connected
        try {
            await getWhatsAppSocket();
        } catch (error) {
            console.error('Failed to connect WhatsApp:', error);
        }

        // 2. Check connection status
        const connected = isConnected();
        const pool = await connectToDatabase();

        // 3. Get message count
        const countResult = await pool.query(
            `SELECT COUNT(*) as count FROM messages WHERE processed = false`
        );
        const unprocessedCount = parseInt(countResult.rows[0]?.count || 0);

        // 4. Update status
        await pool.query(
            `INSERT INTO status (id, status, updated_at)
             VALUES ('whatsapp_status', $1, CURRENT_TIMESTAMP)
             ON CONFLICT (id) DO UPDATE SET
                status = EXCLUDED.status,
                updated_at = CURRENT_TIMESTAMP`,
            [connected ? 'connected' : 'disconnected']
        );

        // 5. Log this cron run
        await pool.query(
            `INSERT INTO processed_log (cron_job_id, messages_found)
             VALUES ($1, $2)`,
            [runId, unprocessedCount]
        );

        // 6. Cleanup old messages (keep last 30 days)
        const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);
        const deleteResult = await pool.query(
            `DELETE FROM messages 
             WHERE timestamp < $1 AND processed = true
             RETURNING id`,
            [thirtyDaysAgo]
        );

        res.json({
            success: true,
            runId: runId,
            timestamp: new Date().toISOString(),
            connected: connected,
            unprocessedMessages: unprocessedCount,
            cleanedUp: deleteResult.rowCount || 0,
            status: 'completed'
        });

    } catch (error) {
        console.error('❌ Polling error:', error);
        
        res.status(500).json({ 
            success: false, 
            error: error.message,
            runId: runId
        });
    }
};