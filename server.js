        } catch (e) {
            console.error('cashout error:', e);
            res.status(500).json({ ok: false });
        }
    });

    app.get(base + '/alerts', async (req, res) => {
        try {
            const { rows } = await pool.query(
                'SELECT * FROM ' + alertsTable + ' ORDER BY id DESC'
            );
            res.json(rows);
        } catch (e) {
            res.status(500).json([]);
        }
    });

    app.post(base + '/clear-alerts', async (req, res) => {
        try {
            await pool.query('DELETE FROM ' + alertsTable);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    app.post(base + '/reset', async (req, res) => {
        try {
            const { pin } = req.body;

            if (pin !== REMOVE_PASSWORD) {
                return res.json({
                    success: false,
                    error: 'Incorrect password.'
                });
            }

            await store.resetAllAccounts();
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    app.post(base + '/wipe-all-accounts', async (req, res) => {
        try {
            const { pin } = req.body;

            if (pin !== REMOVE_PASSWORD) {
                return res.json({
                    success: false,
                    error: 'Incorrect password.'
                });
            }

            await store.deleteAllAccounts();
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    // MAIN DASHBOARD
    app.get(base + '/', async (req, res) => {
        try {
            const accounts = await store.getAccounts();
            const badPassword = await store.getBadPasswordAccounts();

            const free = accounts.filter(a => a.status === 'FREE').length;
            const inUse = accounts.filter(a =>
                a.status === 'IN-USE' && !a.logoutTime
            ).length;
            const waiting = accounts.filter(a =>
                a.status === 'IN-USE' && a.logoutTime
            ).length;

            const { hour, minute, second } = getZambiaTime();

            res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BWINNERS - Account Dashboard</title>
<style>
body{margin:0;background:#0b1220;color:#e5e7eb;font-family:Arial,sans-serif;padding:20px}
.wrap{max-width:1100px;margin:auto}
.header{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
h1{font-size:22px;margin:0}
.clock{color:#94a3b8;font-size:13px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:20px 0}
.stat{background:#111c30;border:1px solid #26364e;padding:18px;border-radius:12px}
.stat-number{font-size:28px;font-weight:bold}
.stat-label{font-size:12px;color:#94a3b8;margin-top:6px}
.free{color:#22c55e}.inuse{color:#38bdf8}.waiting{color:#fbbf24}.bad{color:#f87171}
.panel{background:#111c30;border:1px solid #26364e;border-radius:12px;padding:18px;margin-bottom:16px}
.panel-title{font-size:15px;font-weight:bold;margin-bottom:14px}
.form{display:grid;grid-template-columns:1fr 1fr auto;gap:10px}
input{width:100%;box-sizing:border-box;background:#07101f;border:1px solid #334155;color:#fff;border-radius:8px;padding:12px}
button{border:0;border-radius:8px;background:#2563eb;color:#fff;padding:11px 16px;font-weight:bold;cursor:pointer}
button:disabled{opacity:.5}
.links{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.links a{background:#1e293b;color:#cbd5e1;text-decoration:none;padding:9px 12px;border-radius:7px;font-size:12px}
.message{font-size:12px;margin-top:10px}
.alert-row{display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid #26364e;padding:10px 0;font-size:12px}
.alert-row:last-child{border:0}
.muted{color:#94a3b8}
@media(max-width:650px){.stats{grid-template-columns:repeat(2,1fr)}.form{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
<div class="header">
    <h1>&#127918; BWINNERS - Location 4</h1>
    <div class="clock" id="clock">${pad(hour)}:${pad(minute)}:${pad(second)} Africa/Lusaka</div>
</div>

<div class="stats">
    <div class="stat"><div class="stat-number free" id="free">${free}</div><div class="stat-label">FREE ACCOUNTS</div></div>
    <div class="stat"><div class="stat-number inuse" id="inuse">${inUse}</div><div class="stat-label">IN USE</div></div>
    <div class="stat"><div class="stat-number waiting" id="waiting">${waiting}</div><div class="stat-label">WAITING 24 HOURS</div></div>
    <div class="stat"><div class="stat-number bad" id="bad">${badPassword.length}</div><div class="stat-label">BAD PASSWORD</div></div>
</div>

<div class="panel">
    <div class="panel-title">Add BWINNERS account</div>
    <form class="form" id="addForm">
        <input id="phone" placeholder="Phone number" required>
        <input id="password" placeholder="Password" required>
        <button id="addBtn" type="submit">ADD ACCOUNT</button>
    </form>
    <div class="message" id="message"></div>
    <div class="links">
        <a href="${base}/view/free">Free accounts</a>
        <a href="${base}/view/inuse">In-use accounts</a>
        <a href="${base}/view/waiting">Waiting accounts</a>
        <a href="${base}/view/bad">Bad password accounts</a>
    </div>
</div>

<div class="panel">
    <div class="panel-title">Low balance alerts</div>
    <div id="alerts"><div class="muted">Loading alerts...</div></div>
</div>

<div style="text-align:center;color:#64748b;font-size:11px;margin-top:20px">
    BWINNERS - Location 4
</div>
</div>

<script>
const BASE = ${JSON.stringify(base)};

document.getElementById('addForm').addEventListener('submit', async function(e) {
    e.preventDefault();

    const phone = document.getElementById('phone').value.trim();
    const password = document.getElementById('password').value;
    const btn = document.getElementById('addBtn');
    const message = document.getElementById('message');

    btn.disabled = true;
    message.textContent = 'Adding account...';

    try {
        const response = await fetch('/add-account', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, password })
        });

        const data = await response.json();

        if (data.success) {
            message.style.color = '#22c55e';
            message.textContent = 'Account added successfully.';
            document.getElementById('phone').value = '';
            document.getElementById('password').value = '';
            refreshStats();
        } else {
            message.style.color = '#f87171';
            message.textContent = data.error || 'Unable to add account.';
        }
    } catch (e) {
        message.style.color = '#f87171';
        message.textContent = 'Connection error.';
    } finally {
        btn.disabled = false;
    }
});

async function refreshStats() {
    try {
        const response = await fetch(BASE + '/stats');
        const data = await response.json();

        document.getElementById('free').textContent = data.free || 0;
        document.getElementById('inuse').textContent = data.inUse || 0;
        document.getElementById('waiting').textContent = data.waiting || 0;
        document.getElementById('bad').textContent = data.badPassword || 0;
    } catch (e) {}
}

async function refreshAlerts() {
    try {
        const response = await fetch(BASE + '/alerts');
        const items = await response.json();
        const container = document.getElementById('alerts');

        if (!items.length) {
            container.innerHTML = '<div class="muted">No low balance alerts yet.</div>';
            return;
        }

        container.innerHTML = items.slice(0, 20).map(item => {
            const amount = Number(item.amount || 0).toFixed(2);
            const time = item.timestamp
                ? new Date(Number(item.timestamp)).toLocaleString()
                : '';
            return '<div class="alert-row"><span>' +
                String(item.tab_id || item.tabId || 'Unknown') +
                '</span><span>K' + amount + '</span><span class="muted">' +
                time + '</span></div>';
        }).join('');
    } catch (e) {
        document.getElementById('alerts').innerHTML =
            '<div class="muted">Unable to load alerts.</div>';
    }
}

function updateClock() {
    document.getElementById('clock').textContent =
        new Date().toLocaleTimeString('en-GB', { timeZone: 'Africa/Lusaka' }) +
        ' Africa/Lusaka';
}

refreshStats();
refreshAlerts();
updateClock();
setInterval(refreshStats, 5000);
setInterval(refreshAlerts, 5000);
setInterval(updateClock, 1000);
</script>
</body>
</html>`);
        } catch (e) {
            console.error('dashboard error:', e);
            res.status(500).send('Error: ' + e.message);
        }
    });
