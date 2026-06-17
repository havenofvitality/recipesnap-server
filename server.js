const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Extract recipe from URL (web or social)
app.post('/api/import/url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const pageRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RecipeSnap/1.0; +https://recipesnap.app)',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!pageRes.ok) {
      return res.status(422).json({ error: `Could not fetch page (HTTP ${pageRes.status})` });
    }

    const html = await pageRes.text();

    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 10000);

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
      if (!jsonMatch) return res.status(500).json({ error: 'Failed to parse AI response' });
      recipe = JSON.parse(jsonMatch[0]);
    }

    if (recipe.error) return res.status(422).json({ error: recipe.error });
    if (!recipe.imageUrl && metaImage) recipe.imageUrl = metaImage;

    res.json(recipe);
  } catch (err) {
    console.error('URL import error:', err);
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(422).json({ error: 'Page took too long to load' });
    }
    res.status(500).json({ error: 'Failed to extract recipe. Check server logs.' });
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
