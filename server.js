const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// ── Clean history before sending to API ─────────────────
function prepareMessages(messages) {
  return messages.map(msg => {
    let content = typeof msg.content === 'string' ? msg.content : '';
    content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
    return { role: msg.role, content: content || '(continue)' };
  });
}

// ── Force linebreaks into model output ──────────────────
function enforceLineBreaks(text) {
  text = text.replace(/\r\n/g, '\n');

  // CASE 1: Complete wall of text — no double newlines at all
  if (text.length > 200 && !text.includes('\n\n')) {
    text = text.replace(/([.!?])\s+(")/g, '$1\n\n$2');
    text = text.replace(/([.!?""''"])\s+(\*)/g, '$1\n\n$2');
    text = text.replace(/(\*)\s+([A-Z"""])/g, '$1\n\n$2');
    text = text.replace(/(["""'])\s+([A-Z])/g, '$1\n\n$2');

    if (text.length > 400 && !text.includes('\n\n')) {
      let count = 0;
      text = text.replace(/([.!?])\s+([A-Z])/g, (match, p1, p2) => {
        count++;
        return count % 3 === 0 ? p1 + '\n\n' + p2 : match;
      });
    }
  }

  // CASE 2: Has single newlines that should be doubles
  text = text.replace(/([^\n])\n(")/g, '$1\n\n$2');
  text = text.replace(/([^\n])\n(\*)/g, '$1\n\n$2');
  text = text.replace(/(["""'])\n([A-Z*])/g, '$1\n\n$2');

  // Scene breaks and stage directions
  text = text.replace(/([.!?""'*])\s+([-—]{2,})/g, '$1\n\n$2');
  text = text.replace(/([.!?""'*])\s+(\[)/g, '$1\n\n$2');
  text = text.replace(/(\])\s+([A-Z"*])/g, '$1\n\n$2');

  // Collapse 3+ newlines down to 2
  text = text.replace(/\n{3,}/g, '\n\n');

  return text;
}

// ── Routes ──────────────────────────────────────────────

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [{
      id: 'claude-3-sonnet',
      object: 'model',
      created: Date.now(),
      owned_by: 'nvidia-nim-proxy'
    }]
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens } = req.body;
    const preparedMessages = prepareMessages(messages);

    console.log('\n── Turn ──');
    console.log(`  Messages in history: ${messages.length}`);
    messages.slice(-2).forEach(m => {
      const preview = (m.content || '').substring(0, 200).replace(/\n/g, '\\n');
      console.log(`  [${m.role}] ${preview}`);
    });

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, {
      model: 'z-ai/glm5',
      messages: preparedMessages,
      temperature: temperature || 0.85,
      max_tokens: max_tokens || 9024,
      stream: false,
      chat_template_kwargs: {
        enable_thinking: true,
        clear_thinking: false
      }
    }, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || 'claude-3-sonnet',
      choices: response.data.choices.map(choice => {
        let content = choice.message?.content || '';

        let thinkBlock = '';
        let body = content;

        const thinkMatch = content.match(/^\s*(<think>[\s\S]*?<\/think>)\s*([\s\S]*)$/);
        if (thinkMatch) {
          thinkBlock = thinkMatch[1];
          body = thinkMatch[2];
        }

        if (!thinkBlock && choice.message?.reasoning_content) {
          thinkBlock = '<think>\n' + choice.message.reasoning_content + '\n</think>';
        }

        body = enforceLineBreaks(body);

        const finalContent = thinkBlock
          ? thinkBlock + '\n\n' + body
          : body;

        console.log(`  [output] len=${body.length} paragraphs=${(body.match(/\n\n/g) || []).length + 1} think=${!!thinkBlock}`);

        return {
          index: choice.index,
          message: { role: choice.message.role, content: finalContent },
          finish_reason: choice.finish_reason
        };
      }),
      usage: response.data.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    });

  } catch (error) {
    console.error('Proxy error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
