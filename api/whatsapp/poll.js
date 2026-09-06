const { connectToDatabase } = require('../_lib/database.js');

module.exports = async (req, res) => {
    try {
        // Verify cron secret
        const authHeader = req.headers.authorization;
        if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && process.env.NODE_ENV === 'production') {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const pool = await connectToDatabase();
        
        // 1. FETCH NEW MESSAGES FROM BAILEYS SERVICE
        const response = await fetch(`${process.env.BAILEYS_URL}/api/messages`);
        const data = await response.json();
        
        let newMessagesCount = 0;

        if (data.messages && data.messages.length > 0) {
            // 2. STORE IN POSTGRESQL
            for (const msg of data.messages) {
                const result = await pool.query(
                    `INSERT INTO messages (
                        id, from_id, to_id, from_me, body, timestamp, type, has_media
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    ON CONFLICT (id) DO UPDATE SET
                        body = EXCLUDED.body,
                        processed = false
                    RETURNING id`,
                    [
                        msg.id,
                        msg.from || msg.from_id,
                        msg.to || msg.to_id,
                        msg.fromMe || false,
                        msg.body || '[Media]',
                        msg.timestamp || Math.floor(Date.now() / 1000),
                        msg.type || 'text',
                        msg.hasMedia || false
                    ]
                );
                
                if (result.rowCount > 0) {
                    newMessagesCount++;
                }
            }

            console.log(`📩 Stored ${newMessagesCount} new messages`);
        }

        // 3. CHECK CONNECTION STATUS
        const statusResult = await pool.query(
            `SELECT * FROM status WHERE id = 'whatsapp_status'`
        );
        
        let status = statusResult.rows[0];

        // 4. TRIGGER RECONNECT IF NEEDED
        if (status?.status === 'disconnected' && process.env.BAILEYS_URL) {
            try {
                await fetch(`${process.env.BAILEYS_URL}/api/health`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ triggerReconnect: true })
                });
                console.log('✅ Reconnect triggered');
                
                await pool.query(
                    `UPDATE status SET status = 'reconnecting', updated_at = CURRENT_TIMESTAMP 
                     WHERE id = 'whatsapp_status'`
                );
            } catch (error) {
                console.error('Failed to trigger reconnect:', error);
            }
        }

        // 5. CLEANUP OLD MESSAGES (keep last 30 days)
        const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);
        const deleteResult = await pool.query(
            `DELETE FROM messages 
             WHERE timestamp < $1 AND processed = true
             RETURNING id`,
            [thirtyDaysAgo]
        );
        
        if (deleteResult.rowCount > 0) {
            console.log(`🧹 Cleaned up ${deleteResult.rowCount} old messages`);
        }

        res.json({
            success: true,
            newMessagesCount,
            status: status || { status: 'unknown' },
            timestamp: new Date().toISOString(),
            cleanup: deleteResult.rowCount || 0
        });

    } catch (error) {
        console.error('Polling error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
};