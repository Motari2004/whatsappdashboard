const { connectToDatabase } = require('../_lib/database.js');

module.exports = async (req, res) => {
    // Security: Verify cron secret
    const authHeader = req.headers.authorization;
    const cronSecret = process.env.CRON_SECRET || 'your-secret-key';
    
    if (authHeader !== `Bearer ${cronSecret}` && process.env.NODE_ENV === 'production') {
        return res.status(401).json({ 
            error: 'Unauthorized', 
            message: 'Invalid cron secret' 
        });
    }

    // Prevent duplicate runs (optional)
    const runId = req.query.runId || Date.now().toString();
    
    try {
        const pool = await connectToDatabase();
        const now = new Date().toISOString();
        
        console.log(`🔄 Cron job started: ${runId} at ${now}`);

        // 1. FETCH NEW MESSAGES FROM BAILEYS SERVICE
        const baileysUrl = process.env.BAILEYS_URL;
        if (!baileysUrl) {
            throw new Error('BAILEYS_URL environment variable is not set');
        }

        const response = await fetch(`${baileysUrl}/api/messages`, {
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error(`Baileys service returned ${response.status}`);
        }
        
        const data = await response.json();
        let newMessagesCount = 0;

        // 2. STORE NEW MESSAGES IN POSTGRESQL
        if (data.messages && data.messages.length > 0) {
            console.log(`📩 Found ${data.messages.length} new messages from Baileys`);
            
            for (const msg of data.messages) {
                try {
                    const result = await pool.query(
                        `INSERT INTO messages (
                            id, from_id, to_id, from_me, body, timestamp, type, has_media
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        ON CONFLICT (id) DO UPDATE SET
                            body = EXCLUDED.body,
                            processed = false
                        RETURNING id`,
                        [
                            msg.id || `msg_${Date.now()}_${Math.random()}`,
                            msg.from || msg.from_id || 'unknown',
                            msg.to || msg.to_id || null,
                            msg.fromMe || false,
                            msg.body || '[Media/File]',
                            msg.timestamp || Math.floor(Date.now() / 1000),
                            msg.type || 'text',
                            msg.hasMedia || false
                        ]
                    );
                    
                    if (result.rowCount > 0) {
                        newMessagesCount++;
                    }
                } catch (error) {
                    console.error(`Error storing message ${msg.id}:`, error.message);
                }
            }

            console.log(`✅ Stored ${newMessagesCount} new messages`);
        }

        // 3. CHECK BAILEYS CONNECTION STATUS
        try {
            const healthResponse = await fetch(`${baileysUrl}/api/health`);
            const healthData = await healthResponse.json();
            
            if (healthData.connected) {
                await pool.query(
                    `INSERT INTO status (id, status, last_connected, user_id, updated_at)
                     VALUES ('whatsapp_status', 'connected', CURRENT_TIMESTAMP, $1, CURRENT_TIMESTAMP)
                     ON CONFLICT (id) DO UPDATE SET
                        status = 'connected',
                        last_connected = CURRENT_TIMESTAMP,
                        user_id = EXCLUDED.user_id,
                        updated_at = CURRENT_TIMESTAMP`,
                    [healthData.user || null]
                );
                console.log('✅ WhatsApp is connected');
            } else {
                await pool.query(
                    `UPDATE status 
                     SET status = 'disconnected', 
                         last_disconnect = CURRENT_TIMESTAMP,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = 'whatsapp_status'`
                );
                console.log('❌ WhatsApp is disconnected');
            }
        } catch (error) {
            console.error('Error checking health:', error.message);
            await pool.query(
                `UPDATE status 
                 SET status = 'error', 
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = 'whatsapp_status'`
            );
        }

        // 4. LOG THIS CRON RUN
        await pool.query(
            `INSERT INTO processed_log (cron_job_id, messages_found)
             VALUES ($1, $2)`,
            [runId, newMessagesCount]
        );

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

        // Return success response
        res.json({
            success: true,
            runId: runId,
            timestamp: now,
            newMessagesCount: newMessagesCount,
            totalMessages: data.messages?.length || 0,
            cleanedUp: deleteResult.rowCount || 0,
            status: 'completed'
        });

    } catch (error) {
        console.error('❌ Polling error:', error);
        
        // Log error
        try {
            const pool = await connectToDatabase();
            await pool.query(
                `INSERT INTO processed_log (cron_job_id, messages_found, processed_at)
                 VALUES ($1, $2, CURRENT_TIMESTAMP)`,
                [runId, -1] // -1 indicates error
            );
        } catch (dbError) {
            console.error('Failed to log error:', dbError);
        }
        
        res.status(500).json({ 
            success: false, 
            error: error.message,
            runId: runId
        });
    }
};