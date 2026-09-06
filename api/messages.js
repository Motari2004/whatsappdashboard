const { connectToDatabase } = require('../_lib/database.js');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const pool = await connectToDatabase();
        const limit = parseInt(req.query.limit) || 50;
        
        // Get messages
        const result = await pool.query(
            `SELECT * FROM messages 
             ORDER BY timestamp DESC 
             LIMIT $1`,
            [limit]
        );
        
        // Get unread count
        const unreadResult = await pool.query(
            `SELECT COUNT(*) as count FROM messages WHERE processed = false`
        );
        
        // Mark as processed (read)
        if (result.rows.length > 0) {
            const ids = result.rows.map(m => m.id);
            await pool.query(
                `UPDATE messages 
                 SET processed = true, processed_at = CURRENT_TIMESTAMP 
                 WHERE id = ANY($1)`,
                [ids]
            );
        }
        
        res.json({
            success: true,
            messages: result.rows,
            unread: parseInt(unreadResult.rows[0]?.count || 0),
            total: result.rows.length
        });
        
    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
};