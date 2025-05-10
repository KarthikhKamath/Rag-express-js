require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors')

const app = express();
const port = 3000;

app.use(cors({
  origin: 'https://kart-rag-chat-bot.netlify.app',
  methods: ['GET', 'POST', 'DELETE'],
  credentials: true
}));


const redisClient = createClient({
    url: process.env.UPSTASH_REDIS_URL
});


redisClient.connect().catch(console.error);

app.use(bodyParser.json());

app.post('/query', async (req, res) => {
    const { session_id, query, n_results } = req.body;

    if (!session_id || !query) {
        return res.status(400).json({ error: "Both session_id and query are required" });
    }

    try {
        // 1. Query your Flask vector API
        const flaskRes = await axios.post(`${process.env.FLASK_API_URL}/query`, {
            query,
            n_results
        });

        const results = flaskRes.data?.results;
        if (!results || results.length === 0) {
            return res.status(404).json({ message: "No relevant results found." });
        }

        const passages = results.slice(0, n_results).map(r => r.text).join('\n\n');

        const prompt = `You are a news assistant trained to give direct answers to questions using the following context. Answer the query without redirecting the user, dont mention authors, dont add any promotional content. Your response should be concise but informative, answering the user's question as directly as possible. Ensure the response is clear, relevant, and at least 3 lines long on a mobile screen. You can use the provided passages below as context if context doesnt answer the user query use your own knowledge.

        Context:
        ${passages}
        
        Question: ${query}`;
        
        // 2. Call Gemini API
        const geminiRes = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
            {
                contents: [
                    {
                        parts: [
                            { text: prompt }
                        ]
                    }
                ]
            },
            {
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        const geminiAnswer = geminiRes.data.candidates?.[0]?.content?.parts?.[0]?.text || "No answer generated.";

        // 3. Save query + answer to Redis history
        const sessionKey = `session:${session_id}`;
        const prevHistory = await redisClient.get(sessionKey);
        const updatedHistory = prevHistory ? JSON.parse(prevHistory) : [];

        updatedHistory.push(
            { role: 'user', text: query },
            { role: 'bot', text: geminiAnswer }
        );

        await redisClient.set(sessionKey, JSON.stringify(updatedHistory)); 

        // 4. Return response
        res.json({
            query,
            answer: geminiAnswer,
            source: results[0]?.metadata.url || []
        });

    } catch (error) {
        console.error('Error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to query or generate answer', error });
    }
});


app.post('/session', async (req, res) => {
    try {
        const sessionId = uuidv4();

        await redisClient.set(`session:${sessionId}`, JSON.stringify([]));

        res.json({ session_id: sessionId });
    } catch (error) {
        console.error('Error creating session:', error);
        res.status(500).json({ error: 'Failed to create session' });
    }
});

app.get('/history', async (req, res) => {
    const { session_id } = req.query;

    if (!session_id) {
        return res.status(400).json({ error: "session_id is required" });
    }

    try {
        const sessionKey = `session:${session_id}`;
        const history = await redisClient.get(sessionKey);

        if (!history) {
            return res.status(404).json({ message: "No chat history found for this session." });
        }

        res.json({ session_id, history: JSON.parse(history) });
    } catch (error) {
        console.error('Error fetching chat history:', error);
        res.status(500).json({ error: 'Failed to retrieve chat history' });
    }
});

app.delete('/session', async (req, res) => {
    const { session_id } = req.body;

    if (!session_id) {
        return res.status(400).json({ error: "session_id is required" });
    }

    try {
        const sessionKey = `session:${session_id}`;
        const deleted = await redisClient.del(sessionKey);

        if (deleted === 0) {
            return res.status(404).json({ message: "Session not found or already cleared." });
        }

        res.json({ message: "Session cleared successfully." });
    } catch (error) {
        console.error('Error clearing session:', error);
        res.status(500).json({ error: 'Failed to clear session' });
    }
});





app.listen(port, () => {
    console.log(`Express+Gemini API running on http://localhost:${port}`);
});
