const { connectToDatabase } = require('../_lib/database.js');

module.exports = async (req, res) => {
    try {
        const pool = await connectToDatabase();
        const limit = parseInt(req.query.limit) || 50;
        const from = req.query.from;
        
        // Build query
        let query = `SELECT * FROM messages WHERE 1=1`;
        const params = [];
        let paramCount = 1;
        
        if (from) {
            query += ` AND from_id = $${paramCount}`;
            params.push(from);
            paramCount++;
        }
        
        query += ` ORDER BY timestamp DESC LIMIT $${paramCount}`;
        params.push(limit);
        
        const result = await pool.query(query, params);
        
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