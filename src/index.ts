import { ApiException, fromHono } from "chanfana";
import { Hono } from "hono";
import { Context } from "hono";
import { z } from "zod";
import { Ai } from "@cloudflare/workers-ai";
import fetch from "node-fetch";
import { ContentfulStatusCode } from "hono/utils/http-status";

export interface Env {
  AI: Ai;
  RS3_BOT_MEMORY_KV: KVNamespace;
  BOT_DB: D1Database;
  JSONBIN_BIN_ID: string;
  JSONBIN_MASTER_KEY: string;
  GITHUB_TOKEN: string;
}

const MODELS = {
  textGen: '@cf/meta/llama-3.1-8b-instruct',
  textGenLarge: '@cf/meta/llama-3.1-70b-instruct',
  imageGen: '@cf/stabilityai/stable-diffusion-xl-base-1.0',
  imageEdit: '@cf/runwayml/stable-diffusion-v1-5-inpainting',
  speechToText: '@cf/openai/whisper',
  tts: '@cf/deepgram/aura-1',
  embeddings: '@cf/baai/bge-large-en-v1.5',
  codeGen: '@cf/deepseek-ai/deepseek-coder-6.7b-instruct',
  objectDetection: '@cf/facebook/detr-resnet-50'
};

async function updateSharedMemory(env: Env, data: any) {
  await fetch(`https://api.jsonbin.io/v3/b/${env.JSONBIN_BIN_ID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': env.JSONBIN_MASTER_KEY },
    body: JSON.stringify(data)
  });
}

async function getSharedMemory(env: Env) {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${env.JSONBIN_BIN_ID}/latest`, {
    headers: { 'X-Master-Key': env.JSONBIN_MASTER_KEY }
  });
  return await res.json();
}

abstract class BotRoute extends OpenAPIRoute {
  async loadHistory(c: Context<{ Bindings: Env }>, userId: string, botType: string): Promise<any[]> {
    const kvKey = `memory:${botType}:${userId}`;
    let history = JSON.parse((await c.env.RS3_BOT_MEMORY_KV.get(kvKey)) || '[]');
    const dbRes = await c.env.BOT_DB.prepare('SELECT history FROM user_memory WHERE user_id = ?').bind(`${botType}:${userId}`).first();
    if (dbRes?.history) history = JSON.parse(dbRes.history);
    const shared = await getSharedMemory(c.env);
    history.push({ role: 'system', content: `Shared cross-bot memory for #1 friendly recall: ${JSON.stringify(shared)}` });
    history.push({ role: 'system', content: 'Be a friend (#1): Empathetic, recall past. Fetch data (#2): Hiscores/wiki/GitHub. Overlays (#3): Non-clicking Alt1 only.' });
    return history;
  }

  async saveHistory(c: Context<{ Bindings: Env }>, userId: string, botType: string, history: any[]) {
    const kvKey = `memory:${botType}:${userId}`;
    await c.env.RS3_BOT_MEMORY_KV.put(kvKey, JSON.stringify(history), { expirationTtl: 86400 });
    await c.env.BOT_DB.prepare('INSERT OR REPLACE INTO user_memory (user_id, history) VALUES (?, ?)').bind(`${botType}:${userId}`, JSON.stringify(history)).run();
    await updateSharedMemory(c.env, { [`${botType}:${userId}`]: history });
  }
}

// Alt1 Source Script (#3 non-clicking overlay with permissions stamp)
export class SourceScript extends BotRoute {
  schema = {
    tags: ['Alt1'],
    summary: 'Source/enhance Alt1 script (#3 non-clicking overlay)',
    request: { params: z.object({ id: z.string().min(1) }) },
    responses: { 200: { description: 'Embedded HTML/JS with stamp' } },
  };

  async handle(c: Context<{ Bindings: Env }>) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { results } = await c.env.BOT_DB.prepare('SELECT code, description FROM scripts WHERE id = ?').bind(data.params.id).all();
    if (results.length === 0) return c.json({ error: 'Script not found' }, 404);
    const script = results[0];
    const ai = new Ai(c.env.AI);
    const enhanced = await ai.run(MODELS.codeGen, { prompt: `Enhance this RS3 Alt1 JS for non-clicking #3 overlays (add <!-- alt1 permissions: clipboard, screenread, overlay --> if missing, hands-free real-time, #1 friendly text): ${script.code}` });
    return c.json({ code: enhanced.response, description: script.description });
  }
}

// RS3 Data Fetch (#2 with #1 summary)
export class FetchRsData extends BotRoute {
  schema = {
    tags: ['RS3 Data'],
    summary: 'Fetch/store RS3 data (#2, share cross-bot)',
    request: { query: z.object({ player: z.string().min(1), user_id: z.string().optional(), bot_type: z.string().default('discord') }) },
    responses: { 200: { description: 'Friendly summary (#1)' } },
  };

  async handle(c: Context<{ Bindings: Env }>) {
    const data = await this.getValidatedData<typeof this.schema>();
    const userId = data.query.user_id || 'default';
    const botType = data.query.bot_type;
    const hiscoreData = await (await fetch(`https://secure.runescape.com/m=hiscore_ironman/index_lite.ws?player=${data.query.player}`)).text();
    const ai = new Ai(c.env.AI);
    const embedding = await ai.run(MODELS.embeddings, { text: hiscoreData });
    await c.env.BOT_DB.prepare('INSERT OR REPLACE INTO user_memory (user_id, rs_player_data) VALUES (?, ?)').bind(`${botType}:${userId}`, JSON.stringify({ data: hiscoreData, embedding })).run();
    const history = await this.loadHistory(c, userId, botType);
    history.push({ role: 'system', content: `RS data for ${data.query.player}: ${hiscoreData}` });
    const response = await ai.run(MODELS.textGenLarge, { messages: history, max_tokens: 4096, temperature: 0.7 });
    history.push({ role: 'assistant', content: response.response });
    await this.saveHistory(c, userId, botType, history);
    return c.json(response);
  }
}

// Friendly Chat (#1 with recall)
export class Chat extends BotRoute {
  schema = {
    tags: ['Chat'],
    summary: 'Friendly RS3/code chat (#1 with recall)',
    request: { query: z.object({ message: z.string().min(1), user_id: z.string().min(1), bot_type: z.string().default('editor'), model: z.string().default('textGenLarge') }) },
    responses: { 200: { description: 'AI response' } },
  };

  async handle(c: Context<{ Bindings: Env }>) {
    const data = await this.getValidatedData<typeof this.schema>();
    const userId = data.query.user_id;
    const botType = data.query.bot_type;
    const history = await this.loadHistory(c, userId, botType);
    history.push({ role: 'user', content: data.query.message });
    const ai = new Ai(c.env.AI);
    const response = await ai.run(MODELS[data.query.model], { messages: history, max_tokens: 2048, temperature: 0.7 });
    history.push({ role: 'assistant', content: response.response });
    await this.saveHistory(c, userId, botType, history);
    return c.json(response);
  }
}

// Discord Voice (Optional #1/#2 hands-free real-time, no commands)
export class DiscordVoice extends BotRoute {
  schema = {
    tags: ['Discord'],
    summary: 'Process voice audio (#1/#2 hands-free real-time)',
    request: { body: z.object({ audio: z.any() }), query: z.object({ user_id: z.string().min(1), bot_type: z.literal('discord') }) },
    responses: { 200: { description: 'Transcript and response text' } },
  };

  async handle(c: Context<{ Bindings: Env }>) {
    const data = await this.getValidatedData<typeof this.schema>();
    const userId = data.query.user_id;
    const botType = data.query.bot_type;
    const ai = new Ai(c.env.AI);
    const transcript = await ai.run(MODELS.speechToText, { audio: data.body.audio, language: 'en' });
    const history = await this.loadHistory(c, userId, botType);
    history.push({ role: 'user', content: transcript.text });
    const response = await ai.run(MODELS.textGen, { messages: history, max_tokens: 2048 });
    history.push({ role: 'assistant', content: response.response });
    await this.saveHistory(c, userId, botType, history);
    return c.json({ transcript: transcript.text, response: response.response });
  }
}

// TTS Voice (#1 friendly responses or #2 data summaries hands-free real-time no commands)
export class Tts extends BotRoute {
  schema = {
    tags: ['Voice'],
    summary: 'Generate TTS voice for #1 friendly responses or #2 data summaries (hands-free real-time no commands)',
    request: { query: z.object({ text: z.string().min(1), user_id: z.string().min(1), bot_type: z.string().default('alt1'), voice: z.string().default('alloy') }) },
    responses: { 200: { description: 'Audio blob base64 for playback' } },
  };

  async handle(c: Context<{ Bindings: Env }>) {
    const data = await this.getValidatedData<typeof this.schema>();
    const userId = data.query.user_id;
    const botType = data.query.bot_type;
    const history = await this.loadHistory(c, userId, botType);
    history.push({ role: 'user', content: data.query.text });
    const ai = new Ai(c.env.AI);
    const response = await ai.run(MODELS.textGen, { messages: history, max_tokens: 2048, temperature: 0.7 }); // #1 empathetic summary if needed
    const ttsText = response.response; // Use generated or input text
    const ttsResponse = await ai.run(MODELS.tts, { text: ttsText, voice: data.query.voice }); // Aura TTS natural #1 voice
    history.push({ role: 'assistant', content: ttsText });
    await this.saveHistory(c, userId, botType, history); // Store for #1 recall
    return c.json({ audio: ttsResponse.audio.toString('base64'), text: ttsText }); // Base64 MP3/WAV for <audio src="data:audio/mp3;base64,...">
  }
}

// Edit File in GitHub Repo (#2 fetch/edit, #1 AI enhance)
export class EditFile extends BotRoute {
  schema = {
    tags: ['Editor'],
    summary: 'Edit file in GitHub repo via API (#2 fetch/edit, #1 AI enhance)',
    request: { body: z.object({ repo: z.string(), path: z.string(), content: z.string(), message: z.string().default('Update via AI companion') }) },
    responses: { 200: { description: 'Updated file sha' } },
  };

  async handle(c: Context<{ Bindings: Env }>) {
    const data = await this.getValidatedData<typeof this.schema>();
    const userId = c.req.query('user_id') || 'default';
    const botType = 'editor';
    const history = await this.loadHistory(c, userId, botType);
    const ai = new Ai(c.env.AI);
    const enhancedContent = await ai.run(MODELS.codeGen, { prompt: `Enhance this code for clarity: ${data.body.content}` });
    const base64Content = Buffer.from(enhancedContent.response).toString('base64');
    // Get current sha for PUT
    const getRes = await fetch(`https://api.github.com/repos/${data.body.repo}/contents/${data.body.path}`, {
      headers: { 'Authorization': `token ${c.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
    });
    const current = await getRes.json();
    const sha = current.sha;
    // PUT edit
    const putRes = await fetch(`https://api.github.com/repos/${data.body.repo}/contents/${data.body.path}`, {
      method: 'PUT',
      headers: { 'Authorization': `token ${c.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: data.body.message, content: base64Content, sha: sha })
    });
    const updated = await putRes.json();
    // Store in D1 for local recall
    await c.env.BOT_DB.prepare('INSERT OR REPLACE INTO projects (user_id, path, content, type) VALUES (?, ?, ?, ?)').bind(userId, data.body.path, base64Content, 'file').run();
    history.push({ role: 'assistant', content: `Edited ${data.body.path} with AI enhancement.` });
    await this.saveHistory(c, userId, botType, history);
    return c.json({ sha: updated.commit.sha, enhanced: enhancedContent.response });
  }
}

// Create Shared Notepad (#1 creative shared notes, infinite recall)
export class CreateNotepad extends BotRoute {
  schema = {
    tags: ['Notepad'],
    summary: 'Create shared notepad with AI suggestions (#1 creative shared notes, infinite recall)',
    request: { body: z.object({ notepad_id: z.string(), content: z.string(), user_id: z.string() }) },
    responses: { 200: { description: 'Notepad with AI suggestions' } },
  };

  async handle(c: Context<{ Bindings: Env }>) {
    const data = await this.getValidatedData<typeof this.schema>();
    const botType = 'editor';
    const history = await this.loadHistory(c, data.body.user_id, botType);
    const ai = new Ai(c.env.AI);
    const suggestions = await ai.run(MODELS.textGen, { messages: history.concat([{ role: 'user', content: `Suggest improvements for note: ${data.body.content}` }]) });
    const notepadContent = JSON.stringify({ content: data.body.content, ai_suggestions: [suggestions.response], shared_with: ['ai', 'user'] });
    // Store in D1
    await c.env.BOT_DB.prepare('INSERT OR REPLACE INTO notepads (notepad_id, user_id, content, ai_suggestions) VALUES (?, ?, ?, ?)').bind(data.body.notepad_id, data.body.user_id, notepadContent, JSON.stringify([suggestions.response])).run();
    // KV ephemeral for quick read
    await c.env.RS3_BOT_MEMORY_KV.put(`notepad:${data.body.notepad_id}`, notepadContent, { expirationTtl: 86400 });
    // Shared jsonbin.io infinite recall
    await updateSharedMemory(c.env, { [`notepad:${data.body.notepad_id}`]: notepadContent });
    history.push({ role: 'assistant', content: `Shared notepad created with suggestions.` });
    await this.saveHistory(c, data.body.user_id, botType, history);
    return c.json({ notepad_id: data.body.notepad_id, suggestions: suggestions.response });
  }
}

// HTML Terminal Sim (#1 code guidance, #3 overlay if Alt1)
export class Terminal extends BotRoute {
  schema = {
    tags: ['Terminal'],
    summary: 'HTML terminal sim via AI code execution output (#1 code guidance, #3 overlay if Alt1)',
    request: { body: z.object({ command: z.string(), user_id: z.string() }) },
    responses: { 200: { description: 'AI simulated output' } },
  };

  async handle(c: Context<{ Bindings: Env }>) {
    const data = await this.getValidatedData<typeof this.schema>();
    const botType = 'editor';
    const history = await this.loadHistory(c, data.body.user_id, botType);
    const ai = new Ai(c.env.AI);
    const output = await ai.run(MODELS.codeGen, { prompt: `Simulate terminal execution of: ${data.body.command}. Output as if run in JS/Node: stdout, stderr, exit code.` });
    history.push({ role: 'user', content: data.body.command });
    history.push({ role: 'assistant', content: output.response });
    await this.saveHistory(c, data.body.user_id, botType, history);
    return c.text(output.response); // Plain text for terminal display
  }
}

// Multi-Staged Input for Clarity (Step 1 Project Select, Step 2 Edit, Step 3 AI Enhance)
export class MultiStage extends BotRoute {
  schema = {
    tags: ['Input'],
    summary: 'Multi-staged input for clarity (step 1 project select, step 2 edit, step 3 AI enhance)',
    request: { query: z.object({ step: z.number().min(1).max(3), project: z.string().optional(), edit: z.string().optional(), user_id: z.string() }) },
    responses: { 200: { description: 'Step form HTML snippet' } },
  };

  async handle(c: Context<{ Bindings: Env }>) {
    const data = await this.getValidatedData<typeof this.schema>();
    let formHtml = '';
    switch (data.query.step) {
      case 1: formHtml = `<form><label>Project: <input name="project"></label><button onclick="fetch('/multi-stage?step=2&project='+this.form.project.value+'&user_id=${data.query.user_id}').then(r=>r.text()).then(html=>document.getElementById('stage').innerHTML=html)">Next</button></form>`; break;
      case 2: formHtml = `<form><label>Edit file ${data.query.project}: <textarea name="edit"></textarea></label><button onclick="fetch('/edit-file', {method:'POST', body:JSON.stringify({repo:'pick-of-gods/rs3-ai-bot-api', path:data.query.project+'/'+this.form.edit.name, content:this.form.edit.value, message:'Multi-stage edit'})}).then(r=>r.json()).then(res=>console.log(res))">Edit & Enhance</button></form>`; break;
      case 3: formHtml = `<div>AI enhanced! Check GitHub.</div>`; break;
    }
    return c.html(formHtml); // Snippet for frontend embed
  }
}

// Image Create/Edit (#3 media for code diagrams base64 store)
export class ImageCreate extends BotRoute {
  schema = {
    tags: ['Media'],
    summary: 'Create/edit image base64 store in D1/KV (#3 media for code diagrams)',
    request: { body: z.object({ prompt: z.string(), edit_mask: z.string().optional(), user_id: z.string(), path: z.string() }) },
    responses: { 200: { description: 'Base64 image' } },
  };

  async handle(c: Context<{ Bindings: Env }>) {
    const data = await this.getValidatedData<typeof this.schema>();
    const botType = 'editor';
    const ai = new Ai(c.env.AI);
    let image;
    if (data.body.edit_mask) {
      image = await ai.run(MODELS.imageEdit, { prompt: data.body.prompt, image: data.body.edit_mask }); // Inpaint edit
    } else {
      image = await ai.run(MODELS.imageGen, { prompt: data.body.prompt, num_steps: 50, guidance: 7.5 }); // Gen 1024x1024
    }
    const base64Image = image.image.toString('base64');
    // Store D1
    await c.env.BOT_DB.prepare('INSERT OR REPLACE INTO projects (user_id, path, content, type) VALUES (?, ?, ?, ?)').bind(data.body.user_id, data.body.path, base64Image, 'image').run();
    // KV ephemeral
    await c.env.RS3_BOT_MEMORY_KV.put(`image:${data.body.path}`, base64Image, { expirationTtl: 86400 });
    return c.json({ image: base64Image }); // For <img src="data:image/png;base64,...">
  }
}

// Start a Hono app
const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  if (err instanceof ApiException) {
    // If it's a Chanfana ApiException, let Chanfana handle the response
    return c.json(
      { success: false, errors: err.buildResponse() },
      err.status as ContentfulStatusCode,
    );
  }

  console.error("Global error handler caught:", err); // Log the error if it's not known

  // For other errors, return a generic 500 response
  return c.json(
    {
      success: false,
      errors: [{ code: 7000, message: "Internal Server Error" }],
    },
    500,
  );
});

// Setup OpenAPI registry
const openapi = fromHono(app, {
  docs_url: "/",
  schema: {
    info: {
      title: "My Awesome API",
      version: "2.0.0",
      description: "This is the documentation for my awesome API.",
    },
  },
});

// Register all routes
openapi.get('/source-script/:id', SourceScript);
openapi.get('/fetch-rs-data', FetchRsData);
openapi.get('/chat', Chat);
openapi.post('/discord-voice', DiscordVoice);
openapi.get('/tts', Tts);
openapi.post('/edit-file', EditFile);
openapi.post('/create-notepad', CreateNotepad);
openapi.post('/terminal', Terminal);
openapi.get('/multi-stage', MultiStage);
openapi.post('/image-create', ImageCreate);

// Export the Hono app
export default app;
