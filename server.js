const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();

// Render runs the app behind a reverse proxy. Trust the first proxy hop so
// rate limiting keys on the real client IP (not Render's shared proxy IP).
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json({ limit: '20mb' }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Rate limiting (anti-abuse / anti-cost-blowup) ──────────────
// The AI + import endpoints each call Anthropic and cost money, so they are
// capped tightly. /health is intentionally NOT limited (cron keep-alive pings).
const jsonMessage = (msg) => ({
  windowMs: 60 * 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: msg },
});

const generalLimiter = rateLimit({ ...jsonMessage('Too many requests. Please slow down and try again in a minute.'), max: 60 });
const aiLimiter = rateLimit({ ...jsonMessage('You are sending requests too quickly. Please wait a minute and try again.'), max: 12 });

app.use('/api/', generalLimiter);        // safety net on every API route
app.use('/api/ai/', aiLimiter);          // stricter: Smart Chef (fridge/leftovers/chat/healthify)
app.use('/api/import/', aiLimiter);      // stricter: URL + scan extraction (also call Anthropic)

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Extract recipe from URL (web or social)
app.post('/api/import/url', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  // Repair typos mobile keyboards inject into pasted links:
  // "www domain.com" (space instead of dot), "site . com", or a URL buried in shared text.
  url = String(url).trim().replace(/^((?:https?:\/\/)?www)\s+/i, '$1.');
  const embedded = url.match(/https?:\/\/\S+/i);
  if (embedded) {
    url = embedded[0];
  } else {
    url = url.replace(/\s*\.\s*/g, '.');
    url = url.split(/\s+/).find((p) => p.includes('.')) || url;
  }

  // Add https:// if missing
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  // Validate before fetching so the user gets a clear message, not a raw parse error
  try { new URL(url); } catch {
    return res.status(422).json({ error: 'This link looks invalid. Copy the URL again from your browser or the app, then paste it here.' });
  }

  // Detect platforms
  const isPinterest = /pinterest\.(com|fr|de|co\.uk|ca|com\.au)|pin\.it/i.test(url);
  const isYouTube   = /youtube\.com|youtu\.be/i.test(url);
  const isInstagram = /instagram\.com\/(p|reel|tv)\//i.test(url);
  const isTikTok    = /tiktok\.com/i.test(url);
  const isFacebook  = /facebook\.com\/(?!groups|events)|fb\.watch|fb\.com/i.test(url);

  const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
  };

  try {
    let fetchUrl = url;

    // Pinterest: fetch the pin page and extract the source URL from their JSON data
    if (isPinterest) {
      try {
        const pinRes = await fetch(url, {
          headers: BROWSER_HEADERS,
          redirect: 'follow',
          signal: AbortSignal.timeout(20000),
        });
        const pinHtml = await pinRes.text();

        // Pinterest stores the external recipe URL in "link":"..." inside their embedded JSON
        // The URL may contain unicode-escaped slashes (/ = /)
        let sourceUrl = null;
        const candidates = [
          ...pinHtml.matchAll(/"link":"(https?:[^"\\]*(?:\\.[^"\\]*)*)"/g),
          ...pinHtml.matchAll(/property="og:see_also"\s+content="([^"]+)"/gi),
          ...pinHtml.matchAll(/content="([^"]+)"\s+property="og:see_also"/gi),
        ];

        for (const match of candidates) {
          const decoded = match[1]
            .replace(/\\u002F/gi, '/')
            .replace(/\\u003A/gi, ':')
            .replace(/\\\//g, '/')
            .trim();
          if (decoded.startsWith('http') && !/pinterest\./i.test(decoded)) {
            sourceUrl = decoded;
            break;
          }
        }

        if (sourceUrl) {
          fetchUrl = sourceUrl;
        } else {
          return res.status(422).json({
            error: 'This Pinterest pin has no external recipe link. Open the pin on Pinterest, tap the website link below the image, and paste that URL here.',
          });
        }
      } catch (err) {
        return res.status(422).json({
          error: 'Could not read this Pinterest pin. Try pasting the recipe website URL directly.',
        });
      }
    }

    // Instagram: use public embed endpoint to get caption (no login needed for public posts)
    if (isInstagram) {
      const match = url.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
      if (!match) return res.status(422).json({ error: 'Invalid Instagram URL. Copy the link directly from the post.' });
      const code = match[1];
      try {
        const embedRes = await fetch(`https://www.instagram.com/p/${code}/embed/captioned/`, {
          headers: BROWSER_HEADERS,
          signal: AbortSignal.timeout(12000),
        });
        const embedHtml = await embedRes.text();
        const embedText = embedHtml
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ').trim().slice(0, 8000);
        if (embedText.length < 100) {
          return res.status(422).json({ error: 'Could not read this Instagram post. Make sure the account is public.' });
        }
        const igResp = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001', max_tokens: 2000,
          messages: [{ role: 'user', content: `Extract the recipe from this Instagram post caption.\nReturn JSON: {"title":string,"servings":number,"time":string|null,"ingredients":[{"qty":string,"name":string}],"instructions":[string]}\nIf no recipe: {"error":"No recipe in this post"}\n\nPost:\n${embedText}\n\nReturn ONLY valid JSON.` }],
        });
        const raw = igResp.content[0].text?.trim() ?? '';
        let recipe; try { recipe = JSON.parse(raw); } catch { const m = raw.match(/\{[\s\S]+\}/); if (!m) return res.status(500).json({ error: 'Could not parse response.' }); recipe = JSON.parse(m[0]); }
        if (recipe.error) return res.status(422).json({ error: recipe.error });
        return res.json(recipe);
      } catch {
        return res.status(422).json({ error: 'Could not read this Instagram post. Make sure the post is public.' });
      }
    }

    // TikTok: use official oEmbed API (free, no auth needed)
    if (isTikTok) {
      try {
        let caption = '';
        let oData = {};
        try {
          const oRes = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, {
            headers: BROWSER_HEADERS, signal: AbortSignal.timeout(10000),
          });
          oData = await oRes.json();
          caption = oData.title || '';
        } catch { /* fall through to page scrape */ }

        // Fallback: read the video page itself and pull the description from its JSON
        if (caption.length < 20) {
          try {
            const tRes = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(15000) });
            const tHtml = await tRes.text();
            const dMatch = tHtml.match(/"desc":"((?:[^"\\]|\\.)*)"/);
            if (dMatch) {
              const pageDesc = dMatch[1]
                .replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\u0026/g, '&').replace(/\\\//g, '/');
              if (pageDesc.length > caption.length) caption = pageDesc;
            }
          } catch { /* keep whatever oEmbed gave us */ }
        }

        if (caption.length < 20) return res.status(422).json({ error: 'This TikTok has no recipe in the caption. The creator may have put the recipe in a comment.' });
        const ttResp = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001', max_tokens: 2000,
          messages: [{ role: 'user', content: `Extract the recipe from this TikTok caption.\nReturn JSON: {"title":string,"servings":number,"time":string|null,"ingredients":[{"qty":string,"name":string}],"instructions":[string]}\nIf no recipe: {"error":"No recipe in this TikTok"}\n\nCaption:\n${caption}\n\nReturn ONLY valid JSON.` }],
        });
        const raw = ttResp.content[0].text?.trim() ?? '';
        let recipe; try { recipe = JSON.parse(raw); } catch { const m = raw.match(/\{[\s\S]+\}/); if (!m) return res.status(500).json({ error: 'Could not parse response.' }); recipe = JSON.parse(m[0]); }
        if (recipe.error) return res.status(422).json({ error: recipe.error });
        if (oData.thumbnail_url && !recipe.imageUrl) recipe.imageUrl = oData.thumbnail_url;
        return res.json(recipe);
      } catch {
        return res.status(422).json({ error: 'Could not read this TikTok. Make sure the video is public.' });
      }
    }

    // Facebook: use public post embed
    if (isFacebook) {
      try {
        const fbEmbed = `https://www.facebook.com/plugins/post.php?href=${encodeURIComponent(url)}&width=500`;
        const fbRes = await fetch(fbEmbed, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(12000) });
        const fbHtml = await fbRes.text();
        const fbText = fbHtml
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ').trim().slice(0, 8000);
        if (fbText.length < 100) return res.status(422).json({ error: 'Could not read this Facebook post. Make sure it is public.' });
        const fbResp = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001', max_tokens: 2000,
          messages: [{ role: 'user', content: `Extract the recipe from this Facebook post.\nReturn JSON: {"title":string,"servings":number,"time":string|null,"ingredients":[{"qty":string,"name":string}],"instructions":[string]}\nIf no recipe: {"error":"No recipe in this post"}\n\nPost:\n${fbText}\n\nReturn ONLY valid JSON.` }],
        });
        const raw = fbResp.content[0].text?.trim() ?? '';
        let recipe; try { recipe = JSON.parse(raw); } catch { const m = raw.match(/\{[\s\S]+\}/); if (!m) return res.status(500).json({ error: 'Could not parse response.' }); recipe = JSON.parse(m[0]); }
        if (recipe.error) return res.status(422).json({ error: recipe.error });
        return res.json(recipe);
      } catch {
        return res.status(422).json({ error: 'Could not read this Facebook post. Make sure it is a public post.' });
      }
    }

    // YouTube: read the description (shortDescription field is reliable).
    // 1) try to extract a full recipe from the description text
    // 2) if none, follow a recipe-blog link found in the description
    if (isYouTube) {
      try {
        let desc = '';
        let thumb = null;

        const idMatch = url.match(/(?:youtube\.com\/(?:watch\?[^#]*?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);

        // 1st source: official YouTube Data API — the ONLY method YouTube
        // guarantees from datacenter IPs (Render). Needs YOUTUBE_API_KEY env var.
        if (idMatch && process.env.YOUTUBE_API_KEY) {
          try {
            const aRes = await fetch(
              `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${idMatch[1]}&key=${process.env.YOUTUBE_API_KEY}`,
              { signal: AbortSignal.timeout(12000) }
            );
            const aData = await aRes.json();
            const sn = aData?.items?.[0]?.snippet;
            if (sn) {
              desc = sn.description || '';
              const t = sn.thumbnails;
              thumb = (t?.maxres || t?.high || t?.medium || t?.default)?.url || null;
            }
          } catch { /* fall through */ }
        }

        // 2nd source: YouTube's internal player API (works from residential IPs;
        // datacenter IPs are often blocked — try two client profiles).
        if (idMatch && !desc) {
          const clients = [
            { clientName: 'WEB', clientVersion: '2.20240726.00.00', hl: 'en' },
            { clientName: 'IOS', clientVersion: '19.45.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.1.0.22B83', hl: 'en' },
          ];
          for (const client of clients) {
            try {
              const pRes = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ videoId: idMatch[1], context: { client } }),
                signal: AbortSignal.timeout(15000),
              });
              const pData = await pRes.json();
              desc = pData?.videoDetails?.shortDescription || '';
              const thumbs = pData?.videoDetails?.thumbnail?.thumbnails;
              if (!thumb && Array.isArray(thumbs) && thumbs.length) thumb = thumbs[thumbs.length - 1].url;
              if (desc) break;
            } catch { /* try next client */ }
          }
        }

        // 2nd source (fallback): scrape the watch page HTML
        if (!desc) {
          const ytRes = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(20000) });
          const ytHtml = await ytRes.text();
          const descMatch = ytHtml.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
          if (descMatch) {
            desc = descMatch[1]
              .replace(/\\n/g, '\n').replace(/\\r/g, '')
              .replace(/\\"/g, '"').replace(/\\u0026/g, '&').replace(/\\\//g, '/');
          }
          if (!thumb) {
            const ytImg = ytHtml.match(/"thumbnailUrl":"([^"]+)"/);
            thumb = ytImg ? ytImg[1].replace(/\\\//g, '/') : null;
          }
        }

        // 1) Recipe written directly in the description?
        if (desc.length > 80) {
          const ytPrompt = `Extract the recipe from this YouTube video description. Return JSON:\n{\n  "title": string,\n  "servings": number,\n  "time": string or null,\n  "ingredients": [{"qty": string, "name": string}],\n  "instructions": [string]\n}\nSucceed if the description contains at least a list of ingredients — many creators list ONLY ingredients and show the steps in the video. Extract the preparation steps if present; if steps are missing, return "instructions": []. Only return {"error": "no inline recipe"} if there is no ingredient list at all.\n\nDescription:\n${desc.slice(0, 6000)}\n\nReturn ONLY valid JSON.`;
          const ytResp = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, messages: [{ role: 'user', content: ytPrompt }] });
          const raw = ytResp.content[0].text?.trim() ?? '';
          let recipe;
          try { recipe = JSON.parse(raw); } catch { const m = raw.match(/\{[\s\S]+\}/); recipe = m ? JSON.parse(m[0]) : { error: 'parse' }; }
          if (!recipe.error) {
            if (thumb && !recipe.imageUrl) recipe.imageUrl = thumb;
            // Many creators list only ingredients — the steps live in the video itself.
            if (!Array.isArray(recipe.instructions) || recipe.instructions.length === 0) {
              recipe.instructions = ['Watch the original video for the step-by-step method — the full ingredient list is saved here.'];
            }
            return res.json(recipe);
          }
        }

        // 2) No inline recipe — find a recipe website link in the description and follow it
        const urls = desc.match(/https?:\/\/[^\s"'<>]+/g) || [];
        const blogUrl = urls.find((u) =>
          !/youtu\.?be|youtube\.com|google\.|amazon\.|instagram\.|tiktok\.|facebook\.|patreon\.|paypal\.|venmo\.|bit\.ly|linktr\.ee|twitter\.|x\.com|spotify\.|\/products?\/|\/shop\b|\/store\b|merch|etsy\.|discord\./i.test(u)
        );
        if (blogUrl) {
          fetchUrl = blogUrl.replace(/[).,]+$/, ''); // strip trailing punctuation, fall through to web extraction below
        } else {
          return res.status(422).json({ error: 'No recipe found for this video. The recipe is likely shown in the video itself, not written in the description.' });
        }
      } catch {
        return res.status(422).json({ error: 'Could not read this YouTube video. The server may be waking up — try again in 30 seconds.' });
      }
    }

    const pageRes = await fetch(fetchUrl, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(20000),
    });

    if (!pageRes.ok) {
      if (pageRes.status === 403 || pageRes.status === 401) {
        return res.status(422).json({ error: 'This website blocks automated access. Try copying the recipe text manually.' });
      }
      return res.status(422).json({ error: `Could not open this page (HTTP ${pageRes.status}). Check the URL and try again.` });
    }

    const html = await pageRes.text();

    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 12000);

    if (text.length < 200) {
      return res.status(422).json({ error: 'This page requires a browser to load (JavaScript-only site). Try a different recipe URL.' });
    }

    const imgMatch = html.match(/property="og:image"\s+content="([^"]+)"/i)
      || html.match(/content="([^"]+)"\s+property="og:image"/i);
    const metaImage = imgMatch ? imgMatch[1] : null;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: `Extract the recipe from this webpage text. Return a JSON object with exactly these fields:\n{\n  "title": string,\n  "servings": number (default 2 if not found),\n  "time": string or null (e.g. "30 min"),\n  "ingredients": [{ "qty": string, "name": string }],\n  "instructions": [string] (each element is one step),\n  "imageUrl": string or null\n}\n\nIf there is no recipe in this text, return: {"error": "Not a recipe page"}\n\nWebpage text:\n${text}\n\nReturn ONLY valid JSON. No markdown fences.`,
        },
      ],
    });

    const raw = response.content[0].text?.trim() ?? '';
    let recipe;
    try {
      recipe = JSON.parse(raw);
    } catch {
      const jsonMatch = raw.match(/\{[\s\S]+\}/);
      if (!jsonMatch) return res.status(500).json({ error: 'Could not read the AI response. Please try again.' });
      recipe = JSON.parse(jsonMatch[0]);
    }

    if (recipe.error) return res.status(422).json({ error: recipe.error });
    if (!recipe.imageUrl && metaImage) recipe.imageUrl = metaImage;

    res.json(recipe);
  } catch (err) {
    console.error('URL import error:', err);
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(422).json({ error: 'The page took too long to load. Try again or use a different URL.' });
    }
    res.status(500).json({ error: `Import failed: ${err.message || 'Unknown error'}` });
  }
});

// Extract recipe from camera scan image (base64)
app.post('/api/import/scan', async (req, res) => {
  const { base64Image } = req.body;
  if (!base64Image) return res.status(400).json({ error: 'base64Image is required' });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: base64Image,
              },
            },
            {
              type: 'text',
              text: `Extract the recipe visible in this image. Return a JSON object with exactly these fields:\n{\n  "title": string,\n  "servings": number (default 2 if not found),\n  "time": string or null (e.g. "30 min"),\n  "ingredients": [{ "qty": string, "name": string }],\n  "instructions": [string]\n}\n\nIf no recipe is visible, return: {"error": "No recipe found in image"}\n\nReturn ONLY valid JSON. No markdown fences.`,
            },
          ],
        },
      ],
    });

    const raw = response.content[0].text?.trim() ?? '';
    let recipe;
    try {
      recipe = JSON.parse(raw);
    } catch {
      const jsonMatch = raw.match(/\{[\s\S]+\}/);
      if (!jsonMatch) return res.status(500).json({ error: 'Failed to parse AI response' });
      recipe = JSON.parse(jsonMatch[0]);
    }

    if (recipe.error) return res.status(422).json({ error: recipe.error });
    res.json(recipe);
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ error: 'Failed to scan recipe. Check server logs.' });
  }
});

// AI Tool 1: What's in my fridge?
app.post('/api/ai/fridge', async (req, res) => {
  const { ingredients } = req.body;
  if (!ingredients) return res.status(400).json({ error: 'ingredients is required' });
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Create a delicious recipe using these ingredients: ${ingredients}

Return a JSON object with exactly these fields:
{
  "title": string,
  "servings": number,
  "time": string,
  "ingredients": [{ "qty": string, "name": string }],
  "instructions": [string]
}

Be creative but practical. Return ONLY valid JSON. No markdown fences.`,
      }],
    });
    const raw = response.content[0].text?.trim() ?? '';
    let recipe;
    try { recipe = JSON.parse(raw); }
    catch { const m = raw.match(/\{[\s\S]+\}/); if (!m) return res.status(500).json({ error: 'Failed to parse AI response' }); recipe = JSON.parse(m[0]); }
    res.json(recipe);
  } catch (err) {
    console.error('Fridge AI error:', err);
    res.status(500).json({ error: 'AI request failed.' });
  }
});

// AI Tool 2: Transform Leftovers
app.post('/api/ai/leftovers', async (req, res) => {
  const { meal } = req.body;
  if (!meal) return res.status(400).json({ error: 'meal is required' });
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `I have leftovers from: ${meal}

Create a completely different, creative recipe that transforms these leftovers into a new dish.

Return a JSON object with exactly these fields:
{
  "title": string,
  "servings": number,
  "time": string,
  "ingredients": [{ "qty": string, "name": string }],
  "instructions": [string]
}

Return ONLY valid JSON. No markdown fences.`,
      }],
    });
    const raw = response.content[0].text?.trim() ?? '';
    let recipe;
    try { recipe = JSON.parse(raw); }
    catch { const m = raw.match(/\{[\s\S]+\}/); if (!m) return res.status(500).json({ error: 'Failed to parse AI response' }); recipe = JSON.parse(m[0]); }
    res.json(recipe);
  } catch (err) {
    console.error('Leftovers AI error:', err);
    res.status(500).json({ error: 'AI request failed.' });
  }
});

// AI Tool 3: Chef S.O.S Chat
app.post('/api/ai/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: 'You are an expert chef and cooking assistant. Answer cooking questions helpfully and concisely. Focus on practical advice.',
      messages: [{ role: 'user', content: message }],
    });
    res.json({ reply: response.content[0].text?.trim() ?? '' });
  } catch (err) {
    console.error('Chat AI error:', err);
    res.status(500).json({ error: 'AI request failed.' });
  }
});

// AI Tool 4: Make it Healthier
app.post('/api/ai/healthify', async (req, res) => {
  const { ingredients, title } = req.body;
  if (!ingredients) return res.status(400).json({ error: 'ingredients is required' });
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `Make this recipe healthier by suggesting ingredient substitutions.

Recipe: ${title || 'Recipe'}
Ingredients: ${ingredients}

Return a JSON object with exactly this structure:
{
  "substitutions": [
    { "original": string, "replacement": string, "reason": string }
  ]
}

Suggest 3-5 meaningful substitutions that reduce calories, sugar, or saturated fat, or increase nutritional value. Only suggest substitutions that make practical sense for this recipe. Be specific.

Return ONLY valid JSON. No markdown fences.`,
      }],
    });
    const raw = response.content[0].text?.trim() ?? '';
    let result;
    try { result = JSON.parse(raw); }
    catch { const m = raw.match(/\{[\s\S]+\}/); if (!m) return res.status(500).json({ error: 'Failed to parse AI response' }); result = JSON.parse(m[0]); }
    res.json(result);
  } catch (err) {
    console.error('Healthify error:', err);
    res.status(500).json({ error: 'AI request failed.' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ RecipeSnap server running on port ${PORT}`);
  console.log(`   Health:     http://localhost:${PORT}/health`);
  console.log(`   URL import: POST http://localhost:${PORT}/api/import/url`);
  console.log(`   Scan:       POST http://localhost:${PORT}/api/import/scan`);
  console.log(`   AI Fridge:  POST http://localhost:${PORT}/api/ai/fridge`);
  console.log(`   AI Leftov:  POST http://localhost:${PORT}/api/ai/leftovers`);
  console.log(`   AI Chat:    POST http://localhost:${PORT}/api/ai/chat\n`);
});
