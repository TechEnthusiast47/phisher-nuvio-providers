const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');

const PORT = process.env.PORT || 3000;

// Headers communs ultra-réalistes (imitent un iPhone Safari 2026)
const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Origin': 'https://novelhubapp.com',
  'Referer': 'https://novelhubapp.com/',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'Connection': 'keep-alive',
  'X-Requested-With': 'XMLHttpRequest'
};

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

const server = http.createServer(async (req, res) => {
  console.log(`${req.method} ${req.url}`);

  // CORS ouvert
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
  const query = parsedUrl.query;

  // Route racine
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      message: "API Nuvio Providers active – Headers renforcés pour contourner Cloudflare",
      endpoints: {
        getStreams: "/api/getStreams?tmdbId=19995&mediaType=movie",
        manifest: "/manifest.json"
      },
      note: "HiAnime ignoré pour mediaType=movie"
    }));
    return;
  }

  // Route streams
  if (pathname === '/api/getStreams') {
    const tmdbId = query.tmdbId;
    const mediaType = query.mediaType || 'movie';
    const seasonNum = query.seasonNum ? parseInt(query.seasonNum) : null;
    const episodeNum = query.episodeNum ? parseInt(query.episodeNum) : null;
    const specificProvider = query.provider;

    if (!tmdbId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'tmdbId obligatoire' }));
      return;
    }

    try {
      const manifestPath = path.join(__dirname, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

      const allStreams = [];

      const providersToRun = specificProvider
        ? manifest.scrapers.filter(s => s.id === specificProvider && s.enabled)
        : manifest.scrapers.filter(s => s.enabled);

      console.log(`Providers lancés : ${providersToRun.map(p => p.id).join(', ')}`);

      for (const provider of providersToRun) {
        // Filtre HiAnime : uniquement pour séries (tv)
        if (provider.id === 'HiAnime' && mediaType === 'movie') {
          console.log('HiAnime ignoré : mediaType = movie (films live-action)');
          continue;
        }

        try {
          const providerPath = path.join(__dirname, provider.filename);
          const providerModule = require(providerPath);

          if (typeof providerModule.getStreams !== 'function') {
            console.warn(`Provider ${provider.id} sans getStreams`);
            continue;
          }

          // On passe les headers communs au provider (il peut les overrider)
          const result = await providerModule.getStreams(tmdbId, mediaType, seasonNum, episodeNum, COMMON_HEADERS);

          if (result && Array.isArray(result) && result.length > 0) {
            result.forEach(stream => {
              stream.fromProvider = provider.id;
              allStreams.push(stream);
            });
            console.log(`${provider.id} → ${result.length} streams`);
          } else {
            console.log(`${provider.id} → aucun stream`);
          }
        } catch (err) {
          console.error(`Erreur ${provider.id} :`, err.message);
        }
      }

      // Dédoublonnage + tri
      const uniqueStreams = [];
      const seenUrls = new Set();

      allStreams.forEach(stream => {
        if (stream.url && !seenUrls.has(stream.url)) {
          seenUrls.add(stream.url);
          uniqueStreams.push(stream);
        }
      });

      const qualOrder = { '2160p': 5, '1440p': 4, '1080p': 3, '720p': 2, '480p': 1, 'Unknown': 0 };
      uniqueStreams.sort((a, b) => (qualOrder[b.quality] || 0) - (qualOrder[a.quality] || 0));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(uniqueStreams));
    } catch (err) {
      console.error('Erreur globale :', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erreur serveur', details: err.message }));
    }
    return;
  }

  // Servir manifest ou fichiers statiques
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Accès interdit');
    return;
  }

  const extname = path.extname(filePath);
  const contentType = mimeTypes[extname] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end(`Non trouvé : ${req.url}`);
      } else {
        res.writeHead(500);
        res.end('Erreur serveur');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  const ip = getLocalIp();
  console.log(`Serveur lancé sur http://${ip}:${PORT}/`);
  console.log(`Manifest : http://${ip}:${PORT}/manifest.json`);
  console.log(`API : http://${ip}:${PORT}/api/getStreams?tmdbId=19995&mediaType=movie`);
});
