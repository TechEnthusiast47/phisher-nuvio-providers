const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');

const PORT = process.env.PORT || 3000;

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

  // Route racine : infos claires
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      message: "API Nuvio Providers (mise à jour) – HiAnime limité aux séries/anime",
      endpoints: {
        getStreams: "/api/getStreams?tmdbId=19995&mediaType=movie",
        manifest: "/manifest.json",
        exemples: [
          "Film Avatar: /api/getStreams?tmdbId=19995&mediaType=movie",
          "Anime film (Demon Slayer): /api/getStreams?tmdbId=129003&mediaType=movie",
          "Série anime (One Piece): /api/getStreams?tmdbId=37854&mediaType=tv&seasonNum=1&episodeNum=1"
        ]
      },
      note: "HiAnime ignoré pour les films live-action (mediaType=movie)"
    }));
    return;
  }

  // Route principale : streams
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

      console.log(`Providers à exécuter : ${providersToRun.map(p => p.id).join(', ')}`);

      for (const provider of providersToRun) {
        // Règle stricte : HiAnime → uniquement séries (tv) ou anime films
        if (provider.id === 'HiAnime') {
          if (mediaType === 'movie') {
            console.log('HiAnime ignoré : mediaType = movie (films live-action)');
            continue;
          }
          // Si c'est une série, on laisse passer
          console.log('HiAnime autorisé : mediaType = tv');
        }

        try {
          const providerPath = path.join(__dirname, provider.filename);
          const providerModule = require(providerPath);

          if (typeof providerModule.getStreams !== 'function') {
            console.warn(`Provider ${provider.id} sans getStreams`);
            continue;
          }

          const result = await providerModule.getStreams(tmdbId, mediaType, seasonNum, episodeNum);

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

      // Dédoublonnage + tri qualité
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
