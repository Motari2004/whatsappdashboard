const { Pool } = require('pg');

let pool = null;

async function connectToDatabase() {
    if (pool) return pool;
    
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is not defined');
    }

    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        },
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
    });

    // Create tables if they don't exist
    await pool.query(`
        CREATE TABLE IF NOT EXISTS messages (
            id VARCHAR(255) PRIMARY KEY,
            from_id VARCHAR(255) NOT NULL,
            to_id VARCHAR(255),
            from_me BOOLEAN DEFAULT false,
            body TEXT,
            timestamp BIGINT NOT NULL,
            type VARCHAR(50),
            has_media BOOLEAN DEFAULT false,
            processed BOOLEAN DEFAULT false,
            processed_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS status (
            id VARCHAR(50) PRIMARY KEY,
            status VARCHAR(50),
            last_connected TIMESTAMP,
            last_disconnect TIMESTAMP,
            user_id VARCHAR(255),
            should_reconnect BOOLEAN DEFAULT false,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS processed_log (
            id SERIAL PRIMARY KEY,
            cron_job_id VARCHAR(100),
            messages_found INTEGER DEFAULT 0,
            processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_messages_processed ON messages(processed);
    `);

    return pool;
}

module.exports = {
    connectToDatabase
};