// Local fixture site reproducing the www.smcgov.org ground-truth cases from the spec (§14) plus edge cases.
// Usage: node test/fixture-site/server.js [port]   (default 8765)
import http from 'node:http';
import zlib from 'node:zlib';

const PORT = Number(process.argv[2] || process.env.FIXTURE_PORT || 8765);
const HOST = `localhost:${PORT}`;
const BASE = `http://${HOST}`;
const EQUITY = 'e04627c3dc7a4c38a6ebb9f0d5b8dff1';
const ROADS = 'c7075a28b298498c93a311b7af9a3ae7';
const ZONING = 'aaaa1111bbbb2222cccc3333dddd4444';    // in county org
const DASH = 'ffff0000eeee1111dddd2222cccc3333';      // external org (shadow IT)
const ORPHAN = '99998888777766665555444433332222';    // in org, on no page
const PRIVATE_ITEM = '1234123412341234123412341234abcd'; // not readable
const ORG_ID = 'ORG123abc';

// Drupal-like chrome: mega-menu with two map apps (must classify as site_chrome on every page).
const chrome = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} | County of San Mateo</title></head>
<body class="path-frontpage">
<div class="dialog-off-canvas-main-canvas">
<header class="site-header region-header" role="banner">
  <div class="block-system-branding-block"><a href="/">County of San Mateo</a></div>
  <nav class="menu--main mega-menu" role="navigation" aria-label="Main navigation">
    <ul>
      <li><a href="/tsd/gis">GIS</a></li>
      <li><a href="https://www.arcgis.com/apps/webappviewer/index.html?id=${ROADS}">Road Closures Map</a></li>
      <li><a href="https://gis.smcgov.org/Html5Viewer/?viewer=raster">County Map Viewer</a></li>
      <li><a href="/planning/gis-map-zoning-and-other-info-0">Zoning</a></li>
    </ul>
  </nav>
</header>
<main id="main-content" role="main" class="layout-content"><article class="node__content">${body}</article></main>
<footer class="site-footer region-footer" role="contentinfo">
  <ul class="menu--footer"><li><a href="/privacy-policy">Privacy Policy</a></li><li><a href="https://gis.smcgov.org/Html5Viewer/?viewer=raster">Maps</a></li><li><a href="https://data.smcgov.org/">Open Data</a></li></ul>
</footer>
</div></body></html>`;

const newsLinks = Array.from({ length: 24 }, (_, i) => `<li><a href="/news/article-${i + 1}">Article ${i + 1}</a></li>`).join('');
const pages = {
  '/': chrome('Home', `<h1>Welcome</h1><ul>
    <li><a href="/tsd/san-mateo-county-digital-equity-portal">Digital Equity Portal</a></li>
    <li><a href="/privacy-policy">Privacy</a></li>
    <li><a href="/planning/gis-map-zoning-and-other-info-0">Zoning info</a></li>
    <li><a href="/tsd/gis">GIS</a></li>
    <li><a href="/hsa/find-services">Find services</a></li>
    <li><a href="/hsa/contact">Contact</a></li>
    <li><a href="/dpw/viewers">Viewers</a></li>
    <li><a href="/parks/seating">Seating</a></li>
    <li><a href="/about/shadow-map">Shadow</a></li>
    <li><a href="/tsd/tableau">Tableau</a></li>
    <li><a href="/tsd/mapbox-page">Mapbox</a></li>
    <li><a href="/files/report.pdf">PDF</a></li>
    <li><a href="/redirect-old">Old link</a></li>
    <li><a href="/tsd/gis?utm_source=newsletter&fbclid=abc#section">Tracking link (dedupes)</a></li>
    <li><a href="http://127.0.0.1:${PORT}/tsd/gis/">Bare-host alias link (dedupes)</a></li>
    <li><a href="https://data.smcgov.org/dataset/1">Off-host (not crawled)</a></li>
    <li><a href="/private/secret">Private (robots)</a></li>
    <li><a href="/missing-page">404</a></li>
    <li><a href="/tsd/broken">Server error</a></li>
    ${newsLinks}</ul>`),
  '/tsd/san-mateo-county-digital-equity-portal': chrome('Digital Equity Portal', `<h1>San Mateo County Digital Equity Portal</h1>
    <p>Explore the portal below.</p>
    <div class="field--name-body"><iframe title="Digital Equity Portal" width="100%" height="600" src="https://smcmaps.maps.arcgis.com/apps/webappviewer/index.html?id=${EQUITY}"></iframe></div>`),
  '/privacy-policy': chrome('Privacy Policy', `<h1>Privacy Policy</h1><p>Last updated 2014. Manage cookies via your browser settings.</p>`),
  '/planning/gis-map-zoning-and-other-info-0': chrome('GIS Map: Zoning and Other Info', `<h1>GIS Map: Zoning and Other Info</h1>
    <p>Open the <a href="https://smcmaps.maps.arcgis.com/apps/webappviewer/index.html?id=${ZONING}">interactive zoning map</a>.</p>
    <img alt="Zoning overview map" width="600" height="300" src="https://maps.googleapis.com/maps/api/staticmap?center=37.5,-122.3&zoom=10&size=600x300&key=AIzaFAKEKEY123">
    <p>Planning counter: 455 County Center, Redwood City. <a href="https://www.google.com/maps?q=455+County+Center+Redwood+City">Get Directions</a></p>`),
  '/tsd/gis': chrome('GIS', `<h1>Geographic Information Systems</h1><p>Our interactive map:</p><div id="county-map" style="height:400px"></div>
    <script src="/assets/fake-leaflet.js"></script><script>window.addEventListener('load', () => { L.map('county-map'); });</script>`),
  '/hsa/contact': chrome('Contact us', `<h1>Contact HSA</h1><p>See the <a href="https://smcmaps.maps.arcgis.com/apps/webappviewer/index.html?id=${ZONING}">zoning map</a> for district boundaries.</p>`),
  '/dpw/viewers': chrome('Public Works viewers', `<h1>Viewers</h1><ul><li><a href="https://gis.smcgov.org/apps/publicviewer">Public viewer</a></li><li><a href="https://gis.smcgov.org/apps/publicviewer/">Public viewer (trailing slash)</a></li>
    <li><a href="http://maps.smcgov.org/apps/parcels/index.html">Parcel map (maps.smcgov.org)</a></li>
    <li><a href="https://services.arcgis.com/${ORG_ID}/arcgis/rest/services/Parcels/FeatureServer/0">Parcels feature service</a></li>
    <li><a href="https://services.arcgis.com/OTHERORG99/arcgis/rest/services/Vendor_Layer/FeatureServer">Vendor feature service</a></li></ul>`),
  '/hsa/find-services': chrome('Find Services Near You', `<h1>Find Services</h1><p><a href="https://www.google.com/maps/place/1+Tower+Rd+San+Mateo">Get Directions</a></p><button id="showmap" type="button">Show map</button><div id="mapwrap"></div>
    <script>document.getElementById('showmap').addEventListener('click', () => { const f = document.createElement('iframe'); f.src = 'https://www.google.com/maps/d/embed?mid=1XyZ_abc123&hl=en'; f.width = 640; f.height = 480; document.getElementById('mapwrap').appendChild(f); });</script>`),
  '/parks/seating': chrome('Seating chart', `<h1>Amphitheater seating chart</h1><figure><div id="seatmap" style="height:300px"></div><figcaption>Seat map — floor plan of the venue</figcaption></figure>
    <script src="/assets/fake-leaflet.js"></script><script>window.addEventListener('load', () => { L.map('seatmap', { crs: 'simple' }); });</script>`),
  '/about/shadow-map': chrome('About the dashboard map', `<h1>Shadow DOM dashboard</h1><smc-embed></smc-embed>
    <script>customElements.define('smc-embed', class extends HTMLElement { connectedCallback() { const r = this.attachShadow({ mode: 'open' }); const f = document.createElement('iframe'); f.src = 'https://www.arcgis.com/apps/dashboards/${DASH}'; f.width = 800; f.height = 500; r.appendChild(f); } });</script>`),
  '/tsd/tableau': chrome('Tableau dashboard', `<h1>Tableau</h1><iframe src="https://public.tableau.com/views/SMCDashboard/Map?:embed=y" width="800" height="600"></iframe>
    <p>Private item link: <a href="https://smcmaps.maps.arcgis.com/apps/instant/basic/index.html?appid=${PRIVATE_ITEM}">private instant app</a></p>`),
  '/tsd/mapbox-page': chrome('Mapbox map', `<h1>Mapbox</h1><div id="map" class="map-canvas"></div>
    <script src="https://api.mapbox.com/mapbox-gl-js/v3.0.0/mapbox-gl.js"></script>
    <script>try { mapboxgl.accessToken = 'pk.FAKETOKEN'; new mapboxgl.Map({ container: 'map', style: 'mapbox://styles/smcgis/ckabc123def' }); } catch (e) {}</script>`),
  '/private/secret': chrome('Secret', `<h1>Should never be fetched</h1><iframe src="https://www.arcgis.com/apps/webappviewer/index.html?id=00000000000000000000000000000000"></iframe>`),
};
for (let i = 1; i <= 24; i++) pages[`/news/article-${i}`] = chrome(`Article ${i}`, `<h1>Article ${i}</h1><p>Plain news.</p><a href="/news/article-${i + 1}">Next</a>`);
pages['/news/article-25'] = chrome('Article 25', `<h1>Article 25</h1><p>Only reachable by links (not in sitemap).</p>`);

const sitemapUrls = Object.keys(pages).filter(p => !p.startsWith('/news/article-25'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const fakeLeaflet = `window.L = { map(id, o) { const el = document.getElementById(id); el.classList.add('leaflet-container'); for (let x = 0; x < 3; x++) for (let y = 0; y < 2; y++) { const i = new Image(); i.src = '/tiles/12/' + (655 + x) + '/' + (1583 + y) + '.png'; el.appendChild(i); } const a = document.createElement('div'); a.className = 'leaflet-control-attribution'; a.innerHTML = '<a href="https://leafletjs.com">Leaflet</a> | &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'; el.appendChild(a); return { on(){} }; } };`;

// Mock ArcGIS Online REST (public endpoints only).
const orgItems = [
  { id: EQUITY, title: 'Digital Equity Portal', type: 'Web Mapping Application', owner: 'smc_gis', created: 1600000000000, modified: 1700000000000, orgId: ORG_ID, access: 'public' },
  { id: ROADS, title: 'Road Closures', type: 'Web Mapping Application', owner: 'smc_dpw', created: 1600000000000, modified: 1700000000000, orgId: ORG_ID, access: 'public' },
  { id: ZONING, title: 'Zoning Map', type: 'Web Mapping Application', owner: 'smc_planning', created: 1600000000000, modified: 1700000000000, orgId: ORG_ID, access: 'public' },
  { id: ORPHAN, title: 'Old Flood Map (unused)', type: 'Web Map', owner: 'smc_gis', created: 1500000000000, modified: 1500000000000, orgId: ORG_ID, access: 'public' },
];
const externalItems = { [DASH]: { id: DASH, title: 'Contractor Dashboard', type: 'Dashboard', owner: 'consultant_jdoe', created: 1690000000000, modified: 1700000000000, orgId: 'OTHERORG', access: 'public' } };

const BLOCK_AFTER = Number(process.env.FIXTURE_BLOCK_AFTER || 0); let pageFetches = 0; // simulate a WAF that starts rejecting after N page fetches
const server = http.createServer((req, res) => {
  const u = new URL(req.url, BASE);
  const p = u.pathname;
  if (BLOCK_AFTER && !/^\/(robots\.txt|sitemap\.xml|assets|tiles|sharing)/.test(p)) { pageFetches++; if (pageFetches > BLOCK_AFTER) { res.writeHead(403, { 'content-type': 'text/html' }); return res.end('<h1>403 Forbidden (simulated WAF)</h1>'); } }
  const send = (code, type, body, headers = {}) => { res.writeHead(code, { 'content-type': type, ...headers }); res.end(body); };
  const json = (o) => send(200, 'application/json', JSON.stringify(o));
  if (p === '/robots.txt') return send(200, 'text/plain', `User-agent: *\nDisallow: /private/\nDisallow: /admin\nCrawl-delay: 5\nSitemap: ${BASE}/sitemap.xml\n`);
  if (p === '/sitemap.xml' && !u.searchParams.get('page')) return send(200, 'application/xml', `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${BASE}/sitemap.xml?page=1</loc></sitemap><sitemap><loc>${BASE}/sitemap.xml?page=2</loc></sitemap></sitemapindex>`);
  if (p === '/sitemap.xml') {
    const page = Number(u.searchParams.get('page')); const half = Math.ceil(sitemapUrls.length / 2);
    const slice = page === 1 ? sitemapUrls.slice(0, half) : sitemapUrls.slice(half);
    const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${slice.map(s => `<url><loc>${BASE}${s}</loc></url>`).join('')}</urlset>`;
    return send(200, 'application/xml', zlib.gzipSync(xml), { 'content-encoding': 'gzip' });
  }
  if (p === '/assets/fake-leaflet.js') return send(200, 'application/javascript', fakeLeaflet);
  if (p.startsWith('/tiles/')) return send(200, 'image/png', png);
  if (p === '/files/report.pdf') return send(200, 'application/pdf', '%PDF-1.4 fake');
  if (p === '/redirect-old') return send(301, 'text/plain', '', { location: '/tsd/gis' });
  if (p === '/tsd/broken') return send(500, 'text/html', '<h1>500</h1>');
  // Mock ArcGIS REST
  if (p === '/sharing/rest/portals/self') return json({ id: ORG_ID, name: 'County of San Mateo (mock)', urlKey: 'smcmaps' });
  if (p === '/sharing/rest/search') { const start = Number(u.searchParams.get('start') || 1); const num = Number(u.searchParams.get('num') || 100); const slice = orgItems.slice(start - 1, start - 1 + num); return json({ total: orgItems.length, start, num, nextStart: start - 1 + num < orgItems.length ? start + num : -1, results: slice }); }
  const im = p.match(/^\/sharing\/rest\/content\/items\/([0-9a-f]{32})$/);
  if (im) { const it = orgItems.find(i => i.id === im[1]) || externalItems[im[1]]; return it ? json(it) : json({ error: { code: 403, message: 'You do not have permissions to access this resource or perform this operation.' } }); }
  if (p === '/slow') return setTimeout(() => send(200, 'text/html', chrome('Slow', '<h1>slow</h1>')), 3000);
  const key = p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
  if (pages[key]) return send(200, 'text/html; charset=utf-8', pages[key]);
  send(404, 'text/html', '<h1>Not found</h1>');
});
server.listen(PORT, () => console.log(`fixture site on ${BASE}`));
export const constants = { EQUITY, ROADS, ZONING, DASH, ORPHAN, PRIVATE_ITEM, ORG_ID, BASE, PORT };
