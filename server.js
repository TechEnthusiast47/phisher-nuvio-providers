const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');

const PORT = 3000;

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

const mimeTypes = {
    '.json': 'application/json',
    '.js': 'application/javascript',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.html': 'text/html',
};

const server = http.createServer((req, res) => {
    console.log(`${req.method} ${req.url}`);

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // Route API : /api/getStreams (globale ou ciblée)
    if (pathname === '/api/getStreams') {
        const query = parsedUrl.query;
        const tmdbId = query.tmdbId;
        const mediaType = query.mediaType || 'movie';
        const season = parseInt(query.season) || null;
        const episode = parseInt(query.episode) || null;
        const specificProvider = query.provider; // optionnel

        if (!tmdbId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing tmdbId' }));
            return;
        }

        try {
            const manifestPath = path.join(__dirname, 'manifest.json');
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

            const allResults = [];

            // Si provider spécifique demandé → filtre
            const scrapersToRun = specificProvider 
                ? manifest.scrapers.filter(s => s.id === specificProvider && s.enabled)
                : manifest.scrapers.filter(s => s.enabled);

            for (const scraper of scrapersToRun) {
                try {
                    const providerPath = path.join(__dirname, scraper.filename);
                    const providerModule = require(providerPath);

                    const streams = await providerModule.getStreams(tmdbId, mediaType, season, episode);

                    streams.forEach(s => {
                        s.fromProvider = scraper.id;
                        allResults.push(s);
                    });
                } catch (err) {
                    console.error(`Error in provider ${scraper.id}:`, err.message);
                }
            }

            // Dédoublonnage par URL + tri par qualité
            const uniqueStreams = [];
            const seenUrls = new Set();

            allResults.forEach(stream => {
                if (stream.url && !seenUrls.has(stream.url)) {
                    seenUrls.add(stream.url);
                    uniqueStreams.push(stream);
                }
            });

            // Tri qualité (meilleur d'abord)
            const qualOrder = { '2160p': 5, '1440p': 4, '1080p': 3, '720p': 2, '480p': 1, 'Unknown': 0 };
            uniqueStreams.sort((a, b) => (qualOrder[b.quality] || 0) - (qualOrder[a.quality] || 0));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(uniqueStreams));
        } catch (err) {
            console.error('Global error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
        return;
    }

    // Logique originale pour servir fichiers (manifest, logos, etc.)
    let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);

    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov'];
    const extname = path.extname(filePath);
    let contentType = mimeTypes[extname] || 'application/octet-stream';
    if (videoExtensions.includes(extname)) {
        contentType = "video/mp4";
    }

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                if (pathname === '/') {
                    res.writeHead(200, { 'Content-Type': 'text/plain' });
                    res.end('Nuvio Providers Server Running. Access /manifest.json or /api/getStreams');
                    return;
                }
                res.writeHead(404);
                res.end(`File not found: ${req.url}`);
            } else {
                res.writeHead(500);
                res.end(`Server Error: ${err.code}`);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

server.listen(PORT, () => {
    const ip = getLocalIp();
    console.log(`\n🚀 Server running at: http://${ip}:${PORT}/`);
    console.log(`📝 Manifest: http://${ip}:${PORT}/manifest.json`);
    console.log('API: http://${ip}:${PORT}/api/getStreams?tmdbId=27205&mediaType=movie');
    console.log('Press Ctrl+C to stop\n');
});
