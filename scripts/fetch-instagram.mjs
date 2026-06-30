// Fetches the live @thryveops Instagram feed (latest posts + follower count) via
// the Instagram Graph API (Instagram Login) and bakes it into index.html between
// the IG_FOLLOWERS / IG_FEED markers. Post images are downloaded into
// images/ig_live/ so we serve our own copies (Instagram CDN URLs expire).
//
// Zero dependencies — uses Node 18+ global fetch and node:fs.
// Required env: IG_ACCESS_TOKEN (a long-lived Instagram token).

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.IG_ACCESS_TOKEN;
const MAX_POSTS = 4;
const GRAPH = 'https://graph.instagram.com';
const ROOT = process.cwd();
const HTML_FILE = path.join(ROOT, 'index.html');
const IMG_DIR = path.join(ROOT, 'images', 'ig_live');
const IMG_REL = 'images/ig_live';

if (!TOKEN) {
  console.error('ERROR: IG_ACCESS_TOKEN env var is missing.');
  process.exit(1);
}

async function api(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Instagram API ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function formatFollowers(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function formatDate(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return 'Instagram';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function captionTitle(caption) {
  const firstLine = (caption || '').split('\n')[0].replace(/#[^\s#]+/g, '').trim();
  return firstLine ? truncate(firstLine, 56) : 'View on Instagram';
}

function cardHTML(src, title, tag, permalink, idx) {
  const fd = idx > 0 ? ` fd${idx + 1}` : '';
  return `        <a class="ig-card fade-up${fd}" href="${permalink}" target="_blank" rel="noopener" aria-label="View on Instagram">
          <img src="${src}" alt="${title}" class="ig-img" loading="lazy">
          <div class="ig-overlay">
            <span class="ig-tag">${tag}</span>
            <div class="ig-post-title">${title}</div>
          </div>
        </a>`;
}

function followersHTML(count, username) {
  return `        <a class="ig-followers" href="https://www.instagram.com/${username}/" target="_blank" rel="noopener">
          <span class="ig-followers-count">${formatFollowers(count)}</span>
          <span class="ig-followers-label">followers and growing</span>
        </a>`;
}

function replaceBetween(html, name, content) {
  const re = new RegExp(`(<!-- ${name}_START -->)[\\s\\S]*?(<!-- ${name}_END -->)`);
  if (!re.test(html)) throw new Error(`Marker ${name} not found in index.html`);
  return html.replace(re, `$1\n${content}\n        $2`);
}

// 1. Profile (live follower count)
const profile = await api(`${GRAPH}/me?fields=username,followers_count,media_count&access_token=${TOKEN}`);
console.log(`Profile: @${profile.username} — ${profile.followers_count} followers, ${profile.media_count} posts`);

// 2. Latest media
const media = await api(`${GRAPH}/me/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp&limit=12&access_token=${TOKEN}`);
const posts = (media.data || []).slice(0, MAX_POSTS);
console.log(`Fetched ${posts.length} post(s).`);

// 3. Download images we don't already have; track what's current
await mkdir(IMG_DIR, { recursive: true });
const needed = new Set();
const cards = [];

for (let i = 0; i < posts.length; i++) {
  const p = posts[i];
  const imgUrl = p.media_type === 'VIDEO' ? (p.thumbnail_url || p.media_url) : p.media_url;
  if (!imgUrl) { console.warn(`Skipping post ${p.id} (no image url).`); continue; }
  const file = `post-${p.id}.jpg`;
  needed.add(file);
  const dest = path.join(IMG_DIR, file);
  if (!existsSync(dest)) {
    const r = await fetch(imgUrl);
    if (!r.ok) throw new Error(`Image download failed for ${p.id}: ${r.status}`);
    await writeFile(dest, Buffer.from(await r.arrayBuffer()));
    console.log(`Downloaded ${file}`);
  }
  const title = escapeHtml(captionTitle(p.caption));
  cards.push(cardHTML(`${IMG_REL}/${file}`, title, formatDate(p.timestamp), p.permalink, i));
}

if (cards.length === 0) {
  console.error('No usable posts returned — leaving existing feed untouched.');
  process.exit(1);
}

// 4. Prune images for posts that are no longer in the feed
for (const f of await readdir(IMG_DIR)) {
  if (f.startsWith('post-') && !needed.has(f)) {
    await unlink(path.join(IMG_DIR, f));
    console.log(`Pruned ${f}`);
  }
}

// 5. Bake into index.html
let html = await readFile(HTML_FILE, 'utf8');
html = replaceBetween(html, 'IG_FOLLOWERS', followersHTML(profile.followers_count, profile.username));
html = replaceBetween(html, 'IG_FEED', cards.join('\n'));
await writeFile(HTML_FILE, html);
console.log('index.html updated with live Instagram feed.');
