const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const NIM_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_KEY = process.env.NIM_API_KEY;

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [{ id: 'claude-3-sonnet', object: 'model', created: Date.now(), owned_by: 'nim-proxy' }]
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { messages, temperature, max_tokens } = req.body;

    const nimRes = await axios.post(`${NIM_BASE}/chat/completions`, {
      model: 'z-ai/glm5',
      messages,
      temperature: temperature ?? 0.85,
      max_tokens: max_tokens ?? 9024,
      extra_body: {
        chat_template_kwargs: {
          enable_thinking: true,
          clear_thinking: false
        }
      },
      stream: true
    }, {
      headers: { 'Authorization': `Bearer ${NIM_KEY}`, 'Content-Type': 'application/json' },
      responseType: 'stream'
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let buffer = '';
    let inThink = false;

    nimRes.data.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        if (line.includes('[DONE]')) { res.write('data: [DONE]\n\n'); return; }

        try {
          const data = JSON.parse(line.slice(6));
          const delta = data.choices?.[0]?.delta;

          if (delta) {
            let r = (delta.reasoning_content || '').replace(/\\n/g, '\n');
            let c = (delta.content || '').replace(/\\n/g, '\n');
            let out = '';

            if (r && !inThink) { out = '<think>\n' + r; inThink = true; }
            else if (r) { out = r; }

            if (c && inThink) { out += '</think>\n\n' + c; inThink = false; }
            else if (c) { out += c; }

            delta.content = out;
            delete delta.reasoning_content;
          }

          res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (e) {}
      }
    });

    nimRes.data.on('end', () => res.end());
    nimRes.data.on('error', () => res.end());
  } catch (err) {
    console.error('Error:', err.message);
    res.status(err.response?.status || 500).json({ error: { message: err.message } });
  }
});

app.listen(PORT, () => console.log(`NIM Proxy on port ${PORT}`));
