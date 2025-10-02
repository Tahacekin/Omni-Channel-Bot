// index.js (UPDATED with Webhook Verification and Correct Payload Parsing)
require('dotenv').config();
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto'); // Built-in Node.js module for cryptography
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');

// 1. Initialize App & AI
const app = express();
// IMPORTANT: We need the raw body for signature verification, so we use a custom parser.
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

// --- NEW: Webhook Signature Verification Middleware ---
function verifyConnexeaseSignature(req, res, next) {
    const signature = req.headers['x-connexease-webhook-sign'];
    if (!signature) {
        console.warn("Request received without signature.");
        return res.status(403).send('Signature missing.');
    }

    // According to docs, the signature is based on the channel's UUID.
    // NOTE: Raw body is needed because JSON parsing can change spacing.
    // However, the docs say to hash the channel_uuid, not the whole body. Let's follow that.
    const channelUuid = req.body.channel?.uuid;
    if (!channelUuid) {
         console.warn("Request body missing channel.uuid for signature check.");
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
    next(); // If the signature is valid, proceed to the main handler.
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

// --- UPDATED Webhook Endpoint ---
// The `verifyConnexeaseSignature` function will run first.
app.post('/webhook', verifyConnexeaseSignature, async (req, res) => {
    console.log("Webhook received:", JSON.stringify(req.body, null, 2));
    
    // Respond immediately with a 200 OK to acknowledge receipt.
    res.status(200).send('Event received');

    const hookType = req.body.hook;
    const payload = req.body.payload;

    // We only care about new messages created by a customer.
    if (hookType === 'message.created' && payload.customer && !payload.agent) {
        const userMessage = payload.content;
        const conversationId = payload.conversation_uuid;

        // Ensure the message has text content before processing.
        if (userMessage && userMessage.trim() !== "") {
            console.log(`Processing message from customer: "${userMessage}"`);
            const aiReply = await getAIResponse(userMessage);
            await sendConnexeaseReply(conversationId, aiReply);
        } else {
            console.log("Received message without text content (e.g., media), skipping AI reply.");
        }
    } else if (hookType === 'conversation.created' && payload.messages?.content) {
        // Also handle the first message in a conversation.
        const userMessage = payload.messages.content;
        const conversationId = payload.uuid; // For this hook, the conversation ID is payload.uuid

        if (userMessage && userMessage.trim() !== "") {
             console.log(`Processing first message in new conversation: "${userMessage}"`);
             const aiReply = await getAIResponse(userMessage);
             await sendConnexeaseReply(conversationId, aiReply);
        } else {
             console.log("Received new conversation without text content, skipping AI reply.");
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
