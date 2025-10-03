// index.js (UPDATED with correct IP parsing)
require('dotenv').config();
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');

// 1. Initialize App & AI
const app = express();
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-latest" });
let knowledgeBase = '';

// --- JWT Authentication section (no changes here) ---
let connexeaseToken = null;
let tokenExpiresAt = null;

async function getConnexeaseToken() {
    if (connexeaseToken && tokenExpiresAt && new Date() < tokenExpiresAt) {
        return connexeaseToken;
    }
    console.log("Fetching new Connexease token...");
    try {
        const response = await axios.post(`${process.env.CONNEXEASE_API_URL}/jwt/`, {
            username: process.env.CONNEXEASE_USERNAME,
            password: process.env.CONNEXEASE_PASSWORD
        });
        connexeaseToken = response.data.token;
        tokenExpiresAt = new Date(new Date().getTime() + 23.5 * 60 * 60 * 1000);
        console.log("Successfully fetched new token.");
        return connexeaseToken;
    } catch (error) {
        console.error("FATAL: Could not get Connexease JWT.", error.response?.data);
        return null;
    }
}

// --- UPDATED: IP Allowlist Middleware ---
// This function now correctly handles a list of IPs.
function ipAllowlist(req, res, next) {
    const allowedIp = '34.89.215.92';
    const clientIpString = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    console.log(`Incoming request from IP chain: ${clientIpString}`);

    // Split the string by commas and get the first IP in the list.
    const firstIp = clientIpString.split(',')[0].trim();

    if (firstIp === allowedIp) {
        // The first IP matches, so we allow the request.
        console.log(`Allowing request as first IP '${firstIp}' matches.`);
        next();
    } else {
        // The first IP does not match, block the request.
        console.warn(`Blocked request from unauthorized IP: ${firstIp}`);
        res.status(403).send('Forbidden: IP address not allowed.');
    }
}


// --- Webhook Signature Verification Middleware (no changes here) ---
function verifyConnexeaseSignature(req, res, next) {
    const signature = req.headers['x-connexease-webhook-sign'];
    if (!signature) {
        return res.status(403).send('Signature missing.');
    }
    const channelUuid = req.body.channel?.uuid;
    if (!channelUuid) {
        return res.status(400).send('Invalid payload for signature check.');
    }
    const secret = process.env.CONNEXEASE_WEBHOOK_SECRET;
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(channelUuid, 'utf-8');
    const expectedSignature = hmac.digest('base64');
    if (signature !== expectedSignature) {
        console.error("Webhook signature verification FAILED!");
        return res.status(403).send('Invalid signature.');
    }
    console.log("Webhook signature verified successfully.");
    next();
}


// --- AI and Connexease Reply Functions (no changes here) ---
async function getAIResponse(userMessage) {
    if (!knowledgeBase) {
        knowledgeBase = await fs.readFile(path.join(__dirname, 'knowledgebase.txt'), 'utf-8');
    }
    const fullPrompt = `You are a helpful customer service assistant for a network of clinics called Climed. You must answer user questions based ONLY on the information provided in the following knowledge base. Do not make up any information. If the answer is not in the knowledge base, politely state that you do not have that information and a human agent will assist them shortly. Your answers must be in TURKISH. --- KNOWLEDGE BASE START --- ${knowledgeBase} --- KNOWLEDGE BASE END --- User Question: "${userMessage}"`;
    try {
        const result = await model.generateContent(fullPrompt);
        return result.response.text();
    } catch (error) {
        console.error("Error getting AI response:", error);
        return "Üzgünüm, talebinizi işlerken bir sorun oluştu. En kısa sürede bir temsilcimiz size yardımcı olacaktır.";
    }
}

async function sendConnexeaseReply(conversationId, messageText) {
    const token = await getConnexeaseToken();
    if (!token) return;
    const url = `${process.env.CONNEXEASE_API_URL}/api/v1/conversations/${conversationId}/messages`;
    const payload = { message: { content: messageText, private: false } };
    const headers = { 'Content-Type': 'application/json', 'api_access_token': token };
    try {
        await axios.post(url, payload, { headers });
        console.log(`Successfully sent reply to conversation ${conversationId}`);
    } catch (error) {
        console.error("Error sending Connexease reply:", error.response?.data);
    }
}

// --- Webhook Endpoint (no changes here) ---
app.post('/webhook', ipAllowlist, verifyConnexeaseSignature, async (req, res) => {
    console.log("Webhook received and passed security checks:", JSON.stringify(req.body, null, 2));
    res.status(200).send('Event received');

    const hookType = req.body.hook;
    const payload = req.body.payload;
    if (hookType === 'message.created' && payload.customer && !payload.agent) {
        const userMessage = payload.content;
        const conversationId = payload.conversation_uuid;
        if (userMessage && userMessage.trim() !== "") {
            console.log(`Processing message from customer: "${userMessage}"`);
            const aiReply = await getAIResponse(userMessage);
            await sendConnexeaseReply(conversationId, aiReply);
        } else {
            console.log("Received message without text content, skipping.");
        }
    } else if (hookType === 'conversation.created' && payload.messages?.content) {
        const userMessage = payload.messages.content;
        const conversationId = payload.uuid;
        if (userMessage && userMessage.trim() !== "") {
            console.log(`Processing first message in new conversation: "${userMessage}"`);
            const aiReply = await getAIResponse(userMessage);
            await sendConnexeaseReply(conversationId, aiReply);
        } else {
            console.log("Received new<｜tool▁sep｜>conversation without text content, skipping.");
        }
    }
});


// --- Start Server (no changes here) ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    try {
        knowledgeBase = await fs.readFile(path.join(__dirname, 'knowledgebase.txt'), 'utf-8');
        console.log('Knowledge base loaded into memory.');
    } catch (error) {
        console.error('Failed to load knowledge base on startup:', error);
    }
    console.log(`Server is running on port ${PORT}`);
});