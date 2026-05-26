// Drop-in replacement for the analyze-cv route in career-suite.js
// Fixes: empty response swallowed silently, no timeout, no token logging

router.post('/analyze-cv', requireAuth, async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    console.log(`[career] analyze-cv — user ${req.user.id} — ${messages.length} messages`);

    const groqRes = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model:       'llama-3.3-70b-versatile',
        max_tokens:  4096,   // reduced from default — leaves room for full JSON
        temperature: 0.3,    // lower = more consistent JSON structure
        messages,
        response_format: { type: 'json_object' }, // force JSON mode
      },
      {
        headers: {
          Authorization:  `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 90000, // 90s timeout for large CVs
      }
    );

    const content = groqRes.data?.choices?.[0]?.message?.content;

    if (!content || !content.trim()) {
      console.error('[career] analyze-cv — empty content from Groq');
      return res.status(500).json({ error: 'Empty response from AI — please retry' });
    }

    // Log token usage for monitoring
    const usage = groqRes.data?.usage;
    if (usage) {
      console.log(`[career] tokens — prompt: ${usage.prompt_tokens}, completion: ${usage.completion_tokens}, total: ${usage.total_tokens}`);
      // Warn if near limits
      if (usage.total_tokens > 7000) {
        console.warn(`[career] ⚠️ High token usage: ${usage.total_tokens} — consider trimming CV`);
      }
    }

    // Return in the format groq.ts expects (choices array)
    res.json(groqRes.data);

  } catch (err) {
    const status = err?.response?.status;
    const errData = err?.response?.data;

    console.error(`[career] analyze-cv error — status: ${status}`, errData || err.message);

    if (status === 429) {
      return res.status(429).json({ error: 'Rate limit reached — please wait 30 seconds and retry' });
    }
    if (status === 413 || err?.message?.includes('context')) {
      return res.status(413).json({ error: 'CV is too long for analysis — please shorten it and retry' });
    }

    res.status(500).json({
      error: errData?.error?.message || err.message || 'Analysis failed — please retry',
    });
  }
});
