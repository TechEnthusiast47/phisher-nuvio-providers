const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');

const PORT = process.env.PORT || 3000;

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces ) {
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

const TMDB_API = 'https://api.themoviedb.org/3';
const TMDB_KEY = 'df5dcd6d4165ec9331b40b47411256c4'; // ta clé

const server = http.createServer(async (req, res) => {
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
  const query = parsedUrl.query;

  // Route API
  if (pathname === '/api/getStreams') {
    const tmdbId = query.tmdbId;
    const mediaType = query.mediaType || 'movie';
    const seasonNum = parseInt(query.seasonNum) || null;
    const episodeNum = parseInt(query.episodeNum) || null;
    const specificProvider = query.provider;

    if (!tmdbId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'tmdbId manquant' }));
      return;
    }

    try {
      // 1. Récupérer les infos officielles du film/série
      const detailUrl = `${TMDB_API}/${mediaType === 'tv' ? 'tv' : 'movie'}/${tmdbId}?api_key=${TMDB_KEY}&language=fr`;
      const detailRes = await fetch(detailUrl);
      if (!detailRes.ok) throw new Error('TMDB pas trouvé');
      const detailData = await detailRes.json();

      const originalTitle = detailData.title || detailData.original_name || detailData.original_title;
      const realYear = new Date(detailData.release_date || detailData.first_air_date).getFullYear();
      const realType = mediaType; // movie ou tv

      console.log(`Vérification TMDB: ${originalTitle} (${realYear})`);

      const manifestPath = path.join(__dirname, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const providersToRun = specificProvider
        ? manifest.scrapers.filter(s => s.id === specificProvider && s.enabled)
        : manifest.scrapers.filter(s => s.enabled && (!s.id.includes('HiAnime') || mediaType === 'tv')); // On garde HiAnime pour tv seulement

      console.log(`Providers lancés: ${providersToRun.map(p => p.id).join(', ')}`);

      const allStreams = [];

      for (const provider of providersToRun) {
        try {
          const providerPath = path.join(__dirname, provider.filename);
          const providerModule = require(providerPath);
          if (!providerModule.getStreams) continue;

          const result = await providerModule.getStreams(tmdbId, mediaType, seasonNum, episodeNum);
          if (!result || !Array.isArray(result)) continue;

          result.forEach(stream => {
            stream.fromProvider = provider.id;
            // Vérif rapide de correspondance
            if (stream.title && !stream.title.includes(originalTitle) && !stream.title.toLowerCase().includes(originalTitle.toLowerCase())) {
              console.warn(`${provider.id}: titre ne correspond pas -> jeté`);
              return;
            }
            // Vérif année (approximative)
            if (stream.year && Math.abs(stream.year - realYear) > 2) {
              console.warn(`${provider.id}: année différente (${stream.year} vs ${realYear}) -> jeté`);
              return;
            }
            // Vérif type
            if (realType === 'movie' && stream.isSeries) {
              console.warn(`${provider.id}: c'est une série, mais demandé un film -> jeté`);
              return;
            }
            allStreams.push(stream);
          });
        } catch (err) {
          console.error(`Erreur ${provider.id}:`, err.message);
        }
      }

      // Dédoublons + tri qualité
      const seen = new Set();
      const uniqueStreams = allStreams.filter(s => {
        if (seen.has(s.url)) return false;
        seen.add(s.url);
        return true;
      }).sort((a, b) => (b.quality === '2160p' ? 10 : b.quality === '1080p' ? 9 : 8) - (a.quality === '2160p' ? 10 : a.quality === '1080p' ? 9 : 8));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(uniqueStreams));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Fichiers statiques
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403); res.end('Nope');
    return;
  }
  const extname = path.extname(filePath);
  const contentType = mimeTypes || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT' && pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Serveur Nuvio. Utilise /api/getStreams ?tmdbId=...');
      } else res.writeHead(500); res.end('Erreur');
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Serveur sur http://${getLocalIp()}:${PORT}/`);
});
