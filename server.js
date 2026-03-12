// ── Add at the top, after const declarations ────────────

// Axios instance with extended timeout (5 minutes)
const apiClient = axios.create({
  timeout: 300000,    // 5 minutes in ms
  headers: {
    'Authorization': `Bearer ${NIM_API_KEY}`,
    'Content-Type': 'application/json'
  }
});

// ── Replace the route handler ───────────────────────────

app.post('/v1/chat/completions', async (req, res) => {
  // Prevent Railway/hosting from killing the connection
  req.setTimeout(300000);
  res.setTimeout(300000);

  try {
    const { model, messages, temperature, max_tokens } = req.body;
    const preparedMessages = prepareMessages(messages);

    console.log('\n── Turn ──');
    console.log(`  Messages in history: ${messages.length}`);
    console.log(`  Sending to NIM API...`);
    const startTime = Date.now();

    // ── Retry logic: 3 attempts ──
    let response;
    let lastError;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        response = await apiClient.post(`${NIM_API_BASE}/chat/completions`, {
          model: 'z-ai/glm5',
          messages: preparedMessages,
          temperature: temperature || 0.85,
          max_tokens: max_tokens || 9024,
          stream: false,
          chat_template_kwargs: {
            enable_thinking: true,
            clear_thinking: false
          }
        });
        console.log(`  Response received in ${((Date.now() - startTime) / 1000).toFixed(1)}s (attempt ${attempt})`);
        break;   // success — exit loop
      } catch (err) {
        lastError = err;
        const code = err.code || err.response?.status || 'unknown';
        console.log(`  Attempt ${attempt} failed: ${code} — ${err.message}`);

        if (attempt < 3) {
          // Wait before retry: 5s, then 10s
          const delay = attempt * 5000;
          console.log(`  Retrying in ${delay / 1000}s...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    if (!response) {
      throw lastError;
    }

    // ── rest of response processing stays exactly the same ──
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
    const elapsed = ((Date.now() - (error._startTime || Date.now())) / 1000).toFixed(1);
    console.error(`  FAILED after all retries — ${error.code || error.response?.status || 'unknown'}: ${error.message}`);
    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }
});
