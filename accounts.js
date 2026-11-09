const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable'
        ? false
        : { rejectUnauthorized: false }
});

const ACCOUNT_LOCK_MS = 24 * 60 * 60 * 1000;
const REMOVE_PASSWORD = process.env.REMOVE_PASSWORD || '1234';
const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;
const TIMEZONE = 'Africa/Lusaka';

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS accounts (
            phone TEXT PRIMARY KEY,
            password TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'FREE',
            logout_time BIGINT DEFAULT NULL,
            logout_time_str TEXT DEFAULT NULL,
            last_heartbeat BIGINT DEFAULT NULL,
            in_use_since BIGINT DEFAULT NULL,
            tab_id TEXT DEFAULT NULL,
            freed_at BIGINT DEFAULT NULL
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS alerts (
            id SERIAL PRIMARY KEY,
            tab_id TEXT,
            amount NUMERIC DEFAULT 0,
            timestamp BIGINT,
            created_at TIMESTAMP DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS bad_password_accounts (
            phone TEXT PRIMARY KEY,
            password TEXT,
            reported_at TEXT,
            status TEXT DEFAULT 'BAD_PASSWORD'
        )
    `);

    console.log('BWINNERS Location 4 database initialized.');
}

async function getAccounts() {
    const { rows } = await pool.query(
        'SELECT * FROM accounts ORDER BY phone ASC'
    );

    return rows.map(r => ({
        phone: r.phone,
        password: r.password,
        status: r.status,
        logoutTime: r.logout_time ? Number(r.logout_time) : null,
        logoutTimeStr: r.logout_time_str,
        lastHeartbeat: r.last_heartbeat ? Number(r.last_heartbeat) : null,
        inUseSince: r.in_use_since ? Number(r.in_use_since) : null,
        tabId: r.tab_id,
        freedAt: r.freed_at ? Number(r.freed_at) : null
    }));
}

async function getAccountByTabId(tabId) {
    const { rows } = await pool.query(
        `SELECT * FROM accounts
         WHERE tab_id = $1
         AND status = 'IN-USE'
         AND logout_time IS NULL
         LIMIT 1`,
        [tabId]
    );

    if (!rows.length) return null;

    const r = rows[0];

    return {
        phone: r.phone,
        password: r.password,
        status: r.status,
        logoutTime: r.logout_time ? Number(r.logout_time) : null,
        logoutTimeStr: r.logout_time_str,
        lastHeartbeat: r.last_heartbeat ? Number(r.last_heartbeat) : null,
        inUseSince: r.in_use_since ? Number(r.in_use_since) : null,
        tabId: r.tab_id,
        freedAt: r.freed_at ? Number(r.freed_at) : null
    };
}

async function claimFreeAccount(heartbeatNow, tabId) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const { rows } = await client.query(`
            SELECT phone, password
            FROM accounts
            WHERE status = 'FREE'
            ORDER BY freed_at ASC NULLS LAST
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        `);

        if (!rows.length) {
            await client.query('ROLLBACK');
            return null;
        }

        const account = rows[0];

        await client.query(`
            UPDATE accounts
            SET status = 'IN-USE',
                logout_time = NULL,
                logout_time_str = NULL,
                last_heartbeat = $2,
                in_use_since = $2,
                tab_id = $3,
                freed_at = NULL
            WHERE phone = $1
        `, [account.phone, heartbeatNow, tabId || null]);

        await client.query('COMMIT');

        return account;

    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function reLoginForTab(tabId, heartbeatNow, logoutTimeStr) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        if (tabId) {
            const { rows } = await client.query(`
                SELECT phone FROM accounts
                WHERE tab_id = $1
                AND status = 'IN-USE'
                AND logout_time IS NULL
                LIMIT 1
                FOR UPDATE SKIP LOCKED
            `, [tabId]);

            if (rows.length) {
                await client.query(`
                    UPDATE accounts
                    SET logout_time = $2,
                        logout_time_str = $3,
                        last_heartbeat = NULL,
                        in_use_since = NULL,
                        tab_id = NULL
                    WHERE phone = $1
                `, [rows[0].phone, heartbeatNow, logoutTimeStr + ' (re-login)']);
            }
        }

        const { rows: available } = await client.query(`
            SELECT phone, password
            FROM accounts
            WHERE status = 'FREE'
            ORDER BY freed_at ASC NULLS LAST
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        `);

        if (!available.length) {
            await client.query('ROLLBACK');
            return null;
        }

        const account = available[0];

        await client.query(`
            UPDATE accounts
            SET status = 'IN-USE',
                logout_time = NULL,
                logout_time_str = NULL,
                last_heartbeat = $2,
                in_use_since = $2,
                tab_id = $3,
                freed_at = NULL
            WHERE phone = $1
        `, [account.phone, heartbeatNow, tabId || null]);

        await client.query('COMMIT');

        return account;

    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function updateAccount(phone, fields) {
    const map = {
        logoutTime: 'logout_time',
        logoutTimeStr: 'logout_time_str',
        lastHeartbeat: 'last_heartbeat',
        status: 'status',
        inUseSince: 'in_use_since',
        tabId: 'tab_id',
        freedAt: 'freed_at'
    };

    const keys = Object.keys(fields);

    if (!keys.length) return;

    const clauses = keys.map((key, index) => {
        if (!map[key]) throw new Error('Invalid account field: ' + key);
        return map[key] + ' = $' + (index + 1);
    });

    const values = keys.map(key => fields[key]);
    values.push(phone);

    await pool.query(
        `UPDATE accounts SET ${clauses.join(', ')} WHERE phone = $${values.length}`,
        values
    );
}

async function addAccount(phone, password) {
    await pool.query(
        `INSERT INTO accounts (phone, password, status)
         VALUES ($1, $2, 'FREE')`,
        [phone, password]
    );
}

async function removeAccount(phone) {
    await pool.query('DELETE FROM accounts WHERE phone = $1', [phone]);
}

async function resetAllAccounts() {
    await pool.query(`
        UPDATE accounts
        SET status = 'FREE',
            logout_time = NULL,
            logout_time_str = NULL,
            last_heartbeat = NULL,
            in_use_since = NULL,
            tab_id = NULL,
            freed_at = NULL
    `);
}

async function deleteAllAccounts() {
    await pool.query('DELETE FROM accounts');
}

async function getBadPasswordAccounts() {
    const { rows } = await pool.query(
        'SELECT * FROM bad_password_accounts ORDER BY reported_at DESC'
    );

    return rows.map(r => ({
        phone: r.phone,
        password: r.password,
        reportedAt: r.reported_at,
        status: r.status
    }));
}

async function addBadPasswordAccount(phone, password, reportedAt) {
    await pool.query(`
        INSERT INTO bad_password_accounts (phone, password, reported_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (phone) DO UPDATE
        SET password = EXCLUDED.password,
            reported_at = EXCLUDED.reported_at
    `, [phone, password, reportedAt]);
}

async function removeBadPasswordAccount(phone) {
    await pool.query(
        'DELETE FROM bad_password_accounts WHERE phone = $1',
        [phone]
    );
}

function getZambiaTime() {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: TIMEZONE,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(new Date());

    const values = {};
    for (const part of parts) {
        values[part.type] = part.value;
    }

    return {
        hour: Number(values.hour),
        minute: Number(values.minute),
        second: Number(values.second)
    };
}

module.exports = {
    pool,
    initDB,
    getAccounts,
    getAccountByTabId,
    claimFreeAccount,
    reLoginForTab,
    updateAccount,
    addAccount,
    removeAccount,
    resetAllAccounts,
    deleteAllAccounts,
    getBadPasswordAccounts,
    addBadPasswordAccount,
    removeBadPasswordAccount,
    getZambiaTime,
    ACCOUNT_LOCK_MS,
    REMOVE_PASSWORD,
    HEARTBEAT_TIMEOUT_MS,
    TIMEZONE
};
