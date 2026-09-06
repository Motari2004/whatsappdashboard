const { connectToDatabase } = require('../_lib/database.js');

module.exports = async (req, res) => {
    try {
        const pool = await connectToDatabase();
        const limit = parseInt(req.query.limit) || 50;
        
        // Get unprocessed messages first
        const unreadResult = await pool.query(
            `SELECT * FROM messages 
             WHERE processed = false 
             ORDER BY timestamp DESC 
             LIMIT $1`,
            [limit]
        );
        
        const unread = unreadResult.rows;
        
        // Mark as processed
        if (unread.length > 0) {
            const ids = unread.map(m => m.id);
            await pool.query(
                `UPDATE messages 
                 SET processed = true, processed_at = CURRENT_TIMESTAMP 
                 WHERE id = ANY($1)`,
                [ids]
            );
        }
        
        // Get all recent messages (for display)
        const recentResult = await pool.query(
            `SELECT * FROM messages 
             ORDER BY timestamp DESC 
             LIMIT $1`,
            [100]
        );
        
        res.json({ 
            messages: recentResult.rows,
            unread: unread.length
        });
    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({ error: error.message });
    }
};