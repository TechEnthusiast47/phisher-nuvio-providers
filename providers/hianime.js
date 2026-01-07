// HiAnime Scraper for Nuvio Local Scrapers

const cheerio = require('cheerio-without-node-native');

const HIANIME_APIS = [
    "https://hianimez.is",
    "https://hianimez.to",
    "https://hianime.nz",
    "https://hianime.bz",
    "https://hianime.pe"
];

const AJAX_HEADERS = {
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': 'https://hianime.to/',
    'User-Agent': 'Mozilla/5.0'
};


// Extractor functions for HiAnime

async function extractMegacloud(embedUrl, effectiveType) {
    const mainUrl = 'https://megacloud.blog';

    const headers = {
        'Accept': '*/*',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': mainUrl,
        'User-Agent': 'Mozilla/5.0'
    };

    const pageRes = await fetch(embedUrl, { headers });
    if (!pageRes.ok) return [];

    const page = await pageRes.text();

    let nonce =
        page.match(/\b[a-zA-Z0-9]{48}\b/)?.[0] ??
        (() => {
            const m = page.match(
                /\b([a-zA-Z0-9]{16})\b.*?\b([a-zA-Z0-9]{16})\b.*?\b([a-zA-Z0-9]{16})\b/
            );
            return m ? m[1] + m[2] + m[3] : null;
        })();

    if (!nonce) return [];

    const id = embedUrl.split('/').pop().split('?')[0];
    const apiUrl = `${mainUrl}/embed-2/v3/e-1/getSources?id=${id}&_k=${nonce}`;

    const sourceRes = await fetch(apiUrl, { headers });
    if (!sourceRes.ok) return [];

    const json = await sourceRes.json();
    if (!json?.sources?.length) return [];

    let m3u8;

    const encoded = json.sources[0].file;
    if (encoded.includes('.m3u8')) {
        m3u8 = encoded;
    } else {
        const keyRes = await fetch(
            'https://raw.githubusercontent.com/yogesh-hacker/MegacloudKeys/refs/heads/main/keys.json'
        );
        if (!keyRes.ok) return [];

        const keys = await keyRes.json();
        const secret = keys?.mega;
        if (!secret) return [];

        const decodeUrl =
            'https://script.google.com/macros/s/AKfycbxHbYHbrGMXYD2-bC-C43D3njIbU-wGiYQuJL61H4vyy6YVXkybMNNEPJNPPuZrD1gRVA/exec';

        const fullUrl =
            `${decodeUrl}?encrypted_data=${encodeURIComponent(encoded)}` +
            `&nonce=${encodeURIComponent(nonce)}` +
            `&secret=${encodeURIComponent(secret)}`;

        const decodedRes = await fetch(fullUrl);
        if (!decodedRes.ok) return [];

        const decodedText = await decodedRes.text();
        m3u8 = decodedText.match(/"file":"(.*?)"/)?.[1];
        if (!m3u8) return [];
    }

    return [{
        url: m3u8,
        type: effectiveType,
        subtitles: json.tracks
            ?.filter(t => t.kind === 'captions' || t.kind === 'subtitles')
            ?.map(t => ({
                label: t.label,
                url: t.file
            })) ?? []
    }];
}

// ================= TMDB CONFIG =================

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// ================= HELPERS =================


async function fetchJsonWithTimeout(url, headers, timeoutMs = 10_000) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(url, { headers, signal: controller.signal });
        if (!res.ok) return null;
        return await res.json();
    } finally {
        clearTimeout(t);
    }
}


async function tmdbFetch(path) {
    const url = `${TMDB_BASE_URL}${path}?api_key=${TMDB_API_KEY}`;
    const res = await fetch(url, {
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0'
        }
    });
    if (!res.ok) throw new Error(`TMDB ${res.status}`);
    return res.json();
}

async function getTMDBDetails(tmdbId, mediaType) {
    if (mediaType === 'movie') {
        const data = await tmdbFetch(`/movie/${tmdbId}`);
        return {
            title: data.title,
            releaseDate: data.release_date ?? null,
            firstAirDate: null,
            year: data.release_date
                ? Number(data.release_date.split('-')[0])
                : null
        };
    }

    const data = await tmdbFetch(`/tv/${tmdbId}`);
    return {
        title: data.name,
        releaseDate: data.first_air_date ?? null, // S1 date
        firstAirDate: data.first_air_date ?? null,
        year: data.first_air_date
            ? Number(data.first_air_date.split('-')[0])
            : null
    };
}

// 🔥 THIS WAS MISSING
async function getTMDBSeasonAirDate(tmdbId, seasonNumber) {
    const data = await tmdbFetch(`/tv/${tmdbId}/season/${seasonNumber}`);
    return data.air_date ?? null;
}

// ================= ANILIST / MAL =================

const ANILIST_API = 'https://graphql.anilist.co';

async function getHiAnimeIdFromMalSync(malId) {
    try {
        const res = await fetch(`https://api.malsync.moe/mal/anime/${malId}`);
        if (!res.ok) return null;

        const json = await res.json();
        const zoro = json?.Sites?.Zoro;
        if (!zoro) return null;
        const entry = Object.values(zoro)[0];
        return entry?.identifier ?? null;
    } catch {
        return null;
    }
}


function getSeason(month) {
    if (!month) return null;
    if (month <= 3) return 'WINTER';
    if (month <= 6) return 'SPRING';
    if (month <= 9) return 'SUMMER';
    return 'FALL';
}

// ================= ANILIST LOOKUP =================

async function tmdbToAnimeId(title, year, type) {
    if (!title || !year) return { id: null, idMal: null };

    const query = `
        query ($search: String, $seasonYear: Int) {
          Page(perPage: 5) {
            media(
              search: $search
              seasonYear: $seasonYear
              type: ANIME
              format_in: [TV, ONA, MOVIE]
            ) {
              id
              idMal
            }
          }
        }
    `;

    const res = await fetch(ANILIST_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            query,
            variables: { search: title, seasonYear: year }
        })
    });

    if (!res.ok) return { id: null, idMal: null };
    const json = await res.json();
    const media = json?.data?.Page?.media?.[0];
    return { id: media?.id ?? null, idMal: media?.idMal ?? null };
}

async function convertTmdbToAnimeId(title, date, airedDate, type) {
    const primaryYear = date ? Number(date.split('-')[0]) : null;
    const airedYear = airedDate ? Number(airedDate.split('-')[0]) : null;

    const ids = await tmdbToAnimeId(title, primaryYear, type);

    if (!ids.id && airedYear && airedYear !== primaryYear) {
        return tmdbToAnimeId(title, airedYear, type);
    }
    return ids;
}

// ================= Main Logic =================

function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
    return getTMDBDetails(tmdbId, mediaType).then(async mediaInfo => {

        let airedDate = mediaInfo.firstAirDate;

        // fetch correct season air date (S2+)
        if (mediaType === 'tv' && season && season > 1) {
            airedDate = await getTMDBSeasonAirDate(tmdbId, season);
        }

        const aniSearchTitle =
            mediaType === 'tv' && season
                ? `${mediaInfo.title} Season ${season}`
                : mediaInfo.title;

        const { idMal } = await convertTmdbToAnimeId(
            aniSearchTitle,
            mediaType === 'tv' ? airedDate : mediaInfo.releaseDate,
            airedDate,
            season == null ? 'AnimeMovie' : 'Anime'
        );

        const hiAnimeId = idMal
            ? await getHiAnimeIdFromMalSync(idMal)
            : null;

        console.log('[HiAnime] ID:', hiAnimeId);

        if (!hiAnimeId) return [];

        const episodeNumber = String(episode ?? 1);
        const shuffledApis = [...HIANIME_APIS].sort(() => Math.random() - 0.5);

        for (const api of shuffledApis) {
            try {

                /* ======== episode list ======== */

                const listRes = await fetchJsonWithTimeout(
                    `${api}/ajax/v2/episode/list/${hiAnimeId}`,
                    AJAX_HEADERS
                );

                if (!listRes?.html) continue;

                const $list = cheerio.load(listRes.html);

                const episodeId = $list('div.ss-list a')
                    .filter((_, el) => $list(el).attr('data-number') === episodeNumber)
                    .first()
                    .attr('data-id');

                console.log('[HiAnime] Fetched episode list from', episodeId);


                if (!episodeId) continue;

                /* ======== servers ======== */

                const serversRes = await fetchJsonWithTimeout(
                    `${api}/ajax/v2/episode/servers?episodeId=${episodeId}`,
                    AJAX_HEADERS
                );

                if (!serversRes?.html) continue;

                const $servers = cheerio.load(serversRes.html);

                const servers = $servers('div.item.server-item')
                    .map((_, el) => {
                        const type = $servers(el).attr('data-type');
                        return {
                            label: $servers(el).text().trim(),
                            serverId: $servers(el).attr('data-id'),
                            effectiveType: type === 'raw' ? 'SUB' : type.toUpperCase()
                        };
                    })
                    .get();

                console.log('[HiAnime] Found', servers.length, 'servers');


                /* ======== sources ======== */

                const streams = [];

                for (const server of servers) {
                    if (!server.serverId) continue;

                    const effectiveType = server.effectiveType;

                    try {
                        const sourceRes = await fetchJsonWithTimeout(
                            `${api}/ajax/v2/episode/sources?id=${server.serverId}`,
                            AJAX_HEADERS
                        );

                        const embedUrl = sourceRes?.link;
                        if (!embedUrl) continue;

                        console.log(`[HiAnime] Embed found: ${server.label} (${effectiveType})`);

                        if (embedUrl.includes('megacloud')) {
                            const extracted = await extractMegacloud(embedUrl, effectiveType);

                            for (const stream of extracted) {
                                streams.push({
                                    name: `⌜ HiAnime ⌟ | ${server.label.toUpperCase()} | ${stream.type}`,
                                    title:
                                        mediaType === 'tv'
                                            ? `${mediaInfo.title} S${String(season).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`
                                            : mediaInfo.title,
                                    url: stream.url,
                                    quality: '1080p',
                                    provider: 'HiAnime',
                                    malId: idMal,
                                    type: stream.type,
                                    subtitles: stream.subtitles
                                });
                            }
                        }
                    } catch {
                        console.debug('[HiAnime] Server failed:', server.label);
                    }
                }



                if (streams.length > 0) {
                    return streams; // success
                }
            } catch (e) {
                console.warn(`[HiAnime] Failed on ${api}: ${e.message}`);
            }
        }

        return [];
    }).catch(() => []);
}


// ================= EXPORT =================

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getStreams };
} else {
    // For React Native environment
    global.getStreams = { getStreams };
}
// 